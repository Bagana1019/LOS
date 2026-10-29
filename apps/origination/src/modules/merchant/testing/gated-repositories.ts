import type { DomainEvent, MerchantStatus } from '@los/contracts';
import type { MerchantRecord, PlanRecord, StoreRecord } from '../domain/records';
import { MerchantRepository, PlanRepository, type PageArgs } from '../persistence/repositories';

// Тест: load → save хоорондох уралдааг ТОДОРХОЙ дарааллаар үүсгэнэ. Нэг удаагийн "хаалга" нь сонгосон find дуудлагын үр дүнийг
// (одоогийн мөрийн хуулбар) барьж, release() хүртэл буцаахгүй → тэр хооронд өөр хүсэлт мөрийг өөрчилж болно, дараа нь хоцрогдсон хуулбараар save хийгдэнэ.

export type GateTarget = 'findMerchant' | 'findStore' | 'findPlan';

export class FindGate {
  private target: GateTarget | null = null;
  private hold: Promise<void> = Promise.resolve();
  private reachedFn: (() => void) | null = null;
  private releaseFn: (() => void) | null = null;

  /** Дараагийн `target` дуудлагыг барина. `reached` = хүсэлт мөрийг уншаад хаалганд хүрсэн; `release()` = үргэлжлүүлнэ. */
  arm(target: GateTarget): { reached: Promise<void>; release: () => void } {
    this.target = target;
    const reached = new Promise<void>((resolve) => { this.reachedFn = resolve; });
    this.hold = new Promise<void>((resolve) => { this.releaseFn = resolve; });
    return { reached, release: () => this.releaseFn?.() };
  }

  async pass<T>(target: GateTarget, value: T): Promise<T> {
    if (this.target !== target) return value;
    this.target = null; // нэг удаагийн
    this.reachedFn?.();
    await this.hold;
    return value;
  }
}

/** MerchantRepository-г бүрэн дамжуулж, `findMerchant` / `findStore`-ийг хаалгаар барьж болно. */
export class GatedMerchantRepository extends MerchantRepository {
  constructor(private readonly inner: MerchantRepository, private readonly gate: FindGate) { super(); }
  createMerchant(m: MerchantRecord, events: DomainEvent[]) { return this.inner.createMerchant(m, events); }
  saveMerchant(m: MerchantRecord, events: DomainEvent[]) { return this.inner.saveMerchant(m, events); }
  async findMerchant(orgId: string, id: string) { return this.gate.pass('findMerchant', await this.inner.findMerchant(orgId, id)); }
  listMerchants(orgId: string, filter: { status?: MerchantStatus; q?: string; branchId?: string }, page: PageArgs) { return this.inner.listMerchants(orgId, filter, page); }
  createStore(s: StoreRecord) { return this.inner.createStore(s); }
  saveStore(s: StoreRecord) { return this.inner.saveStore(s); }
  async findStore(merchantId: string, storeId: string) { return this.gate.pass('findStore', await this.inner.findStore(merchantId, storeId)); }
  listStores(merchantId: string) { return this.inner.listStores(merchantId); }
}

/** PlanRepository-г бүрэн дамжуулж, `findPlan`-ийг хаалгаар барьж болно. */
export class GatedPlanRepository extends PlanRepository {
  constructor(private readonly inner: PlanRepository, private readonly gate: FindGate) { super(); }
  createPlan(p: PlanRecord) { return this.inner.createPlan(p); }
  savePlan(p: PlanRecord) { return this.inner.savePlan(p); }
  async findPlan(orgId: string, id: string) { return this.gate.pass('findPlan', await this.inner.findPlan(orgId, id)); }
  findPlanByCode(orgId: string, code: string) { return this.inner.findPlanByCode(orgId, code); }
  listPlans(orgId: string, filter: { merchantId?: string; isActive?: boolean }) { return this.inner.listPlans(orgId, filter); }
  listPlansForMerchant(orgId: string, merchantId: string) { return this.inner.listPlansForMerchant(orgId, merchantId); }
}
