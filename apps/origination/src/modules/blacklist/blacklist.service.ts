// FR-13.1 (хар жагсаалт CRUD, импорт), BR-9 (зөвхөн анхааруулга: энэ модуль хориг үүсгэхгүй, kyc WARNING hit гаргана).
// Шийдвэрүүд (docs/DECISIONS.md):
//  • Эрх: унших — нэвтэрсэн дурын дүр; үүсгэх/засах/идэвхгүй болгох/импорт — ADMIN/COMPLIANCE/BRANCH_MANAGER (`blacklist:manage`; controller-ийн guard).
//  • Регистр шифрлэгдэж (CLAUDE.md §6.5), нормчилсон хэлбэрээр хадгалагдана; хариунд ч нормчилсон утга. Шифртэй текст нь
//    санамсаргүй тул харьцуулалт/давхардал/хайлт HMAC hash-аар (hashRegisterNo). Hash зөвхөн event-д (kyc projection), хариу/лог-д гарахгүй.
//  • Давхардал: (orgId, registerNoHash, listType) unique, идэвхгүй мөрийг ч хамарна. POST: идэвхтэй бол 409, идэвхгүй бол шинэ
//    өгөгдлөөр дахин идэвхжүүлнэ (id, createdBy хэвээр; registeredBy/At, branchId шинэчлэгдэнэ). PATCH өөр мөрийн түлхүүртэй
//    давхцвал (идэвхгүй мөртэй ч) 409.
//  • Устгахгүй: DELETE = isActive=false, идэмпотент. Өөрчлөлтгүй PATCH / аль хэдийн идэвхгүй мөрийн DELETE event гаргахгүй.
//  • Нэрээр тулгахгүй: дотоод хар жагсаалтыг регистрээр л тулгана (нийтлэг нэрээр хуурамч тохирол их). `name` нь харуулах/хайх талбар.
//  • Мөр + event нэг транзакцид (repo.saveWithEvent). Импорт мөр бүр тусдаа транзакц: файл бүхэлдээ атомик биш, харин дахин
//    ачаалахад өөрчлөгдөөгүй мөр `skipped` болно. Алдаатай мөр (шалгалт, зэрэг засвар, DB алдаа) бусдыг зогсоохгүй — errors[]-д орно.
//  • Зэрэг засвар: бичилт нь уншсан мөрийн updatedAt дээрх compare-and-set; зөрвөл 409 (дахин оролдоно). Тиймээс нэг entry-ийн
//    updatedAt (= event.changedAt) хатуу өсөх ба kyc projection (зөвхөн илүү шинэ changedAt-ыг хэрэглэдэг) origination-тай таарна.
//    changedAt = max(цаг, өмнөх updatedAt + 1ms): цаг буцсан/ижил ms-д ч дараалал алдагдахгүй.
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { ZodError, z } from 'zod';
import type { BlacklistEntry, BlacklistImportResult } from '@los/contracts';
import { hashRegisterNo, normalizeRegisterNo } from '@los/database';
import { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { BLACKLIST_CHANGE_ACTION, BLACKLIST_CHANGE_TARGET } from './blacklist-escalation.handler';
import type { RequestContext } from './blacklist.context';
import {
  BLACKLIST_REPOSITORY, DuplicateBlacklistEntryError, StaleBlacklistEntryError,
  type BlacklistAudit, type BlacklistChangedEvent, type BlacklistRepository, type BlacklistRow,
} from './blacklist.repository';
import { BlacklistCreateBody, BlacklistPatchBody, MAX_IMPORT_ROWS, type BlacklistListQuery } from './blacklist.schemas';
import { BLACKLIST_CLOCK, BLACKLIST_IDS, BLACKLIST_SETTINGS, PII_CIPHER, type BlacklistSettings, type Clock, type IdGenerator, type PiiCipher } from './blacklist.tokens';
import { safeIssues } from './zod.pipe';

type CreateInput = z.infer<typeof BlacklistCreateBody>;
type Outcome = 'created' | 'updated' | 'skipped';
/** Импортын нэг мөр: CSV-ийн бүтцийн алдаатай мөр `error`-той ирнэ. */
export type ImportItem = { row: number; data: unknown } | { row: number; error: string };

const DUPLICATE_MESSAGE = 'An entry with the same register number and list type already exists';
const STALE_MESSAGE = 'Blacklist entry was modified concurrently, retry';
/** Импортын мөр DB алдаагаар унавал: алдааны текст (утга агуулж болзошгүй) хариу/лог-д орохгүй. */
const ROW_FAILED_MESSAGE = 'Row could not be saved (internal error)';

/** Нэг импортын дээд мөр хэтэрсэн (413). Controller мөн CSV задлахдаа ашиглана. */
export const importLimitError = () => new PayloadTooLargeException(`At most ${MAX_IMPORT_ROWS} rows per import`);
/** PATCH-д "өөрчлөгдсөн үү" гэж харьцуулах талбарууд (шифртэй текстийг харьцуулахгүй). */
const TRACKED = ['registerNoHash', 'customerType', 'name', 'listType', 'severity', 'source', 'reasonCode', 'reasonText', 'isActive', 'deactivationReason', 'pendingSeverity'] as const;
const sameRow = (a: BlacklistRow, b: BlacklistRow) => TRACKED.every((k) => a[k] === b[k]) && (a.validUntil?.getTime() ?? null) === (b.validUntil?.getTime() ?? null);
/** Хугацаа дуусаж автоматаар идэвхгүй болгосон шалтгаан (Q-131). */
export const AUTO_EXPIRED_REASON = 'AUTO_EXPIRED';
const SYSTEM_USER = 'system';
const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + m); return x; };

