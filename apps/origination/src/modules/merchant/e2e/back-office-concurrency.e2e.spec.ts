import { MerchantView, PlanView, StoreView } from '@los/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY_OUTBOX } from '../merchant.module';
import { InMemoryMerchantRepository, InMemoryOutbox, InMemoryPlanRepository } from '../persistence/memory/in-memory';
import { MerchantRepository, PlanRepository } from '../persistence/repositories';
import type { Fixtures } from '../testing/fixtures';
import { PosFlow } from '../testing/flow';
import { FindGate, GatedMerchantRepository, GatedPlanRepository } from '../testing/gated-repositories';
import { parseWith } from '../testing/expect-schema';
import { TestApp } from '../testing/test-app';

// Optimistic lock (merchant / merchant_store / pos_lease_plan `version`): load → save хооронд өөр хүсэлт мөрийг өөрчилбөл хоцорсон хүсэлт 409 CONCURRENT_UPDATE авна,
// гэхдээ хожуу commit-лосон өөрчлөлтийг (статус, данс, идэвхтэй эсэх) ХЭЗЭЭ Ч буцаахгүй (POS-BR-10).
describe('back-office concurrent updates (optimistic lock)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  let gate: FindGate;
  let outbox: InMemoryOutbox;

  beforeEach(async () => {
    gate = new FindGate();
    outbox = new InMemoryOutbox();
    t = await TestApp.create({
      overrides: [
        { provide: IN_MEMORY_OUTBOX, useValue: outbox },
        { provide: MerchantRepository, useValue: new GatedMerchantRepository(new InMemoryMerchantRepository(outbox), gate) },
        { provide: PlanRepository, useValue: new GatedPlanRepository(new InMemoryPlanRepository(), gate) },
      ],
    });
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
    outbox.events.length = 0; // fixture-ийн ACTIVE болгосон event-үүдийг хасна
  });
  afterEach(async () => { await t.close(); });

  const statusOf = async (id: string) => parseWith(MerchantView, (await t.getJson(`/merchants/${id}`, f.lender())).body);
  const statusEvents = () => outbox.events.filter((e) => e.type === 'MerchantStatusChanged').map((e) => (e.type === 'MerchantStatusChanged' ? `${e.from}>${e.to}` : ''));

  describe('merchants', () => {
    it('a PATCH loaded before a SUSPEND cannot put the merchant back to ACTIVE (and the event stream stays consistent)', async () => {
      const { reached, release } = gate.arm('findMerchant');
      const stalePatch = t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { name: 'Stale нэр' });
      await reached; // PATCH ACTIVE мөрийг уншаад хүлээж байна
      const suspend = await t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status: 'SUSPENDED', reason: 'Эрсдэлийн шалгалт' });
      expect(suspend.status).toBe(200);
      release();
      const res = await stalePatch;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_UPDATE');
      const m = await statusOf(fx.merchantA.id);
      expect(m.status).toBe('SUSPENDED');
      expect(m.name).toBe(fx.merchantA.name);
      expect(statusEvents()).toEqual(['ACTIVE>SUSPENDED']);
    });

    it('a stale SUSPEND cannot turn a TERMINATED merchant into SUSPENDED (terminal state, one event only)', async () => {
      const { reached, release } = gate.arm('findMerchant');
      const staleSuspend = t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status: 'SUSPENDED', reason: 'Түр зогсоох' });
      await reached;
      const terminate = await t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status: 'TERMINATED', reason: 'Гэрээ цуцалсан' });
      expect(terminate.status).toBe(200);
      release();
      const res = await staleSuspend;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_UPDATE');
      expect((await statusOf(fx.merchantA.id)).status).toBe('TERMINATED');
      expect(statusEvents()).toEqual(['ACTIVE>TERMINATED']);
      // дахин оролдоход (шинэ уншилт) эцсийн төлвөөс гарах шилжилт хориотой
      const retry = await t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status: 'SUSPENDED', reason: 'Түр зогсоох' });
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('INVALID_TRANSITION');
    });

    it('a status change loaded before a payout-account PATCH cannot revert the new account', async () => {
      const { reached, release } = gate.arm('findMerchant');
      const staleStatus = t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status: 'SUSPENDED', reason: 'Шалгалт' });
      await reached;
      const patch = await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { settlement: { bankCode: 'TDB', accountNo: '4400099999', holderName: 'Шинэ эзэмшигч ХХК' } });
      expect(patch.status).toBe(200);
      release();
      const res = await staleStatus;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_UPDATE');
      const m = await statusOf(fx.merchantA.id);
      expect(m.settlement).toEqual({ bankCode: 'TDB', accountMasked: '****9999', holderName: 'Шинэ эзэмшигч ХХК' });
      expect(m.status).toBe('ACTIVE');
      expect(statusEvents()).toEqual([]); // амжилтгүй хүсэлтийн event outbox-д ороогүй
    });

    it('after a 409 the client retries and succeeds; sequential updates never conflict and the API never exposes the version', async () => {
      const { reached, release } = gate.arm('findMerchant');
      const stale = t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { contactName: 'Эхний' });
      await reached;
      await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { phone: '99887766' });
      release();
      expect((await stale).status).toBe(409);
      const retry = await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { contactName: 'Эхний' });
      expect(retry.status).toBe(200);
      for (const name of ['Нэр A', 'Нэр B', 'Нэр C']) expect((await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { name })).status).toBe(200);
      const m = await statusOf(fx.merchantA.id);
      expect(m).toMatchObject({ name: 'Нэр C', contactName: 'Эхний', phone: '99887766' }); // 2 PATCH-ийн өөрчлөлт хоёулаа хадгалагдсан
      expect(JSON.stringify(retry.body)).not.toMatch(/version/i);
    });
  });

  describe('stores', () => {
    it('a store PATCH loaded before another PATCH cannot revert isActive', async () => {
      const url = `/merchants/${fx.merchantA.id}/stores/${fx.storeA2.id}`;
      const { reached, release } = gate.arm('findStore');
      const stale = t.patchJson(url, f.lender(), { name: 'Stale нэр' });
      await reached;
      expect((await t.patchJson(url, f.lender(), { isActive: false })).status).toBe(200);
      release();
      const res = await stale;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_UPDATE');
      const stores = (await t.getJson(`/merchants/${fx.merchantA.id}/stores`, f.lender())).body as unknown[];
      const store = stores.map((s) => parseWith(StoreView, s)).find((s) => s.id === fx.storeA2.id)!;
      expect(store).toMatchObject({ isActive: false, name: fx.storeA2.name });
    });
  });

  describe('plans', () => {
    it('a plan PATCH loaded before a deactivation cannot reactivate it', async () => {
      const url = `/pos-plans/${fx.laptop.id}`;
      const { reached, release } = gate.arm('findPlan');
      const stale = t.patchJson(url, f.lender(), { name: 'Stale нэр' });
      await reached;
      expect((await t.patchJson(url, f.lender(), { isActive: false })).status).toBe(200);
      release();
      const res = await stale;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_UPDATE');
      const plan = (await t.getJson('/pos-plans', f.lender())).body.map((p: unknown) => parseWith(PlanView, p)).find((p: PlanView) => p.id === fx.laptop.id)!;
      expect(plan).toMatchObject({ isActive: false, name: fx.laptop.name });
    });
  });
});
