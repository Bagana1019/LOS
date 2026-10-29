import type { DomainEvent, PosLeaseStatus } from '@los/contracts';
import { DomainError, LeaseKeyConflict } from '../../domain/errors';
import type { LeaseDashboardRow, LeaseEventRecord, LeaseRecord, MerchantRecord, OtpRecord, PlanRecord, StoreRecord, TimelineInput } from '../../domain/records';
import { LeaseRepository, MerchantRepository, OtpRepository, PlanRepository, type LeaseFilter, type LeaseScope, type Page, type PageArgs } from '../repositories';

// Тест, demo-д зориулсан санах ойн хэрэгжүүлэлт. Prisma хэрэгжүүлэлттэй ИЖИЛ семантиктай байх ёстой
// (persistence/repository.contract.ts-ийн хоёуланд ажилладаг).

/** Outbox-ын санах ойн орлуулагч: бизнес бичлэгтэй хамт "commit" болсон event-үүд. */
export class InMemoryOutbox {
  readonly events: DomainEvent[] = [];
  push(events: DomainEvent[]) { this.events.push(...events); }
}

const paginate = <T>(all: T[], { page, pageSize }: PageArgs): Page<T> => ({ items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length });
const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryMerchantRepository extends MerchantRepository {
  private merchants = new Map<string, MerchantRecord>();
  private stores = new Map<string, StoreRecord>();
  constructor(private readonly outbox: InMemoryOutbox = new InMemoryOutbox()) { super(); }

  async createMerchant(m: MerchantRecord, events: DomainEvent[]) {
    if ([...this.merchants.values()].some((x) => x.orgId === m.orgId && x.code === m.code)) throw new DomainError('DUPLICATE_CODE', `merchant code ${m.code} already exists`);
    const stored = { ...clone(m), version: 1 }; // insert үргэлж version 1
    this.merchants.set(m.id, stored);
    this.outbox.push(events);
    return clone(stored);
  }
  /** Optimistic lock: Prisma хэрэгжүүлэлттэй ижил — NOT_FOUND → CONCURRENT_UPDATE → DUPLICATE_CODE дараалал; event нь амжилттай бичлэгтэй л орно. */
  async saveMerchant(m: MerchantRecord, events: DomainEvent[]) {
    const cur = this.merchants.get(m.id);
    if (!cur || cur.orgId !== m.orgId) throw new DomainError('NOT_FOUND', 'merchant not found');
    if (cur.version !== m.version) throw new DomainError('CONCURRENT_UPDATE', 'merchant was modified concurrently');
    if ([...this.merchants.values()].some((x) => x.id !== m.id && x.orgId === m.orgId && x.code === m.code)) throw new DomainError('DUPLICATE_CODE', `merchant code ${m.code} already exists`);
    const next = { ...clone(m), version: m.version + 1 };
    this.merchants.set(m.id, next);
    this.outbox.push(events);
    return clone(next);
  }
  async findMerchant(orgId: string, id: string) {
    const m = this.merchants.get(id);
    return m && m.orgId === orgId ? clone(m) : null;
  }
  async listMerchants(orgId: string, filter: { status?: MerchantRecord['status']; q?: string; branchId?: string }, page: PageArgs) {
    const q = filter.q?.trim().toLowerCase();
    const all = [...this.merchants.values()]
      .filter((m) => m.orgId === orgId && (!filter.status || m.status === filter.status) && (!filter.branchId || m.branchId === filter.branchId)
        && (!q || m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || (m.legalName ?? '').toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.code.localeCompare(b.code));
    const p = paginate(all, page);
    return { items: p.items.map(clone), total: p.total };
  }
  async createStore(s: StoreRecord) {
    if ([...this.stores.values()].some((x) => x.merchantId === s.merchantId && x.code === s.code)) throw new DomainError('DUPLICATE_CODE', `store code ${s.code} already exists`);
    const stored = { ...clone(s), version: 1 };
    this.stores.set(s.id, stored);
    return clone(stored);
  }
  async saveStore(s: StoreRecord) {
    const cur = this.stores.get(s.id);
    if (!cur || cur.merchantId !== s.merchantId || cur.orgId !== s.orgId) throw new DomainError('NOT_FOUND', 'store not found');
    if (cur.version !== s.version) throw new DomainError('CONCURRENT_UPDATE', 'store was modified concurrently');
    if ([...this.stores.values()].some((x) => x.id !== s.id && x.merchantId === s.merchantId && x.code === s.code)) throw new DomainError('DUPLICATE_CODE', `store code ${s.code} already exists`);
    const next = { ...clone(s), version: s.version + 1 };
    this.stores.set(s.id, next);
    return clone(next);
  }
  async findStore(merchantId: string, storeId: string) {
    const s = this.stores.get(storeId);
    return s && s.merchantId === merchantId ? clone(s) : null;
  }
  async listStores(merchantId: string) {
    return [...this.stores.values()].filter((s) => s.merchantId === merchantId).sort((a, b) => a.code.localeCompare(b.code)).map(clone);
  }
}

export class InMemoryPlanRepository extends PlanRepository {
  private plans = new Map<string, PlanRecord>();
  async createPlan(p: PlanRecord) {
    if ([...this.plans.values()].some((x) => x.orgId === p.orgId && x.code === p.code)) throw new DomainError('DUPLICATE_CODE', `plan code ${p.code} already exists`);
    const stored = { ...clone(p), version: 1 };
    this.plans.set(p.id, stored);
    return clone(stored);
  }
  async savePlan(p: PlanRecord) {
    const cur = this.plans.get(p.id);
    if (!cur || cur.orgId !== p.orgId) throw new DomainError('NOT_FOUND', 'plan not found');
    if (cur.version !== p.version) throw new DomainError('CONCURRENT_UPDATE', 'plan was modified concurrently');
    if ([...this.plans.values()].some((x) => x.id !== p.id && x.orgId === p.orgId && x.code === p.code)) throw new DomainError('DUPLICATE_CODE', `plan code ${p.code} already exists`);
    const next = { ...clone(p), version: p.version + 1 };
    this.plans.set(p.id, next);
    return clone(next);
  }
  async findPlan(orgId: string, id: string) {
    const p = this.plans.get(id);
    return p && p.orgId === orgId ? clone(p) : null;
  }
  async findPlanByCode(orgId: string, code: string) {
    const p = [...this.plans.values()].find((x) => x.orgId === orgId && x.code === code);
    return p ? clone(p) : null;
  }
  async listPlans(orgId: string, filter: { merchantId?: string; isActive?: boolean }) {
    return [...this.plans.values()]
      .filter((p) => p.orgId === orgId && (filter.merchantId === undefined || p.merchantId === filter.merchantId) && (filter.isActive === undefined || p.isActive === filter.isActive))
      .sort((a, b) => a.code.localeCompare(b.code)).map(clone);
  }
  async listPlansForMerchant(orgId: string, merchantId: string) {
    return [...this.plans.values()].filter((p) => p.orgId === orgId && (p.merchantId === null || p.merchantId === merchantId)).sort((a, b) => a.code.localeCompare(b.code)).map(clone);
  }
}

const SETTLED_STATUSES: PosLeaseStatus[] = ['ACCEPTED', 'DELIVERED', 'SETTLED'];

export class InMemoryLeaseRepository extends LeaseRepository {
  private leases = new Map<string, LeaseRecord>();
  private events: LeaseEventRecord[] = [];
  private seq = 0;
  /** `merchants`: BRANCH_MANAGER-ийн хүрээг мерчантын ОДООГИЙН салбараар (merchant.branch_id) шийдэхэд хэрэгтэй — Prisma-д `merchant` relation filter-тэй ижил. */
  constructor(private readonly merchants: MerchantRepository, private readonly outbox: InMemoryOutbox = new InMemoryOutbox()) { super(); }

  /** orgId/merchantId/storeId-ийн синхрон шүүлт. `branchId`-г inBranch() тусад нь шийднэ. */
  private inScope(l: LeaseRecord, s: LeaseScope) {
    return l.orgId === s.orgId && (!s.merchantId || l.merchantId === s.merchantId) && (!s.storeId || l.storeId === s.storeId);
  }
  /**
   * LeaseScope.branchId = мерчантын ОДООГИЙН салбар (docs/05 §2, §8: `merchant.branch_id = X-Branch-Id`). pos_lease.branch_id нь үүсгэх үеийн түүхэн хуулбар (POS-BR-13) —
   * мерчантыг өөр салбарт шилжүүлбэл хуучин салбарын менежер лизингийг харахаа болино, шинэ салбарынх харна.
   */
  private async inBranch<T extends { orgId: string; merchantId: string }>(rows: T[], branchId: string | undefined): Promise<T[]> {
    if (!branchId) return rows;
    const branchOf = new Map<string, string | undefined>();
    const keep: T[] = [];
    for (const r of rows) {
      const key = `${r.orgId}/${r.merchantId}`;
      if (!branchOf.has(key)) branchOf.set(key, (await this.merchants.findMerchant(r.orgId, r.merchantId))?.branchId);
      if (branchOf.get(key) === branchId) keep.push(r);
    }
    return keep;
  }
  private addEvent(leaseId: string, t: TimelineInput) { this.events.push({ ...clone(t), id: `ev-${++this.seq}`, leaseId }); }

  async insertLease(l: LeaseRecord, timeline: TimelineInput, events: DomainEvent[]) {
    // DB-ийн `pos_lease_version_check CHECK (version >= 1)`-тэй ижил: санах ойн тест version 0-ийг далдалж болохгүй.
    if (!Number.isInteger(l.version) || l.version < 1) throw new Error(`pos_lease_version_check violated: version must be an integer >= 1 (got ${l.version})`);
    const all = [...this.leases.values()];
    if (all.some((x) => x.merchantId === l.merchantId && x.idempotencyKey === l.idempotencyKey)) throw new LeaseKeyConflict('IDEMPOTENCY');
    if (all.some((x) => x.leaseNo === l.leaseNo)) throw new LeaseKeyConflict('LEASE_NO');
    this.leases.set(l.id, clone(l));
    this.addEvent(l.id, timeline);
    this.outbox.push(events);
    return clone(l);
  }
  async saveLease(l: LeaseRecord, timeline: TimelineInput, events: DomainEvent[]) {
    const cur = this.leases.get(l.id);
    if (!cur || cur.orgId !== l.orgId) throw new DomainError('NOT_FOUND', 'lease not found');
    if (cur.version !== l.version) throw new DomainError('CONCURRENT_UPDATE', 'lease was modified concurrently');
    const next = { ...clone(l), version: l.version + 1 };
    this.leases.set(l.id, next);
    this.addEvent(l.id, timeline);
    this.outbox.push(events);
    return clone(next);
  }
  async findLease(scope: LeaseScope, id: string) {
    const l = this.leases.get(id);
    if (!l || !this.inScope(l, scope)) return null;
    return (await this.inBranch([l], scope.branchId)).length ? clone(l) : null;
  }
  async findByIdempotencyKey(merchantId: string, key: string) {
    const l = [...this.leases.values()].find((x) => x.merchantId === merchantId && x.idempotencyKey === key);
    return l ? clone(l) : null;
  }
  async listLeases(scope: LeaseScope, f: LeaseFilter, page: PageArgs) {
    const no = f.leaseNoLike?.toLowerCase();
    const matching = [...this.leases.values()]
      .filter((l) => this.inScope(l, scope)
        && (!f.statuses?.length || f.statuses.includes(l.status))
        && (!f.from || l.createdAt >= f.from) && (!f.to || l.createdAt < f.to)
        && (!no || l.leaseNo.toLowerCase().includes(no))
        && (!f.buyerPhoneSuffix || l.buyerPhone.endsWith(f.buyerPhoneSuffix))
        && (!f.buyerRegisterHash || l.buyerRegisterHash === f.buyerRegisterHash));
    const all = (await this.inBranch(matching, scope.branchId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.leaseNo.localeCompare(a.leaseNo));
    const p = paginate(all, page);
    return { items: p.items.map(clone), total: p.total };
  }
  async timeline(leaseId: string) {
    return this.events.filter((e) => e.leaseId === leaseId).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id, undefined, { numeric: true })).map(clone);
  }
  async dashboardRows(scope: LeaseScope, from: Date, to: Date): Promise<LeaseDashboardRow[]> {
    const inRange = [...this.leases.values()].filter((l) => this.inScope(l, scope) && l.createdAt >= from && l.createdAt < to);
    return (await this.inBranch(inRange, scope.branchId))
      .map((l) => ({
        id: l.id, status: l.status, storeId: l.storeId, planCode: l.planCode, decision: l.decision, createdAt: l.createdAt, decidedAt: l.decidedAt, decidedBy: l.decidedBy, expiresAt: l.expiresAt,
        acceptedAt: l.acceptedAt, deliveredAt: l.deliveredAt, settledAt: l.settledAt, goodsPrice: l.goodsPrice, financedAmount: l.quote.financedAmount,
        merchantCommissionAmount: l.quote.merchantCommissionAmount, merchantNetAmount: l.quote.merchantNetAmount,
      }));
  }
  async sumAcceptedFinanced(merchantId: string, from: Date, to: Date) {
    const sum = [...this.leases.values()]
      .filter((l) => l.merchantId === merchantId && SETTLED_STATUSES.includes(l.status) && l.acceptedAt && l.acceptedAt >= from && l.acceptedAt < to)
      .reduce((s, l) => s + l.quote.financedAmount, 0);
    return Math.round(sum * 100) / 100;
  }
  async listExpirable(now: Date, limit: number) {
    return [...this.leases.values()]
      .filter((l) => (['DRAFT', 'REFERRED', 'APPROVED'] as PosLeaseStatus[]).includes(l.status) && l.expiresAt !== null && l.expiresAt < now)
      .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime()).slice(0, limit).map(clone);
  }
}