/** Импортын мөрийн алдаа: zod-ын "received ..." (регистр зэрэг хүсэлтийн утга)-гүй, код тус бүрт тогтмол мессеж (zod.pipe safeIssues). */
const describeIssues = (e: ZodError) => safeIssues(e).map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ');
/** Лог-д зөвхөн алдааны төрөл/код (Prisma-н мессеж утга агуулдаг). */
function errorLabel(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const { code } = e as Error & { code?: unknown };
  return typeof code === 'string' ? `${e.name} ${code}` : e.name;
}

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(
    @Inject(BLACKLIST_REPOSITORY) private readonly repo: BlacklistRepository,
    @Inject(PII_CIPHER) private readonly cipher: PiiCipher,
    @Inject(BLACKLIST_CLOCK) private readonly clock: Clock,
    @Inject(BLACKLIST_IDS) private readonly ids: IdGenerator,
    @Inject(MakerCheckerService) private readonly mc: MakerCheckerService,
    @Inject(BLACKLIST_SETTINGS) private readonly settings: BlacklistSettings,
  ) {}

  async list(ctx: RequestContext, q: BlacklistListQuery) {
    const { total, items } = await this.repo.list(ctx.orgId, {
      search: q.q ? { text: q.q, registerNoHash: hashRegisterNo(q.q) } : undefined,
      listType: q.listType,
      severity: q.severity,
      isActive: q.isActive,
      limit: q.limit,
      offset: q.offset,
    });
    return { total, items: items.map((r) => this.toEntry(r)) };
  }

  async get(ctx: RequestContext, id: string): Promise<BlacklistEntry> {
    return this.toEntry(await this.mustFind(ctx, id));
  }

  async create(ctx: RequestContext, input: CreateInput): Promise<BlacklistEntry> {
    const { row, submit } = await this.register(ctx, input, true);
    if (submit) await this.requestBlack(ctx, row);
    return this.toEntry(submit ? ((await this.repo.findById(ctx.orgId, row.id)) ?? row) : row);
  }

  async update(ctx: RequestContext, id: string, patch: z.infer<typeof BlacklistPatchBody>): Promise<BlacklistEntry> {
    const row = await this.mustFind(ctx, id);
    const next: BlacklistRow = { ...row };
    if (patch.registerNo !== undefined) {
      const registerNoHash = hashRegisterNo(patch.registerNo);
      if (registerNoHash !== row.registerNoHash) {
        next.registerNoHash = registerNoHash;
        next.registerNoEncrypted = this.cipher.encrypt(normalizeRegisterNo(patch.registerNo));
      }
    }
    if (patch.customerType !== undefined) next.customerType = patch.customerType;
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.listType !== undefined) next.listType = patch.listType;
    if (patch.severity !== undefined) {
      next.severity = patch.severity;
      if (patch.severity === 'GREY') next.pendingSeverity = null; // Хар болгох хүсэлтээс татгалзсан гэсэн үг
    }
    if (patch.source !== undefined) next.source = patch.source;
    if (patch.reasonCode !== undefined) next.reasonCode = patch.reasonCode;
    if (patch.reasonText !== undefined) next.reasonText = patch.reasonText || null;
    if (patch.validUntil !== undefined) next.validUntil = this.parseValidUntil(patch.validUntil);
    if (patch.isActive === false && row.isActive) {
      // Q-133: идэвхгүй болгоход шалтгаан заавал
      if (!patch.deactivationReason) throw new BadRequestException('deactivationReason is required to deactivate an entry');
      next.isActive = false;
      next.deactivationReason = patch.deactivationReason;
      next.pendingSeverity = null;
    } else if (patch.isActive === true && !row.isActive) {
      next.isActive = true;
      next.deactivationReason = null;
    }
    // Q-131: Саарал бүртгэл (дахин) идэвхжих/Саарал болоход хугацаа заагаагүй бол +12 сар (setting)
    if (patch.validUntil === undefined && next.severity === 'GREY' && next.isActive && (next.validUntil === null || (!row.isActive || row.severity !== 'GREY'))) {
      next.validUntil = await this.defaultValidUntil(ctx.orgId, 'GREY');
    }
    if (sameRow(next, row)) return this.toEntry(row);

    if (next.registerNoHash !== row.registerNoHash || next.listType !== row.listType) {
      const clash = await this.repo.findByKey(ctx.orgId, next.registerNoHash, next.listType);
      if (clash && clash.id !== row.id) throw new ConflictException(DUPLICATE_MESSAGE);
    }
    const { row: toSave, submit } = this.gate(row, next);
    const saved = await this.save(ctx, row, toSave, submit ? 'ESCALATE_REQUESTED' : undefined);
    if (submit) await this.requestBlack(ctx, saved);
    return this.toEntry(submit ? ((await this.repo.findById(ctx.orgId, saved.id)) ?? saved) : saved);
  }

  /** Q-133: идэвхгүй болгоно (устгахгүй), шалтгаан заавал. Идэмпотент. */
  async deactivate(ctx: RequestContext, id: string, reason: string): Promise<BlacklistEntry> {
    const row = await this.mustFind(ctx, id);
    if (!row.isActive) return this.toEntry(row);
    return this.toEntry(await this.save(ctx, row, { ...row, isActive: false, deactivationReason: reason, pendingSeverity: null }));
  }

  /**
   * Q-131: хугацаа нь дууссан идэвхтэй бүртгэлийг идэвхгүй болгоно (sweeper). Нэг мөрийн алдаа бусдыг зогсоохгүй.
   * Хайлт (BlacklistLookupService, BlacklistChecker) `validUntil`-ийг мөн шалгадаг тул sweeper хоцорсон ч expired бүртгэл анхааруулга өгөхгүй.
   */
  async expireDue(limit = 100): Promise<number> {
    const now = this.clock.now();
    let done = 0;
    for (const row of await this.repo.findExpired(now, limit)) {
      const ctx: RequestContext = { userId: SYSTEM_USER, roles: [], branchId: null, correlationId: `blacklist-expiry-${this.ids.uuid()}`, orgId: row.orgId };
      try {
        await this.save(ctx, row, { ...row, isActive: false, deactivationReason: AUTO_EXPIRED_REASON, pendingSeverity: null });
        done++;
      } catch (e) {
        if (e instanceof ConflictException) continue; // зэрэг засвар: дараагийн удаад
        this.logger.error(`blacklist expiry failed for entry ${row.id}: ${errorLabel(e)}`);
      }
    }
    return done;
  }

  async importRows(ctx: RequestContext, items: ImportItem[]): Promise<BlacklistImportResult> {
    if (items.length > MAX_IMPORT_ROWS) throw importLimitError();
    const result: BlacklistImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
    for (const item of items) {
      if ('error' in item) {
        result.errors.push({ row: item.row, message: item.error });
        continue;
      }
      const parsed = BlacklistCreateBody.safeParse(item.data);
      if (!parsed.success) {
        result.errors.push({ row: item.row, message: describeIssues(parsed.error) });
        continue;
      }
      try {
        const reg = await this.register(ctx, parsed.data, false);
        result[reg.outcome]++;
        if (reg.submit) await this.requestBlack(ctx, reg.row);
      } catch (e) {
        // Нэг мөрийн DB алдаа өмнө нь commit хийсэн мөрүүдийг тайлангүй үлдээж болохгүй: мөрийн алдаа болгож үргэлжлүүлнэ.
        if (e instanceof ConflictException) {
          result.errors.push({ row: item.row, message: e.message });
        } else {
          this.logger.error(`blacklist import row ${item.row} failed: ${errorLabel(e)} (correlationId=${ctx.correlationId})`);
          result.errors.push({ row: item.row, message: ROW_FAILED_MESSAGE });
        }
      }
    }
    return result;
  }

  /** (org, register, listType)-ээр upsert. conflictIfActive: POST → идэвхтэй байвал 409; импорт → нэгтгэнэ/алгасна. `submit` = Хар болгох 4 нүдний хүсэлт илгээх шаардлагатай (Q-132). */
  private async register(ctx: RequestContext, input: CreateInput, conflictIfActive: boolean): Promise<{ outcome: Outcome; row: BlacklistRow; submit: boolean }> {
    const registerNoHash = hashRegisterNo(input.registerNo);
    const reasonText = input.reasonText || null;
    const existing = await this.repo.findByKey(ctx.orgId, registerNoHash, input.listType);
    const validUntil = input.validUntil !== undefined ? this.parseValidUntil(input.validUntil) : await this.defaultValidUntil(ctx.orgId, input.severity);

    if (!existing) {
      const now = this.clock.now();
      const desired: BlacklistRow = {
        id: this.ids.uuid(), orgId: ctx.orgId, branchId: ctx.branchId,
        registerNoEncrypted: this.cipher.encrypt(normalizeRegisterNo(input.registerNo)), registerNoHash,
        customerType: input.customerType, name: input.name, listType: input.listType, severity: input.severity, source: input.source,
        validUntil, deactivationReason: null, pendingSeverity: null, reasonCode: input.reasonCode, reasonText,
        registeredBy: ctx.userId, registeredAt: now, isActive: true,
        createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId,
      };
      const { row, submit } = this.gate(null, desired);
      await this.persist(ctx, row, null, now, this.audit(ctx, submit ? 'ESCALATE_REQUESTED' : 'CREATE', null, row));
      return { outcome: 'created', row, submit };
    }
    if (existing.isActive && conflictIfActive && !existing.pendingSeverity) throw new ConflictException(DUPLICATE_MESSAGE);
    // Дахин импорт нь хугацааг сунгахгүй: тодорхой validUntil өгөөгүй, идэвхтэй, түвшин ижил бол хуучныг хадгална.
    const keepUntil = input.validUntil === undefined && existing.isActive && existing.severity === input.severity;
    const next: BlacklistRow = {
      ...existing, customerType: input.customerType, name: input.name, severity: input.severity, source: input.source, validUntil: keepUntil ? existing.validUntil : validUntil,
      reasonCode: input.reasonCode, reasonText, isActive: true, deactivationReason: null,
    };
    const { row: toSave, submit } = this.gate(existing, next);
    if (sameRow(toSave, existing)) return { outcome: 'skipped', row: existing, submit: false };
    return { outcome: 'updated', row: await this.save(ctx, existing, toSave, submit ? 'ESCALATE_REQUESTED' : undefined), submit };
  }

  /**
   * Q-132: идэвхтэй Хар болох өөрчлөлт нь шууд хэрэгжихгүй — мөр `pendingSeverity = BLACK` болж, одоогийн түвшин/идэвхжилт хэвээр
   * (шинэ мөр = идэвхгүй, түвшин GREY тавиур), 4 нүдний хүсэлт илгээгдэнэ. Аль хэдийн идэвхтэй Хар бол хүсэлт үүсэхгүй.
   * Хар → Саарал, Саарал шууд бүртгэл нь 4 нүдгүй.
   */
  private gate(prev: BlacklistRow | null, desired: BlacklistRow): { row: BlacklistRow; submit: boolean } {
    const wantsBlack = desired.isActive && desired.severity === 'BLACK';
    const alreadyBlack = !!prev && prev.isActive && prev.severity === 'BLACK';
    if (!wantsBlack || alreadyBlack) return { row: desired, submit: false };
    return {
      row: { ...desired, severity: prev ? prev.severity : 'GREY', isActive: prev?.isActive ?? false, pendingSeverity: 'BLACK' },
      submit: true,
    };
  }

  /** Q-132: 4 нүдний хүсэлт. Payload-д зөвхөн entryId (PII-гүй, maker-checker-ийн өөрчлөгдөхгүй түүх). Policy идэвхгүй бол шууд хэрэгжинэ. */
  private async requestBlack(ctx: RequestContext, row: BlacklistRow): Promise<void> {
    await this.mc.submit(
      { userId: ctx.userId, roles: ctx.roles, branchId: ctx.branchId, orgId: ctx.orgId, correlationId: ctx.correlationId },
      { targetType: BLACKLIST_CHANGE_TARGET, action: BLACKLIST_CHANGE_ACTION, targetId: row.id, payload: { entryId: row.id }, reason: `Хар жагсаалтад оруулах: ${row.reasonCode}` },
    );
  }

  private parseValidUntil(raw: string | null | undefined): Date | null {
    if (raw === null || raw === undefined) return null;
    const d = new Date(raw);
    if (!(d.getTime() > this.clock.now().getTime())) throw new BadRequestException('validUntil must be in the future');
    return d;
  }

  /** Q-131: Саарал = одоо + `blacklist.grey_valid_months` (анхдагч 12); Хар = хугацаагүй. */
  private async defaultValidUntil(orgId: string, severity: 'BLACK' | 'GREY'): Promise<Date | null> {
    return severity === 'GREY' ? addMonths(this.clock.now(), await this.settings.greyValidMonths(orgId)) : null;
  }

  /**
   * `next`-ийг аудитын талбартай болгож хадгална; идэвхгүй → идэвхтэй шилжилт нь шинэ бүртгэл (registeredBy/At, branchId).
   * `prev` нь `next`-ийг үндэслэсэн, уншсан мөр: түүний updatedAt дээр compare-and-set хийнэ.
   */
  private async save(ctx: RequestContext, prev: BlacklistRow, next: BlacklistRow, forced?: BlacklistAudit['action']): Promise<BlacklistRow> {
    const occurredAt = this.clock.now();
    const at = this.after(prev.updatedAt, occurredAt);
    const reactivated = !prev.isActive && next.isActive;
    const row: BlacklistRow = {
      ...next,
      updatedAt: at,
      updatedBy: ctx.userId,
      ...(reactivated && { registeredBy: ctx.userId, registeredAt: at, branchId: ctx.branchId }),
    };
    const action = forced ?? (reactivated ? 'REACTIVATE' : prev.isActive && !next.isActive ? 'DEACTIVATE' : 'UPDATE');
    await this.persist(ctx, row, prev.updatedAt, occurredAt, this.audit(ctx, action, prev, row));
    return row;
  }

  /** max(now, prev + 1ms): нэг entry-ийн updatedAt / changedAt хатуу өснө (kyc зөвхөн илүү шинэ changedAt-ыг авдаг). */
  private after(prev: Date, now: Date): Date {
    const min = prev.getTime() + 1;
    return now.getTime() >= min ? now : new Date(min);
  }

  private async persist(ctx: RequestContext, row: BlacklistRow, expectedUpdatedAt: Date | null, occurredAt: Date, audit?: BlacklistAudit): Promise<void> {
    try {
      await this.repo.saveWithEvent(row, this.event(ctx, row, occurredAt), expectedUpdatedAt, audit);
    } catch (e) {
      if (e instanceof DuplicateBlacklistEntryError) throw new ConflictException(DUPLICATE_MESSAGE);
      if (e instanceof StaleBlacklistEntryError) throw new ConflictException(STALE_MESSAGE);
      throw e;
    }
  }

  /** Аудитын агуулга: PII (регистр, hash, нэр) ОРОХГҮЙ; зөвхөн ангилал, шалтгаан, төлөв. */
  private audit(ctx: RequestContext, action: BlacklistAudit['action'], before: BlacklistRow | null, after: BlacklistRow): BlacklistAudit {
    const view = (r: BlacklistRow) => ({ listType: r.listType, severity: r.severity, pendingSeverity: r.pendingSeverity, source: r.source, validUntil: r.validUntil?.toISOString() ?? null, reasonCode: r.reasonCode, hasReasonText: r.reasonText !== null, deactivationReason: r.deactivationReason, customerType: r.customerType, isActive: r.isActive });
    return { action, actorId: ctx.userId, correlationId: ctx.correlationId, before: before && view(before), after: view(after) };
  }

  /** Plain регистр event-д орохгүй — зөвхөн HMAC hash (kyc projection). changedAt = мөрийн updatedAt (CAS-д ашигласан утга). */
  private event(ctx: RequestContext, row: BlacklistRow, occurredAt: Date): BlacklistChangedEvent {
    return {
      type: 'BlacklistEntryChanged', eventId: this.ids.uuid(), occurredAt: occurredAt.toISOString(), version: 1,
      orgId: row.orgId, actorId: ctx.userId, correlationId: ctx.correlationId,
      entryId: row.id, registerNoHash: row.registerNoHash, customerType: row.customerType, name: row.name,
      listType: row.listType, severity: row.severity, reasonCode: row.reasonCode, isActive: row.isActive, changedAt: row.updatedAt.toISOString(),
    };
  }

  private async mustFind(ctx: RequestContext, id: string): Promise<BlacklistRow> {
    const row = await this.repo.findById(ctx.orgId, id);
    if (!row) throw new NotFoundException('Blacklist entry not found');
    return row;
  }

  /** Хариунд hash/шифртэй текст орохгүй; регистрийг тайлж өгнө (дотоод API: унших нь нэвтэрсэн дурын дуудагчид нээлттэй, эрхийг gateway шийднэ). */
  private toEntry(row: BlacklistRow): BlacklistEntry {
    return {
      id: row.id, orgId: row.orgId, registerNo: this.cipher.decrypt(row.registerNoEncrypted), customerType: row.customerType,
      name: row.name, listType: row.listType, severity: row.severity, source: row.source, validUntil: row.validUntil?.toISOString() ?? null,
      deactivationReason: row.deactivationReason, pendingSeverity: row.pendingSeverity, reasonCode: row.reasonCode, reasonText: row.reasonText,
      isActive: row.isActive, registeredBy: row.registeredBy, registeredAt: row.registeredAt.toISOString(),
    };
  }
}
