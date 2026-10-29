import type { DomainEvent, MerchantStatus, PosLeaseStatus } from '@los/contracts';
import type { LeaseDashboardRow, LeaseEventRecord, LeaseRecord, MerchantRecord, OtpRecord, PlanRecord, StoreRecord, TimelineInput } from '../domain/records';

export interface PageArgs { page: number; pageSize: number }
export interface Page<T> { items: T[]; total: number }

/**
 * Tenant хил: repository дуудлага бүрт заавал; байхгүй/хүрээнээс гадуур → null (service 404 болгоно).
 * `branchId` = мерчантын ОДООГИЙН салбар (`merchant.branch_id`), `pos_lease.branch_id` (үүсгэх үеийн түүхэн хуулбар) биш — мерчант шилжвэл лизинг дагаж шилжинэ (docs/05 §2, §8).
 */
export interface LeaseScope { orgId: string; merchantId?: string; storeId?: string; branchId?: string }
export interface LeaseFilter {
  statuses?: PosLeaseStatus[]; from?: Date; to?: Date;
  /** Лизингийн дугаарын хэсэг (том жижиг үсэг үл ялгана) */
  leaseNoLike?: string;
  /** Утасны сүүлийн цифрүүд */
  buyerPhoneSuffix?: string;
  /** Бүтэн регистрийн hash (PiiCipher.hash) */
  buyerRegisterHash?: string;
}

/**
 * Мерчант, дэлгүүр. `events` нь бизнес бичлэгтэй НЭГ транзакцид outbox-д бичигдэнэ (CLAUDE.md §3.2.4).
 * Давхар (orgId, code) → DomainError('DUPLICATE_CODE').
 * Optimistic lock: insert-ийн version үргэлж 1. `save*` нь `m.version` хадгалагдсан version-тай тэнцүү үед л шинэчилж version + 1-ээр буцаана;
 * мөр байгаа атал version зөрвөл DomainError('CONCURRENT_UPDATE'), мөр байхгүй бол NOT_FOUND. Үүнийг event/outbox бичихээс ӨМНӨ шалгана (зөрчилдсөн хүсэлтийн event гарахгүй).
 */
export abstract class MerchantRepository {
  abstract createMerchant(m: MerchantRecord, events: DomainEvent[]): Promise<MerchantRecord>;
  abstract saveMerchant(m: MerchantRecord, events: DomainEvent[]): Promise<MerchantRecord>;
  abstract findMerchant(orgId: string, id: string): Promise<MerchantRecord | null>;
  abstract listMerchants(orgId: string, filter: { status?: MerchantStatus; q?: string; branchId?: string }, page: PageArgs): Promise<Page<MerchantRecord>>;
  /** Давхар (merchantId, code) → DomainError('DUPLICATE_CODE'). */
  abstract createStore(s: StoreRecord): Promise<StoreRecord>;
  abstract saveStore(s: StoreRecord): Promise<StoreRecord>;
  abstract findStore(merchantId: string, storeId: string): Promise<StoreRecord | null>;
  abstract listStores(merchantId: string): Promise<StoreRecord[]>;
}

/** Optimistic lock (version) — MerchantRepository-той ижил: insert = 1, `savePlan` нь version тэнцүү үед л +1, зөрвөл CONCURRENT_UPDATE. */
export abstract class PlanRepository {
  /** Давхар (orgId, code) → DomainError('DUPLICATE_CODE'). */
  abstract createPlan(p: PlanRecord): Promise<PlanRecord>;
  abstract savePlan(p: PlanRecord): Promise<PlanRecord>;
  abstract findPlan(orgId: string, id: string): Promise<PlanRecord | null>;
  abstract findPlanByCode(orgId: string, code: string): Promise<PlanRecord | null>;
  abstract listPlans(orgId: string, filter: { merchantId?: string; isActive?: boolean }): Promise<PlanRecord[]>;
  /** merchantId = null (бүх мерчант) эсвэл тухайн мерчантынх; идэвхгүй, хугацаа дууссаныг ч оруулна (service шүүнэ). */
  abstract listPlansForMerchant(orgId: string, merchantId: string): Promise<PlanRecord[]>;
}

export abstract class LeaseRepository {
  /** Шинэ лизинг + timeline + event нэг tx. (merchantId, idempotencyKey) / leaseNo давхцвал LeaseKeyConflict. */
  abstract insertLease(l: LeaseRecord, timeline: TimelineInput, events: DomainEvent[]): Promise<LeaseRecord>;
  /**
   * Optimistic: `l.version` нь одоогийн хадгалагдсан version-тай тэнцүү байх ёстой, үгүй бол DomainError('CONCURRENT_UPDATE').
   * Амжилттай бол version + 1, updatedAt-аар хадгалж буцаана. Timeline, event нэг tx.
   */
  abstract saveLease(l: LeaseRecord, timeline: TimelineInput, events: DomainEvent[]): Promise<LeaseRecord>;
  abstract findLease(scope: LeaseScope, id: string): Promise<LeaseRecord | null>;
  abstract findByIdempotencyKey(merchantId: string, key: string): Promise<LeaseRecord | null>;
  /** createdAt буурах эрэмбээр. */
  abstract listLeases(scope: LeaseScope, filter: LeaseFilter, page: PageArgs): Promise<Page<LeaseRecord>>;
  abstract timeline(leaseId: string): Promise<LeaseEventRecord[]>;
  /** createdAt ∈ [from, to) */
  abstract dashboardRows(scope: LeaseScope, from: Date, to: Date): Promise<LeaseDashboardRow[]>;
  /** acceptedAt ∈ [from, to) ба status ∈ ACCEPTED/DELIVERED/SETTLED лизингүүдийн санхүүжилтийн нийлбэр (өдрийн лимит). */
  abstract sumAcceptedFinanced(merchantId: string, from: Date, to: Date): Promise<number>;
  /** Хугацаа нь дууссан (expiresAt < now), төлөв нь DRAFT/REFERRED/APPROVED лизингүүд. */
  abstract listExpirable(now: Date, limit: number): Promise<LeaseRecord[]>;
}

export abstract class OtpRepository {
  abstract insertOtp(o: OtpRecord): Promise<OtpRecord>;
  abstract saveOtp(o: OtpRecord): Promise<OtpRecord>;
  /** Хамгийн сүүлд илгээсэн (sentAt) */
  abstract latestOtp(leaseId: string, purpose: OtpRecord['purpose']): Promise<OtpRecord | null>;
  abstract countOtps(leaseId: string): Promise<number>;
  /**
   * POS-BR-8: оролдлогыг АТОМААР тоолно (read-modify-write биш) — баталгаажаагүй, attempts < maxAttempts үед л +1 хийж шинэ тоог буцаана.
   * Нөхцөл биелээгүй (хязгаарт хүрсэн / баталгаажсан / олдсонгүй) бол null. Зэрэгцээ хүсэлтээр 6 оронтой кодыг brute force хийхээс хамгаална.
   */
  abstract registerOtpAttempt(otp: Pick<OtpRecord, 'id' | 'orgId'>, maxAttempts: number): Promise<number | null>;
  /** Кодыг ЗӨВХӨН НЭГ УДАА ашиглагдсанаар тэмдэглэнэ (verifiedAt IS NULL үед). false → өөр хүсэлт аль хэдийн ашигласан / олдсонгүй. */
  abstract markOtpVerified(otp: Pick<OtpRecord, 'id' | 'orgId'>, at: Date): Promise<boolean>;
}