export class InMemoryOtpRepository extends OtpRepository {
  private otps = new Map<string, OtpRecord>();
  async insertOtp(o: OtpRecord) { this.otps.set(o.id, clone(o)); return clone(o); }
  async saveOtp(o: OtpRecord) {
    if (this.otps.get(o.id)?.orgId !== o.orgId) throw new DomainError('NOT_FOUND', 'otp not found');
    this.otps.set(o.id, clone(o));
    return clone(o);
  }
  async latestOtp(leaseId: string, purpose: OtpRecord['purpose']) {
    const found = [...this.otps.values()].filter((o) => o.leaseId === leaseId && o.purpose === purpose).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    return found[0] ? clone(found[0]) : null;
  }
  async countOtps(leaseId: string) { return [...this.otps.values()].filter((o) => o.leaseId === leaseId).length; }
  async registerOtpAttempt(otp: Pick<OtpRecord, 'id' | 'orgId'>, maxAttempts: number) {
    const cur = this.otps.get(otp.id);
    if (!cur || cur.orgId !== otp.orgId || cur.verifiedAt || cur.attempts >= maxAttempts) return null;
    cur.attempts += 1; // await-гүй тул атом
    return cur.attempts;
  }
  async markOtpVerified(otp: Pick<OtpRecord, 'id' | 'orgId'>, at: Date) {
    const cur = this.otps.get(otp.id);
    if (!cur || cur.orgId !== otp.orgId || cur.verifiedAt) return false;
    cur.verifiedAt = new Date(at);
    return true;
  }
}

/** Бүх санах ойн repository-г нэг outbox-той холбож үүсгэнэ. */
export function createInMemoryPersistence() {
  const outbox = new InMemoryOutbox();
  const merchants = new InMemoryMerchantRepository(outbox);
  return { outbox, merchants, plans: new InMemoryPlanRepository(), leases: new InMemoryLeaseRepository(merchants, outbox), otps: new InMemoryOtpRepository() };
}
