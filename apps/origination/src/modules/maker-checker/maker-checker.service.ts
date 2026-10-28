import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ApproveChangeRequest, POLICY_ACTION_UPDATE, POLICY_TARGET_TYPE, RejectChangeRequest, SubmitChangeRequest,
  type ChangeRequestDto, type ChangeRequestHistoryDto, type ChangeRequestPage, type ChangeRequestSummary,
  type ListChangeRequestsQuery, type MakerCheckerPolicyDto, type SubmitChangeResult,
} from '@los/contracts';
import { buildEvent } from '@los/database';
import { Clock } from '@los/nest-common';
import type { Actor } from './actor';
import { ChangeConflictError, ChangeHandlerRegistry, ChangeValidationError, type ChangeHandler } from './change-handler';
import {
  CHANGE_REQUEST_STORE, LockTimeoutError, PendingConflictError,
  type ChangeRequestRow, type ChangeRequestStore, type ChangeRequestTx, type HistoryRow,
} from './change-request.store';
import {
  canCancelNow, canDecideNow, canView, decideDenial, effectivePolicy, expiryFrom, isOverdue,
} from './maker-checker.domain';
import { err } from './maker-checker.errors';

type Outcome = 'APPLIED' | 'APPLIED_DIRECT' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
const SYSTEM = 'system';

/**
 * 4 нүдний зарчмын цөм. Домэйн модулиуд ChangeHandler бүртгээд `submit()` дууддаг; HTTP давхарга нь энэ классыг л дуудна.
 * Дүрмүүд: docs/05-maker-checker.md (MC-BR-1…10). Бүх төлөв өөрчлөлт = нэг tx: мөр + түүх + outbox (+ apply).
 */
