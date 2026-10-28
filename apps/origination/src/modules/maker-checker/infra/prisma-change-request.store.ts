import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Prisma, PrismaClient } from '.prisma/client-origination';
import type { DomainEvent } from '@los/contracts';
import {
  LockTimeoutError, PendingConflictError,
  type ChangeRequestRow, type ChangeRequestStore, type ChangeRequestTx, type DecisionPatch, type HistoryEntry, type HistoryRow,
  type ListFilter, type NewChangeRequest, type PolicyRow,
} from '../change-request.store';
import { inboxCriteria } from '../maker-checker.domain';
import { MAKER_CHECKER_PRISMA, prismaRuntime } from './prisma-client.provider';

const { sql, empty } = prismaRuntime.Prisma;

/** Мөр/зорилтын түгжээг хүлээх дээд хугацаа: гацсан tx connection pool-ыг бүгдийг нь барьж болохгүй. MAKER_CHECKER_LOCK_TIMEOUT_MS-ээр өөрчилнө. */
const lockTimeoutMs = (): number => {
  const n = Number(process.env.MAKER_CHECKER_LOCK_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 100 && n <= 15_000 ? n : 3_000;
};
/** Postgres 55P03 (lock_not_available). Prisma интерактив tx дотор P2010 + meta.code хэлбэрээр ирдэг. */
const isLockTimeout = (e: unknown): boolean => {
  if (!(e instanceof prismaRuntime.Prisma.PrismaClientKnownRequestError)) return false;
  return (e.meta as { code?: string } | undefined)?.code === '55P03' || /55P03|lock timeout/i.test(e.message);
};

type Db = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toRow = (r: Prisma.ChangeRequestGetPayload<object>): ChangeRequestRow => ({ ...r, before: r.before ?? null, payload: r.payload });
const toPolicy = (p: Prisma.MakerCheckerPolicyGetPayload<object>): PolicyRow => ({
  orgId: p.orgId, targetType: p.targetType, action: p.action, enabled: p.enabled, checkerRoles: p.checkerRoles,
  expiresInHours: p.expiresInHours, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
});

/** Жагсаалт/тоолуурын where. Дүрэм нь maker-checker.domain-ийн canDecideNow / canView-тэй ижил утгатай (parity тест integration-д). */
function whereFor(orgId: string, f: Pick<ListFilter, 'scope' | 'actor' | 'now'> & Partial<ListFilter>): Prisma.ChangeRequestWhereInput | null {
  const base: Prisma.ChangeRequestWhereInput = {
    orgId,
    ...(f.targetType ? { targetType: f.targetType } : {}),
    ...(f.applicationId ? { applicationId: f.applicationId } : {}),
  };
  switch (f.scope) {
    case 'all': return { ...base, ...(f.status ? { status: f.status } : {}) };
    case 'decided': return { ...base, checkerId: f.actor.userId, ...(f.status ? { status: f.status } : {}) };
    case 'mine': return { ...base, makerId: f.actor.userId, ...(f.status ? { status: f.status } : {}) };
    case 'inbox': {
      const c = inboxCriteria(f.actor);
      const or: Prisma.ChangeRequestWhereInput[] = [];
      if (c.unscopedRoles.length) or.push({ requiredCheckerRoles: { hasSome: c.unscopedRoles } });
      // Салбарын дүр: зөвхөн өөрийн салбар (салбаргүй хүсэлтийг үзэхгүй — maker-checker.domain.roleDenial-тай ижил)
      if (c.scopedRoles.length && c.branchId) {
        or.push({ AND: [{ requiredCheckerRoles: { hasSome: c.scopedRoles } }, { branchId: c.branchId }] });
      }
      if (or.length === 0) return null;
      return { ...base, status: 'PENDING', makerId: { not: c.userId }, expiresAt: { gt: f.now }, OR: or };
    }
  }
}

class PrismaTx implements ChangeRequestTx {
  constructor(readonly db: Db) {}

  async lock(orgId: string, id: string) {
    if (!UUID.test(id)) return null;
    const hit = await this.db.$queryRaw<{ id: string }[]>(sql`SELECT id FROM origination.change_request WHERE id = ${id}::uuid AND org_id = ${orgId} FOR UPDATE`);
    if (hit.length === 0) return null;
    const row = await this.db.changeRequest.findUnique({ where: { id } });
    return row ? toRow(row) : null;
  }

  async lockTarget(orgId: string, targetType: string, targetId: string) {
    // Advisory lock → DIRECT (мөр үүсгэхгүй хүртэл) болон PENDING илгээлтүүдийг зорилт тус бүрээр цуваа болгоно.
    // Дараалал: advisory → мөрийн FOR UPDATE. decide() зөвхөн мөрийн түгжээ авдаг тул мөчлөг (deadlock) үүсэхгүй.
    await this.db.$executeRaw(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}|${targetType}|${targetId}`}, 0))`);
    const hit = await this.db.$queryRaw<{ id: string }[]>(sql`
      SELECT id FROM origination.change_request
      WHERE org_id = ${orgId} AND target_type = ${targetType} AND target_id = ${targetId} AND status = 'PENDING' FOR UPDATE`);
    if (hit.length === 0) return null;
    const row = await this.db.changeRequest.findUnique({ where: { id: hit[0]!.id } });
    return row ? toRow(row) : null;
  }

  async insert(row: NewChangeRequest, createdBy: string) {
    try {
      const { before, payload, ...rest } = row;
      const created = await this.db.changeRequest.create({
        data: {
          ...rest, payload: payload as Prisma.InputJsonValue, ...(before == null ? {} : { before: before as Prisma.InputJsonValue }),
          checkerRoles: rest.checkerRoles ?? [], createdBy, updatedBy: createdBy,
        },
      });
      return toRow(created);
    } catch (e) {
      // change_request_one_pending_per_target (partial unique index) → P2002
      if (e instanceof prismaRuntime.Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new PendingConflictError();
      throw e;
    }
  }

  async update(id: string, patch: DecisionPatch) {
    const { updatedBy, ...rest } = patch;
    return toRow(await this.db.changeRequest.update({ where: { id }, data: { ...rest, updatedBy, version: { increment: 1 } } }));
  }

  async appendHistory(requestId: string, e: HistoryEntry) {
    const last = await this.db.changeRequestHistory.aggregate({ where: { changeRequestId: requestId }, _max: { seq: true } });
    await this.db.changeRequestHistory.create({
      data: {
        changeRequestId: requestId, seq: (last._max.seq ?? 0) + 1, event: e.event, fromStatus: e.fromStatus, toStatus: e.toStatus,
        actorId: e.actorId, actorRoles: e.actorRoles, comment: e.comment, at: e.at,
        ...(e.data === undefined || e.data === null ? {} : { data: e.data as Prisma.InputJsonValue }),
      },
    });
  }

  // TODO(M00): @los/database enqueueOutbox хэрэгжсэний дараа түүгээр солино
  async enqueue(event: DomainEvent) {
    await this.db.outbox.create({ data: { id: event.eventId, type: event.type, payload: event as unknown as Prisma.InputJsonValue } });
  }

  async lockOverdue(now: Date, limit: number, orgId?: string) {
    const ids = await this.db.$queryRaw<{ id: string }[]>(sql`
      SELECT id FROM origination.change_request WHERE status = 'PENDING' AND expires_at <= ${now} ${orgId ? sql`AND org_id = ${orgId}` : empty}
      ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`);
    if (ids.length === 0) return [];
    return (await this.db.changeRequest.findMany({ where: { id: { in: ids.map((r) => r.id) } }, orderBy: { expiresAt: 'asc' } })).map(toRow);
  }

  async getPolicy(orgId: string, targetType: string, action: string) {
    const p = await this.db.makerCheckerPolicy.findUnique({ where: { orgId_targetType_action: { orgId, targetType, action } } });
    return p ? toPolicy(p) : null;
  }

  async upsertPolicy(p: Omit<PolicyRow, 'updatedAt'>) {
    const data = { enabled: p.enabled, checkerRoles: p.checkerRoles, expiresInHours: p.expiresInHours, updatedBy: p.updatedBy };
    return toPolicy(await this.db.makerCheckerPolicy.upsert({
      where: { orgId_targetType_action: { orgId: p.orgId, targetType: p.targetType, action: p.action } },
      update: data,
      create: { orgId: p.orgId, targetType: p.targetType, action: p.action, createdBy: p.updatedBy, ...data },
    }));
  }
}

@Injectable()
export class PrismaChangeRequestStore implements ChangeRequestStore, OnModuleDestroy {
  constructor(@Inject(MAKER_CHECKER_PRISMA) private readonly prisma: PrismaClient) {}

  onModuleDestroy() { return this.prisma.$disconnect(); }

  async transaction<T>(fn: (tx: ChangeRequestTx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (db) => {
        await db.$executeRaw(sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs()}ms`}, true)`); // tx дотор л үйлчилнэ (SET LOCAL)
        return fn(new PrismaTx(db));
      }, { maxWait: 5_000, timeout: 20_000 });
    } catch (e) {
      throw isLockTimeout(e) ? new LockTimeoutError() : e;
    }
  }

  async getPolicy(orgId: string, targetType: string, action: string) {
    const p = await this.prisma.makerCheckerPolicy.findUnique({ where: { orgId_targetType_action: { orgId, targetType, action } } });
    return p ? toPolicy(p) : null;
  }

  async listPolicies(orgId: string) { return (await this.prisma.makerCheckerPolicy.findMany({ where: { orgId } })).map(toPolicy); }

  async getById(orgId: string, id: string) {
    if (!UUID.test(id)) return null;
    const r = await this.prisma.changeRequest.findFirst({ where: { id, orgId } });
    return r ? toRow(r) : null;
  }

  async getHistory(id: string): Promise<HistoryRow[]> {
    const rows = await this.prisma.changeRequestHistory.findMany({ where: { changeRequestId: id }, orderBy: { seq: 'asc' } });
    return rows.map((h) => ({
      seq: h.seq, event: h.event, fromStatus: h.fromStatus, toStatus: h.toStatus, actorId: h.actorId, actorRoles: h.actorRoles,
      comment: h.comment, data: h.data ?? null, at: h.at,
    }));
  }

  async list(orgId: string, f: ListFilter) {
    const where = whereFor(orgId, f);
    if (!where) return { rows: [], total: 0 };
    const [rows, total] = await Promise.all([
      this.prisma.changeRequest.findMany({
        where, orderBy: f.scope === 'inbox' ? [{ expiresAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (f.page - 1) * f.pageSize, take: f.pageSize,
      }),
      this.prisma.changeRequest.count({ where }),
    ]);
    return { rows: rows.map(toRow), total };
  }

  async count(orgId: string, f: Pick<ListFilter, 'scope' | 'actor' | 'now'>) {
    const where = whereFor(orgId, { ...f, ...(f.scope === 'mine' ? { status: 'PENDING' as const } : {}) });
    return where ? this.prisma.changeRequest.count({ where }) : 0;
  }
}
