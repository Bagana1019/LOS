import { MerchantView, Paged, PlanView, PosLeaseAdminView, PosLeaseListItem, StoreView } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWith } from '../testing/expect-schema';
import { merchantInput, storeInput, type Fixtures } from '../testing/fixtures';
import { PosFlow } from '../testing/flow';
import { TestApp } from '../testing/test-app';

const newMerchant = (over: Record<string, unknown> = {}) => ({
  code: 'NEW-SHOP', name: 'Шинэ дэлгүүр ХХК', contactName: 'Б. Болд', phone: '99887766', branchId: 'BR-X', commissionRate: 0.02, maxTicketAmount: 5_000_000,
  settlement: { bankCode: 'KHAN', accountNo: '5099887766', holderName: 'Шинэ дэлгүүр ХХК' }, ...over,
});

describe('back-office — merchants, stores, plans, pos-leases', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
  });
  afterAll(async () => { await t.close(); });

  describe('merchants', () => {
    let created: MerchantView;
    it('POST /merchants creates a PENDING merchant, masks the settlement account and emits no event', async () => {
      const before = t.outbox.events.length;
      const res = await t.postJson('/merchants', f.lender(), newMerchant({ code: ' new-shop ', dailyLimitAmount: 10_000_000, contractNo: 'C-2026-01', contractSignedAt: '2026-10-01T00:00:00Z' }));
      expect(res.status).toBe(201);
      created = parseWith(MerchantView, res.body);
      expect(created).toMatchObject({
        code: 'NEW-SHOP', status: 'PENDING', branchId: 'BR-X', commissionRate: 0.02, maxTicketAmount: 5_000_000, dailyLimitAmount: 10_000_000,
        settlement: { bankCode: 'KHAN', accountMasked: '****7766', holderName: 'Шинэ дэлгүүр ХХК' }, contractNo: 'C-2026-01', contractSignedAt: '2026-10-01T00:00:00.000Z',
      });
      expect(res.text).not.toContain('5099887766'); // дансны бүтэн дугаар хэзээ ч гарахгүй
      expect(t.outbox.events.length).toBe(before);
      // хадгалагдсан дансны дугаар шифрлэгдсэн
      const rec = await t.services.merchants.get({ userId: 'x', roles: ['ADMIN'], orgId: 'org-test', branchId: null, merchantId: null, storeId: null, correlationId: 'c' }, created.id);
      expect(rec.id).toBe(created.id);
    });
    it('rejects a duplicate code with 409 DUPLICATE_CODE', async () => {
      const res = await t.postJson('/merchants', f.lender(), newMerchant());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_CODE');
    });
    it('GET /merchants lists with filters and paging (ADMIN/APPROVER see all)', async () => {
      const all = parseWith(Paged(MerchantView), (await t.getJson('/merchants', f.lender())).body);
      expect(all.total).toBe(3);
      const byStatus = parseWith(Paged(MerchantView), (await t.getJson('/merchants?status=PENDING', f.approver())).body);
      expect(byStatus.items.map((m) => m.code)).toEqual(['NEW-SHOP']);
      const byQ = parseWith(Paged(MerchantView), (await t.getJson(`/merchants?q=${encodeURIComponent('алтан')}`, f.lender())).body);
      expect(byQ.items.map((m) => m.code)).toEqual(['ALTAN-GER']);
      const page = parseWith(Paged(MerchantView), (await t.getJson('/merchants?page=2&pageSize=2', f.lender())).body);
      expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
      expect(page.items).toHaveLength(1);
    });
    it('GET /merchants/:id', async () => {
      const res = await t.getJson(`/merchants/${created.id}`, f.approver());
      expect(res.status).toBe(200);
      expect(parseWith(MerchantView, res.body).id).toBe(created.id);
      expect((await t.getJson('/merchants/00000000-0000-4000-8000-0000000fffff', f.lender())).status).toBe(404);
      expect((await t.getJson('/merchants/not-a-uuid', f.lender())).status).toBe(404);
    });
    it('PATCH /merchants/:id updates fields and re-encrypts the settlement account', async () => {
      const res = await t.patchJson(`/merchants/${created.id}`, f.lender(), {
        name: 'Шинэ дэлгүүр (шинэчлэгдсэн)', commissionRate: 0.025, dailyLimitAmount: null, settlement: { bankCode: 'GOLOMT', accountNo: '1100112233', holderName: 'Шинэ ХХК' },
      });
      expect(res.status).toBe(200);
      const m = parseWith(MerchantView, res.body);
      expect(m).toMatchObject({ name: 'Шинэ дэлгүүр (шинэчлэгдсэн)', commissionRate: 0.025, dailyLimitAmount: null, code: 'NEW-SHOP', settlement: { bankCode: 'GOLOMT', accountMasked: '****2233' } });
      expect(res.text).not.toContain('1100112233');
      expect((await t.patchJson(`/merchants/${created.id}`, f.lender(), { commissionRate: 0.9 })).status).toBe(400);
    });
    it('POST /merchants/:id/status follows the lifecycle and emits MerchantStatusChanged with the reason', async () => {
      const status = (s: string, reason = 'Гэрээ байгуулав') => t.postJson(`/merchants/${created.id}/status`, f.lender(), { status: s, reason });
      const before = t.outbox.events.length;
      expect((await status('SUSPENDED')).body.code).toBe('INVALID_TRANSITION'); // PENDING -> SUSPENDED хориотой
      const active = await status('ACTIVE');
      expect(active.status).toBe(200);
      expect(parseWith(MerchantView, active.body).status).toBe('ACTIVE');
      expect((await status('SUSPENDED', 'Зөрчил илэрсэн')).status).toBe(200);
      expect((await status('ACTIVE', 'Зөрчил арилгасан')).status).toBe(200);
      expect((await status('TERMINATED', 'Гэрээ цуцлагдсан')).status).toBe(200);
      const dead = await status('ACTIVE');
      expect(dead.status).toBe(409);
      expect(dead.body).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'TERMINATED', to: 'ACTIVE' } });
      const events = t.outbox.events.slice(before);
      expect(events.map((e) => e.type)).toEqual(Array(4).fill('MerchantStatusChanged'));
      expect(events.map((e) => [(e as { from: string }).from, (e as { to: string }).to, (e as { reason: string }).reason])).toEqual([
        ['PENDING', 'ACTIVE', 'Гэрээ байгуулав'], ['ACTIVE', 'SUSPENDED', 'Зөрчил илэрсэн'], ['SUSPENDED', 'ACTIVE', 'Зөрчил арилгасан'], ['ACTIVE', 'TERMINATED', 'Гэрээ цуцлагдсан'],
      ]);
      expect(events[0]).toMatchObject({ merchantId: created.id, actorId: 'lender-admin-1', orgId: 'org-test' });
      expect((await status('ACTIVE', 'ab')).status).toBe(400); // шалтгаан ≥ 3 тэмдэгт
      expect((await status('PENDING')).status).toBe(400); // PENDING руу шилжих боломжгүй (схем)
    });
  });

  describe('stores', () => {
    it('POST/GET/PATCH /merchants/:id/stores', async () => {
      const created = await t.postJson(`/merchants/${fx.merchantA.id}/stores`, f.lender(), storeInput({ code: 'store-3', name: 'Гурав дахь дэлгүүр', phone: '77009900' }));
      expect(created.status).toBe(201);
      const s = parseWith(StoreView, created.body);
      expect(s).toMatchObject({ code: 'STORE-3', merchantId: fx.merchantA.id, isActive: true, phone: '77009900' });
      const dup = await t.postJson(`/merchants/${fx.merchantA.id}/stores`, f.lender(), storeInput({ code: 'STORE-3' }));
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('DUPLICATE_CODE');
      const list = await t.getJson(`/merchants/${fx.merchantA.id}/stores`, f.approver());
      expect(list.status).toBe(200);
      expect((list.body as unknown[]).map((x) => parseWith(StoreView, x).code)).toEqual(['STORE-1', 'STORE-2', 'STORE-3']);
      const patched = await t.patchJson(`/merchants/${fx.merchantA.id}/stores/${s.id}`, f.lender(), { name: 'Нэр өөрчлөв', isActive: false });
      expect(patched.status).toBe(200);
      expect(parseWith(StoreView, patched.body)).toMatchObject({ name: 'Нэр өөрчлөв', isActive: false, code: 'STORE-3' });
      expect((await t.patchJson(`/merchants/${fx.merchantA.id}/stores/${fx.storeB1.id}`, f.lender(), { name: 'x y' })).status).toBe(404); // өөр мерчантын дэлгүүр
      expect((await t.postJson(`/merchants/${fx.merchantA.id}/stores`, f.lender(), { code: 'X' })).status).toBe(400);
    });
    it('an inactive store cannot issue leases (STORE_NOT_ACTIVE)', async () => {
      const [store3] = (await t.getJson(`/merchants/${fx.merchantA.id}/stores`, f.lender())).body.filter((x: { code: string }) => x.code === 'STORE-3');
      const res = await f.create({ headers: t.personas(fx.merchantA.id).staff(store3.id, 'staff-3'), storeId: store3.id, seed: 901 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('STORE_NOT_ACTIVE');
    });
  });

  describe('plans', () => {
    const planBody = (over: Record<string, unknown> = {}) => ({
      code: 'NEW-PLAN', name: 'Шинэ хөтөлбөр', goodsCategories: ['ELECTRONICS'], minAmount: 100_000, maxAmount: 5_000_000, termOptions: [12, 6, 3], annualRate: 0.2, ...over,
    });
    let created: PlanView;
    it('POST /pos-plans applies defaults, sorts terms and returns the contract view', async () => {
      const res = await t.postJson('/pos-plans', f.lender(), planBody());
      expect(res.status).toBe(201);
      created = parseWith(PlanView, res.body);
      expect(created).toMatchObject({ code: 'NEW-PLAN', merchantId: null, feeRate: 0, minDownPaymentRate: 0, commissionRate: null, policy: {}, validFrom: null, validTo: null, isActive: true, termOptions: [3, 6, 12] });
    });
    it('validates: unique code, merchant exists, validFrom <= validTo, min <= max', async () => {
      expect((await t.postJson('/pos-plans', f.lender(), planBody())).body.code).toBe('DUPLICATE_CODE');
      const unknownMerchant = await t.postJson('/pos-plans', f.lender(), planBody({ code: 'P-X', merchantId: '00000000-0000-4000-8000-0000000eeeee' }));
      expect(unknownMerchant.status).toBe(400);
      expect(unknownMerchant.body.details.issues[0].path).toBe('merchantId');
      const badDates = await t.postJson('/pos-plans', f.lender(), planBody({ code: 'P-Y', validFrom: '2026-12-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z' }));
      expect(badDates.status).toBe(400);
      expect(badDates.body.details.issues[0].path).toBe('validTo');
      expect((await t.postJson('/pos-plans', f.lender(), planBody({ code: 'P-Z', minAmount: 9_000_000, maxAmount: 1_000_000 }))).status).toBe(400);
      expect((await t.postJson('/pos-plans', f.lender(), planBody({ code: 'P-W', termOptions: [6, 6] }))).status).toBe(400);
    });
    it('GET /pos-plans filters by merchantId and isActive', async () => {
      const own = await t.postJson('/pos-plans', f.lender(), planBody({ code: 'A-ONLY', merchantId: fx.merchantA.id, isActive: false }));
      expect(own.status).toBe(201);
      const all = (await t.getJson('/pos-plans', f.approver())).body as unknown[];
      all.forEach((p) => parseWith(PlanView, p));
      expect(all.length).toBeGreaterThanOrEqual(5);
      const forA = (await t.getJson(`/pos-plans?merchantId=${fx.merchantA.id}`, f.lender())).body as PlanView[];
      expect(forA.map((p) => p.code)).toEqual(['A-ONLY']);
      const inactive = (await t.getJson('/pos-plans?isActive=false', f.lender())).body as PlanView[];
      expect(inactive.map((p) => p.code)).toEqual(['A-ONLY']);
      const active = (await t.getJson('/pos-plans?isActive=true', f.lender())).body as PlanView[];
      expect(active.every((p) => p.isActive)).toBe(true);
      expect((await t.getJson('/pos-plans?isActive=maybe', f.lender())).status).toBe(400);
    });
    it('PATCH /pos-plans/:id merges, re-validates and controls availability to merchants', async () => {
      const res = await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { name: 'Шинэчлэгдсэн', annualRate: 0.18, policy: { maxDti: 0.5 }, feeRate: 0.01 });
      expect(res.status).toBe(200);
      expect(parseWith(PlanView, res.body)).toMatchObject({ name: 'Шинэчлэгдсэн', annualRate: 0.18, policy: { maxDti: 0.5 }, feeRate: 0.01, code: 'NEW-PLAN' });
      expect((await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { minAmount: 9_000_000 })).status).toBe(400); // min > max (нэгтгэсний дараа)
      expect((await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { validFrom: '2026-12-01T00:00:00Z', validTo: '2026-11-01T00:00:00Z' })).status).toBe(400);
      expect((await t.patchJson('/pos-plans/00000000-0000-4000-8000-0000000ddddd', f.lender(), { name: 'xx' })).status).toBe(404);
      // идэвхгүй болгосон / хугацаа нь дуусаагүй хөтөлбөр мерчантад харагдахгүй
      const visible = async () => ((await t.getJson('/merchant-portal/me', f.staff1())).body.plans as { code: string }[]).map((p) => p.code);
      expect(await visible()).toContain('NEW-PLAN');
      await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { isActive: false });
      expect(await visible()).not.toContain('NEW-PLAN');
      await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { isActive: true, validFrom: '2026-11-01T00:00:00Z' }); // ирээдүйд эхлэнэ
      expect(await visible()).not.toContain('NEW-PLAN');
      await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { validFrom: '2026-10-01T00:00:00Z', validTo: '2026-10-28T03:59:59Z' }); // нэг секундийн өмнө дууссан
      expect(await visible()).not.toContain('NEW-PLAN');
      await t.patchJson(`/pos-plans/${created.id}`, f.lender(), { validTo: '2026-10-28T04:00:00Z' }); // яг одоо хүртэл (inclusive)
      expect(await visible()).toContain('NEW-PLAN');
      t.clock.advanceSeconds(1);
      expect(await visible()).not.toContain('NEW-PLAN');
    });
    it("a merchant-specific plan is visible only to that merchant", async () => {
      const mine = await t.postJson('/pos-plans', f.lender(), planBody({ code: 'B-ONLY', merchantId: fx.merchantB.id }));
      expect(mine.status).toBe(201);
      const codesFor = async (headers: Record<string, string>) => ((await t.getJson('/merchant-portal/me', headers)).body.plans as { code: string }[]).map((p) => p.code);
      expect(await codesFor(f.adminB())).toContain('B-ONLY');
      expect(await codesFor(f.admin())).not.toContain('B-ONLY');
      const quote = await t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'B-ONLY', goodsPrice: 1_000_000, downPayment: 100_000, termMonths: 6 });
      expect(quote.status).toBe(422);
      expect(quote.body.code).toBe('PLAN_NOT_AVAILABLE');
    });
  });

  describe('pos-leases (lender view)', () => {
    let referred: string;
    let delivered: string;
    beforeAll(async () => {
      const r = await f.toDecided({ digit: 2, seed: 300 });
      referred = r.id;
      delivered = (await f.toDelivered({ digit: 0, seed: 301 })).id;
    });

    it('GET /pos-leases lists across merchants with filters', async () => {
      await f.toDecided({ digit: 0, seed: 302, headers: t.personas(fx.merchantB.id).staff(fx.storeB1.id, 'staff-b'), storeId: fx.storeB1.id });
      const all = parseWith(Paged(PosLeaseListItem), (await t.getJson('/pos-leases', f.lender())).body);
      expect(all.total).toBeGreaterThanOrEqual(3);
      const onlyB = parseWith(Paged(PosLeaseListItem), (await t.getJson(`/pos-leases?merchantId=${fx.merchantB.id}`, f.lender())).body);
      expect(onlyB.items.every((i) => i.storeId === fx.storeB1.id)).toBe(true);
      const referredOnly = parseWith(Paged(PosLeaseListItem), (await t.getJson('/pos-leases?status=REFERRED', f.approver())).body);
      expect(referredOnly.items.map((i) => i.id)).toContain(referred);
      const byStore = parseWith(Paged(PosLeaseListItem), (await t.getJson(`/pos-leases?storeId=${fx.storeB1.id}`, f.lender())).body);
      expect(byStore.items.every((i) => i.storeId === fx.storeB1.id)).toBe(true);
    });

    it('GET /pos-leases/:id returns the admin view with review details', async () => {
      const v = parseWith(PosLeaseAdminView, (await t.getJson(`/pos-leases/${referred}`, f.lender())).body);
      expect(v).toMatchObject({ status: 'REFERRED', merchantName: 'Тэмүүлэл Дижитал', review: { reasons: [{ code: 'BLACKLISTED', severity: 'REFER' }], dtiRatio: expect.any(Number), comment: null, settlementRef: null, applicationId: null } });
      expect(v.decision).toMatchObject({ result: 'REFER', publicReason: 'MANUAL_REVIEW' });
    });

    it('POST /pos-leases/:id/review requires a comment and only works on REFERRED', async () => {
      expect((await t.postJson(`/pos-leases/${referred}/review`, f.approver(), { decision: 'APPROVE', comment: 'ab' })).status).toBe(400);
      expect((await t.postJson(`/pos-leases/${referred}/review`, f.approver(), { decision: 'MAYBE', comment: 'abcdef' })).status).toBe(400);
      const nonReferred = await f.review(delivered, 'APPROVE');
      expect(nonReferred.status).toBe(409);
      expect(nonReferred.body.code).toBe('INVALID_TRANSITION');
      const ok = await f.review(referred, 'DECLINE', 'Хар жагсаалтад байгаа тул татгалзав');
      expect(ok.status).toBe(200);
      const v = parseWith(PosLeaseAdminView, ok.body);
      expect(v).toMatchObject({ status: 'DECLINED', decision: { result: 'DECLINE', decidedBy: 'REVIEWER', decisionSeconds: null }, expiresAt: null, review: { comment: 'Хар жагсаалтад байгаа тул татгалзав' } });
      expect(v.timeline.at(-1)).toMatchObject({ action: 'REVIEWED', fromStatus: 'REFERRED', toStatus: 'DECLINED', actor: 'LENDER:approver-1' });
      expect((await f.review(referred, 'APPROVE')).body.code).toBe('INVALID_TRANSITION'); // нэг л удаа
    });

    it('POST /pos-leases/:id/settle only for DELIVERED and only once; settle needs ADMIN', async () => {
      expect((await t.postJson(`/pos-leases/${delivered}/settle`, f.approver(), { settlementRef: 'PAY-1' })).status).toBe(403);
      expect((await t.postJson(`/pos-leases/${delivered}/settle`, f.lender(), { settlementRef: 'x' })).status).toBe(400);
      const ok = await f.settle(delivered, 'PAY-2026-7777');
      expect(ok.status).toBe(200);
      expect(parseWith(PosLeaseAdminView, ok.body)).toMatchObject({ status: 'SETTLED', review: { settlementRef: 'PAY-2026-7777' } });
      expect((await f.settle(delivered)).body.code).toBe('INVALID_TRANSITION');
      const undelivered = await f.toDecided({ digit: 0, seed: 303 });
      expect((await f.settle(undelivered.id)).body.code).toBe('INVALID_TRANSITION');
    });

    it('unknown leases are 404', async () => {
      expect((await t.getJson('/pos-leases/00000000-0000-4000-8000-0000000fffff', f.lender())).status).toBe(404);
      expect((await f.review('00000000-0000-4000-8000-0000000fffff', 'APPROVE')).status).toBe(404);
      expect((await f.settle('00000000-0000-4000-8000-0000000fffff')).status).toBe(404);
    });
  });

  it('merchantInput fixture is a valid MerchantCreate body (sanity)', () => {
    expect(merchantInput().settlement.accountNo).toBe('5012345678');
  });
});