@Injectable()
export class MakerCheckerService {
  constructor(
    @Inject(CHANGE_REQUEST_STORE) private readonly store: ChangeRequestStore,
    @Inject(ChangeHandlerRegistry) private readonly registry: ChangeHandlerRegistry,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  // ── Илгээх (maker) ─────────────────────────────────────────────────────────────
  /** MC-FR-1: policy идэвхтэй бол PENDING хүсэлт үүсгэнэ (өгөгдөл хөдлөхгүй); идэвхгүй бол шууд хэрэгжүүлээд аудитлана (DIRECT). */
  async submit(actor: Actor, rawInput: SubmitChangeRequest): Promise<SubmitChangeResult> {
    // Plug-in API-г HTTP-гүйгээр дуудсан ч гэрээ хүчинтэй (MC-BR-4: шалтгаан заавал, NUL/хэт урт утга үгүй)
    const checked = SubmitChangeRequest.safeParse(rawInput);
    if (!checked.success) throw err('VALIDATION_FAILED', checked.error.issues);
    const input = checked.data;

    const handler = this.registry.get(input.targetType, input.action);
    if (!handler) throw err('HANDLER_NOT_FOUND', { supported: this.registry.list().map((h) => `${h.targetType}:${h.action}`) });
    if (!handler.makerRoles.some((r) => actor.roles.includes(r))) throw err('MAKER_ROLE_FORBIDDEN', { required: handler.makerRoles });

    const parsed = handler.payloadSchema.safeParse(input.payload);
    if (!parsed.success) throw err('PAYLOAD_INVALID', parsed.error.issues);
    const canonical = handler.canonicalTargetId?.(parsed.data);
    if (canonical !== undefined && canonical !== input.targetId) throw err('TARGET_ID_MISMATCH', { expected: canonical });

    const policy = effectivePolicy(handler, await this.store.getPolicy(actor.orgId, handler.targetType, handler.action));
    const direct = !policy.enabled;

    let done: { row: ChangeRequestRow; now: Date };
    try {
      done = await this.store.transaction(async (tx) => {
        // MC-BR-5: зорилт тус бүрийн илгээлт цуваа. Цаг, snapshot зэргийг түгжээ авсны ДАРАА уншина (зэрэг хэрэгжиж буй батлалтын дүнг үзэхийн тулд).
        const pending = await tx.lockTarget(actor.orgId, handler.targetType, input.targetId);
        const now = this.clock.now();
        if (pending) {
          // Хугацаа нь дууссан боловч sweeper хараахан хаагаагүй хүсэлт шинэ илгээлтийг хаах ёсгүй (MC-BR-6)
          if (!isOverdue(pending, now)) throw new PendingConflictError(); // DIRECT-ийг ч хориглоно: хүлээгдэж буй өөрчлөлтийг хэнд ч мэдэгдэлгүй давахгүй
          await this.close(tx, pending, 'EXPIRED', { status: 'EXPIRED', decidedAt: now, updatedBy: SYSTEM }, null, null, now);
        }
        await this.runValidate(handler, parsed.data, actor, tx);
        const snap = handler.snapshot ? await handler.snapshot({ db: tx.db, repo: tx, orgId: actor.orgId, targetId: input.targetId }) : null;
        const inserted = await tx.insert({
          id: randomUUID(), orgId: actor.orgId, branchId: actor.branchId,
          targetType: handler.targetType, targetId: input.targetId, action: handler.action,
          applicationId: input.applicationId ?? null,
          mode: direct ? 'DIRECT' : 'FOUR_EYES', status: direct ? 'APPLIED' : 'PENDING',
          payload: parsed.data, before: snap?.before ?? null, baseVersion: input.baseVersion ?? snap?.baseVersion ?? null,
          reason: input.reason, makerId: actor.userId, makerRoles: actor.roles,
          requiredCheckerRoles: direct ? [] : policy.checkerRoles,
          correlationId: actor.correlationId,
          expiresAt: direct ? now : expiryFrom(now, policy.expiresInHours),
          decidedAt: direct ? now : null, createdAt: now,
        }, actor.userId);
        if (direct) {
          await handler.apply({ db: tx.db, repo: tx, request: inserted, payload: parsed.data, checker: null });
          await this.record(tx, inserted, 'DIRECT_APPLIED', null, actor, null, now);
          await tx.enqueue(this.decidedEvent(inserted, 'APPLIED_DIRECT', actor, null, now));
        } else {
          await this.record(tx, inserted, 'SUBMITTED', null, actor, input.reason, now);
          await tx.enqueue(buildEvent(this.eventCtx(inserted, actor), 'ChangeRequestSubmitted', {
            ...this.ref(inserted), requiredCheckerRoles: inserted.requiredCheckerRoles, branchId: inserted.branchId, expiresAt: inserted.expiresAt.toISOString(),
          }, now));
        }
        return { row: inserted, now };
      });
    } catch (e) {
      throw this.translate(e);
    }
    return { outcome: direct ? 'APPLIED_DIRECT' : 'PENDING', request: this.toDto(done.row, actor, done.now, await this.store.getHistory(done.row.id)) };
  }

  // ── Шийдэх (checker) ───────────────────────────────────────────────────────────
  /** MC-FR-3: Батлахад өөрчлөлт нэг tx-д хэрэгжинэ. */
  approve(actor: Actor, id: string, comment?: string): Promise<ChangeRequestDto> { return this.decide(actor, id, 'APPROVE', comment); }
  /** MC-FR-3: Татгалзахад тайлбар заавал (MC-BR-4). */
  reject(actor: Actor, id: string, comment: string): Promise<ChangeRequestDto> { return this.decide(actor, id, 'REJECT', comment); }

  private async decide(actor: Actor, id: string, kind: 'APPROVE' | 'REJECT', comment?: string): Promise<ChangeRequestDto> {
    // Тайлбар: батлахад сонголттой, татгалзахад заавал (MC-BR-4); HTTP-гүй дуудлагад ч адил шалгана
    const checked = (kind === 'REJECT' ? RejectChangeRequest : ApproveChangeRequest).safeParse({ comment });
    if (!checked.success) throw err('VALIDATION_FAILED', checked.error.issues);
    const note = checked.data.comment || null;
    let result: { row: ChangeRequestRow; expired: boolean; now: Date };
    try {
      result = await this.store.transaction(async (tx) => {
        const row = await tx.lock(actor.orgId, id);
        const now = this.clock.now(); // түгжээ авсны дараа: хүлээсэн хугацаанд хүсэлт дууссан байж болно
        if (!row || !canView(actor, row)) throw err('NOT_FOUND');
        const denial = decideDenial(actor, row);
        if (denial) throw err(denial);
        if (row.status === 'EXPIRED') throw err('EXPIRED', { expiresAt: row.expiresAt.toISOString() }); // sweeper өмнө нь хаасан ч MC-BR-6-ын код
        if (row.status !== 'PENDING') throw err('ALREADY_DECIDED', { status: row.status });
        if (isOverdue(row, now)) return { row: await this.close(tx, row, 'EXPIRED', { status: 'EXPIRED', decidedAt: now, updatedBy: SYSTEM }, null, null, now), expired: true, now };

        if (kind === 'REJECT') {
          return { row: await this.close(tx, row, 'REJECTED', { status: 'REJECTED', checkerId: actor.userId, checkerRoles: actor.roles, checkerComment: note, decidedAt: now, updatedBy: actor.userId }, actor, note, now), expired: false, now };
        }
        const handler = this.registry.get(row.targetType, row.action);
        if (!handler) throw err('HANDLER_NOT_FOUND', { targetType: row.targetType, action: row.action });
        const payload = handler.payloadSchema.safeParse(row.payload);
        if (!payload.success) throw new ChangeConflictError(`payload no longer valid: ${payload.error.issues.map((i) => i.message).join('; ')}`);
        await handler.apply({ db: tx.db, repo: tx, request: row, payload: payload.data, checker: actor });
        return { row: await this.close(tx, row, 'APPLIED', { status: 'APPLIED', checkerId: actor.userId, checkerRoles: actor.roles, checkerComment: note, decidedAt: now, updatedBy: actor.userId }, actor, note, now), expired: false, now };
      });
    } catch (e) {
      if (e instanceof ChangeConflictError) throw await this.failStale(actor, id, e.message);
      throw this.translate(e);
    }
    if (result.expired) throw err('EXPIRED', { expiresAt: result.row.expiresAt.toISOString() });
    return this.toDto(result.row, actor, result.now, await this.store.getHistory(id));
  }

  /** apply() хуучирсан өгөгдөл илрүүлбэл: tx буцаагдсан тул хүсэлтийг тусад нь FAILED болгоно (MC-BR-7). */
  private async failStale(actor: Actor, id: string, reason: string): Promise<unknown> {
    try {
      await this.store.transaction(async (tx) => {
        const row = await tx.lock(actor.orgId, id);
        const now = this.clock.now();
        if (row && row.status === 'PENDING') {
          await this.close(tx, row, 'FAILED', { status: 'FAILED', checkerId: actor.userId, checkerRoles: actor.roles, failureReason: reason, decidedAt: now, updatedBy: actor.userId }, actor, null, now, { reason });
        }
      });
    } catch (e) {
      return this.translate(e);
    }
    return err('STALE_TARGET', { reason });
  }

  // ── Цуцлах (maker) ─────────────────────────────────────────────────────────────
  async cancel(actor: Actor, id: string, comment?: string): Promise<ChangeRequestDto> {
    const checked = ApproveChangeRequest.safeParse({ comment }); // cancel-ийн тайлбар нь сонголттой, ижил хязгаартай
    if (!checked.success) throw err('VALIDATION_FAILED', checked.error.issues);
    const note = checked.data.comment || null;
    let done: { row: ChangeRequestRow; now: Date };
    try {
      done = await this.store.transaction(async (tx) => {
        const locked = await tx.lock(actor.orgId, id);
        const now = this.clock.now();
        if (!locked || !canView(actor, locked)) throw err('NOT_FOUND');
        if (actor.userId !== locked.makerId) throw err('ONLY_MAKER_CAN_CANCEL');
        if (locked.status !== 'PENDING') throw err('ALREADY_DECIDED', { status: locked.status });
        return { row: await this.close(tx, locked, 'CANCELLED', { status: 'CANCELLED', decidedAt: now, updatedBy: actor.userId }, actor, note, now), now };
      });
    } catch (e) {
      throw this.translate(e);
    }
    return this.toDto(done.row, actor, done.now, await this.store.getHistory(id));
  }

  // ── Хугацаа дуусах (MC-BR-6) ───────────────────────────────────────────────────
  /** Хугацаа нь дууссан PENDING хүсэлтүүдийг EXPIRED болгоно; хэдэн мөр хаасныг буцаана. `orgId` өгвөл зөвхөн тухайн байгууллагынх (sweeper бүгдийг). */
  async expireOverdue(limit = 100, opts: { orgId?: string } = {}): Promise<number> {
    return this.store.transaction(async (tx) => {
      const now = this.clock.now();
      const rows = await tx.lockOverdue(now, limit, opts.orgId);
      for (const row of rows) await this.close(tx, row, 'EXPIRED', { status: 'EXPIRED', decidedAt: now, updatedBy: SYSTEM }, null, null, now);
      return rows.length;
    });
  }

  // ── Унших ──────────────────────────────────────────────────────────────────────
  async get(actor: Actor, id: string): Promise<ChangeRequestDto> {
    const row = await this.store.getById(actor.orgId, id);
    if (!row || !canView(actor, row)) throw err('NOT_FOUND');
    return this.toDto(row, actor, this.clock.now(), await this.store.getHistory(id));
  }

  async list(actor: Actor, query: ListChangeRequestsQuery): Promise<ChangeRequestPage> {
    if (query.scope === 'all' && !actor.roles.includes('ADMIN')) throw err('FORBIDDEN');
    const now = this.clock.now();
    const { rows, total } = await this.store.list(actor.orgId, { ...query, actor, now });
    return { items: rows.map((r) => this.toDto(r, actor, now)), total, page: query.page, pageSize: query.pageSize };
  }

  /** "Миний батлах" тоолуур: батлах хүлээлттэй + миний илгээсэн хүлээгдэж буй */
  async summary(actor: Actor): Promise<ChangeRequestSummary> {
    const now = this.clock.now();
    const [inbox, mine] = await Promise.all([
      this.store.count(actor.orgId, { scope: 'inbox', actor, now }),
      this.store.count(actor.orgId, { scope: 'mine', actor, now }),
    ]);
    return { inbox, mine };
  }

  /** MC-FR-9: handler бүрийн хүчинтэй policy (admin-ы тохиргоо эсвэл анхдагч) */
  async listPolicies(actor: Actor): Promise<MakerCheckerPolicyDto[]> {
    if (!actor.roles.some((r) => r === 'ADMIN' || r === 'APPROVER')) throw err('FORBIDDEN');
    const rows = new Map((await this.store.listPolicies(actor.orgId)).map((p) => [`${p.targetType}:${p.action}`, p]));
    return this.registry.list().map((h) => {
      const row = rows.get(ChangeHandlerRegistryKey(h)) ?? null;
      const p = effectivePolicy(h, row);
      return {
        targetType: h.targetType, action: h.action, enabled: p.enabled, checkerRoles: p.checkerRoles, expiresInHours: p.expiresInHours,
        configured: p.configured, locked: p.locked, makerRoles: [...h.makerRoles],
        updatedAt: row?.updatedAt.toISOString() ?? null, updatedBy: row?.updatedBy ?? null,
      };
    }).sort((a, b) => `${a.targetType}:${a.action}`.localeCompare(`${b.targetType}:${b.action}`));
  }

  /** MC-BR-8: policy өөрчлөх нь өөрөө заавал 4 нүдтэй change request */
  submitPolicyChange(actor: Actor, policy: { targetType: string; action: string; enabled: boolean; checkerRoles: string[]; expiresInHours: number }, reason: string) {
    return this.submit(actor, {
      targetType: POLICY_TARGET_TYPE, action: POLICY_ACTION_UPDATE, targetId: `${policy.targetType}:${policy.action}`, payload: policy, reason,
    });
  }

  // ── Дотоод ─────────────────────────────────────────────────────────────────────
  private async runValidate<P>(handler: ChangeHandler<P>, payload: P, actor: Actor, tx: ChangeRequestTx) {
    try {
      await handler.validate?.({ payload, actor, repo: tx });
    } catch (e) {
      // Зөвхөн handler-ийн зориудаар шиднэ гэсэн алдааг 422 болгоно; DB/сүлжээ/програмын алдаа түүхий мессежээр хэрэглэгчид гарахгүй
      if (e instanceof ChangeValidationError) throw err('PAYLOAD_INVALID', e.details, e.message);
      throw e;
    }
  }

  /** PENDING → терминал: мөр + түүх + event. */
  private async close(
    tx: ChangeRequestTx, row: ChangeRequestRow, outcome: Exclude<Outcome, 'APPLIED_DIRECT'>,
    patch: Parameters<ChangeRequestTx['update']>[1], actor: Actor | null, comment: string | null, now: Date, data?: unknown,
  ): Promise<ChangeRequestRow> {
    const updated = await tx.update(row.id, patch);
    await this.record(tx, updated, outcome === 'APPLIED' ? 'APPLIED' : outcome, row.status, actor, comment, now, data);
    await tx.enqueue(this.decidedEvent(updated, outcome, actor, updated.checkerId, now));
    return updated;
  }

  private async record(
    tx: ChangeRequestTx, row: ChangeRequestRow, event: HistoryRow['event'], from: ChangeRequestRow['status'] | null,
    actor: Actor | null, comment: string | null, now: Date, data?: unknown,
  ) {
    await tx.appendHistory(row.id, { event, fromStatus: from, toStatus: row.status, actorId: actor?.userId ?? null, actorRoles: actor?.roles ?? [], comment, data, at: now });
    // NFR-4: нэгдсэн audit_log. Агуулга (payload, шалтгаан, тайлбар) ЭНД орохгүй — зөвхөн төлөв ба зорилтын төрөл/ID (PII-гүй, docs/05 §8)
    await tx.audit({
      orgId: row.orgId, entity: 'CHANGE_REQUEST', entityId: row.id, action: `CHANGE_REQUEST_${event}`, actorId: actor?.userId ?? null,
      beforeJson: from ? { status: from } : null,
      afterJson: { status: row.status, mode: row.mode, targetType: row.targetType, targetId: row.targetId, targetAction: row.action },
      applicationId: row.applicationId, correlationId: actor?.correlationId ?? row.correlationId,
    });
  }

  private eventCtx(row: ChangeRequestRow, actor: Actor | null) {
    return { orgId: row.orgId, userId: actor?.userId ?? null, correlationId: actor?.correlationId ?? row.correlationId };
  }
  private ref(row: ChangeRequestRow) {
    return { changeRequestId: row.id, targetType: row.targetType, targetId: row.targetId, action: row.action, applicationId: row.applicationId, makerId: row.makerId };
  }
  private decidedEvent(row: ChangeRequestRow, outcome: Outcome, actor: Actor | null, checkerId: string | null, now: Date) {
    return buildEvent(this.eventCtx(row, actor), 'ChangeRequestDecided', { ...this.ref(row), outcome, checkerId }, now);
  }

  private translate(e: unknown): unknown {
    if (e instanceof PendingConflictError) return err('TARGET_HAS_PENDING_CHANGE');
    if (e instanceof LockTimeoutError) return err('DECISION_IN_PROGRESS');
    if (e instanceof ChangeConflictError) return err('STALE_TARGET', { reason: e.message });
    return e;
  }

  private toDto(row: ChangeRequestRow, actor: Actor, now: Date, history?: HistoryRow[]): ChangeRequestDto {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: row.id, orgId: row.orgId, branchId: row.branchId, targetType: row.targetType, targetId: row.targetId, action: row.action,
      applicationId: row.applicationId, mode: row.mode, status: row.status, payload: row.payload, before: row.before, baseVersion: row.baseVersion,
      reason: row.reason, makerId: row.makerId, makerRoles: row.makerRoles, requiredCheckerRoles: row.requiredCheckerRoles,
      checkerId: row.checkerId, checkerRoles: row.checkerRoles, checkerComment: row.checkerComment, failureReason: row.failureReason,
      expiresAt: row.expiresAt.toISOString(), decidedAt: iso(row.decidedAt), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      canDecide: canDecideNow(actor, row, now), canCancel: canCancelNow(actor, row),
      ...(history ? { history: history.map((h): ChangeRequestHistoryDto => ({ seq: h.seq, event: h.event, fromStatus: h.fromStatus, toStatus: h.toStatus, actorId: h.actorId, actorRoles: h.actorRoles, comment: h.comment, data: h.data ?? null, at: h.at.toISOString() })) } : {}),
    };
  }
}

const ChangeHandlerRegistryKey = (h: { targetType: string; action: string }) => `${h.targetType}:${h.action}`;
