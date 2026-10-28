// FR-13.1 (хар жагсаалт CRUD, импорт), BR-9 (зөвхөн анхааруулга: энэ модуль хориг үүсгэхгүй, kyc WARNING hit гаргана).
// Шийдвэрүүд (docs/DECISIONS.md):
//  • Эрх: унших — нэвтэрсэн дурын дүр; үүсгэх/засах/идэвхгүй болгох/импорт — ADMIN, BRANCH_MANAGER (controller-ийн guard).
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
import { ConflictException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { ZodError, z } from 'zod';
import type { BlacklistEntry, BlacklistImportResult } from '@los/contracts';
import { hashRegisterNo, normalizeRegisterNo } from '@los/database';
import type { RequestContext } from './blacklist.context';
import {
  BLACKLIST_REPOSITORY, DuplicateBlacklistEntryError, StaleBlacklistEntryError,
  type BlacklistChangedEvent, type BlacklistRepository, type BlacklistRow,
} from './blacklist.repository';
import { BlacklistCreateBody, BlacklistPatchBody, MAX_IMPORT_ROWS, type BlacklistListQuery } from './blacklist.schemas';
import { BLACKLIST_CLOCK, BLACKLIST_IDS, PII_CIPHER, type Clock, type IdGenerator, type PiiCipher } from './blacklist.tokens';
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
const TRACKED = ['registerNoHash', 'customerType', 'name', 'listType', 'reasonCode', 'reasonText', 'isActive'] as const;

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
  ) {}

  async list(ctx: RequestContext, q: BlacklistListQuery) {
    const { total, items } = await this.repo.list(ctx.orgId, {
      search: q.q ? { text: q.q, registerNoHash: hashRegisterNo(q.q) } : undefined,
      listType: q.listType,
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
    const { row } = await this.register(ctx, input, true);
    return this.toEntry(row);
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
    if (patch.reasonCode !== undefined) next.reasonCode = patch.reasonCode;
    if (patch.reasonText !== undefined) next.reasonText = patch.reasonText || null;
    if (patch.isActive !== undefined) next.isActive = patch.isActive;
    if (TRACKED.every((k) => next[k] === row[k])) return this.toEntry(row);

    if (next.registerNoHash !== row.registerNoHash || next.listType !== row.listType) {
      const clash = await this.repo.findByKey(ctx.orgId, next.registerNoHash, next.listType);
      if (clash && clash.id !== row.id) throw new ConflictException(DUPLICATE_MESSAGE);
    }
    return this.toEntry(await this.save(ctx, row, next));
  }

  /** Устгахгүй, идэвхгүй болгоно (идэмпотент). */
  async deactivate(ctx: RequestContext, id: string): Promise<BlacklistEntry> {
    const row = await this.mustFind(ctx, id);
    if (!row.isActive) return this.toEntry(row);
    return this.toEntry(await this.save(ctx, row, { ...row, isActive: false }));
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
        result[(await this.register(ctx, parsed.data, false)).outcome]++;
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

  /** (org, register, listType)-ээр upsert. conflictIfActive: POST → идэвхтэй байвал 409; импорт → нэгтгэнэ/алгасна. */
  private async register(ctx: RequestContext, input: CreateInput, conflictIfActive: boolean): Promise<{ outcome: Outcome; row: BlacklistRow }> {
    const registerNoHash = hashRegisterNo(input.registerNo);
    const reasonText = input.reasonText || null;
    const existing = await this.repo.findByKey(ctx.orgId, registerNoHash, input.listType);

    if (!existing) {
      const now = this.clock.now();
      const row: BlacklistRow = {
        id: this.ids.uuid(), orgId: ctx.orgId, branchId: ctx.branchId,
        registerNoEncrypted: this.cipher.encrypt(normalizeRegisterNo(input.registerNo)), registerNoHash,
        customerType: input.customerType, name: input.name, listType: input.listType, reasonCode: input.reasonCode, reasonText,
        registeredBy: ctx.userId, registeredAt: now, isActive: true,
        createdAt: now, updatedAt: now, createdBy: ctx.userId, updatedBy: ctx.userId,
      };
      await this.persist(ctx, row, null, now);
      return { outcome: 'created', row };
    }
    if (existing.isActive && conflictIfActive) throw new ConflictException(DUPLICATE_MESSAGE);
    const next: BlacklistRow = { ...existing, customerType: input.customerType, name: input.name, reasonCode: input.reasonCode, reasonText, isActive: true };
    if (TRACKED.every((k) => next[k] === existing[k])) return { outcome: 'skipped', row: existing };
    return { outcome: 'updated', row: await this.save(ctx, existing, next) };
  }

  /**
   * `next`-ийг аудитын талбартай болгож хадгална; идэвхгүй → идэвхтэй шилжилт нь шинэ бүртгэл (registeredBy/At, branchId).
   * `prev` нь `next`-ийг үндэслэсэн, уншсан мөр: түүний updatedAt дээр compare-and-set хийнэ.
   */
  private async save(ctx: RequestContext, prev: BlacklistRow, next: BlacklistRow): Promise<BlacklistRow> {
    const occurredAt = this.clock.now();
    const at = this.after(prev.updatedAt, occurredAt);
    const reactivated = !prev.isActive && next.isActive;
    const row: BlacklistRow = {
      ...next,
      updatedAt: at,
      updatedBy: ctx.userId,
      ...(reactivated && { registeredBy: ctx.userId, registeredAt: at, branchId: ctx.branchId }),
    };
    await this.persist(ctx, row, prev.updatedAt, occurredAt);
    return row;
  }

  /** max(now, prev + 1ms): нэг entry-ийн updatedAt / changedAt хатуу өснө (kyc зөвхөн илүү шинэ changedAt-ыг авдаг). */
  private after(prev: Date, now: Date): Date {
    const min = prev.getTime() + 1;
    return now.getTime() >= min ? now : new Date(min);
  }

  private async persist(ctx: RequestContext, row: BlacklistRow, expectedUpdatedAt: Date | null, occurredAt: Date): Promise<void> {
    try {
      await this.repo.saveWithEvent(row, this.event(ctx, row, occurredAt), expectedUpdatedAt);
    } catch (e) {
      if (e instanceof DuplicateBlacklistEntryError) throw new ConflictException(DUPLICATE_MESSAGE);
      if (e instanceof StaleBlacklistEntryError) throw new ConflictException(STALE_MESSAGE);
      throw e;
    }
  }

  /** Plain регистр event-д орохгүй — зөвхөн HMAC hash (kyc projection). changedAt = мөрийн updatedAt (CAS-д ашигласан утга). */
  private event(ctx: RequestContext, row: BlacklistRow, occurredAt: Date): BlacklistChangedEvent {
    return {
      type: 'BlacklistEntryChanged', eventId: this.ids.uuid(), occurredAt: occurredAt.toISOString(), version: 1,
      orgId: row.orgId, actorId: ctx.userId, correlationId: ctx.correlationId,
      entryId: row.id, registerNoHash: row.registerNoHash, customerType: row.customerType, name: row.name,
      listType: row.listType, reasonCode: row.reasonCode, isActive: row.isActive, changedAt: row.updatedAt.toISOString(),
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
      name: row.name, listType: row.listType, reasonCode: row.reasonCode, reasonText: row.reasonText,
      isActive: row.isActive, registeredBy: row.registeredBy, registeredAt: row.registeredAt.toISOString(),
    };
  }
}
