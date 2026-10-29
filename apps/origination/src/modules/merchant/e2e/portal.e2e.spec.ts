import { quotePosLease } from '@los/calc';
import {
  MerchantDashboard, MerchantProfile, OtpSent, Paged, PosLeaseListItem, PosLeaseAdminView, PosLeaseView, PosLeaseWithOtp, PosQuote,
} from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskRegister } from '../common/masking';
import { parseWith } from '../testing/expect-schema';
import { buyerPhone, buyerRegister, leaseBody, type Fixtures } from '../testing/fixtures';
import { FIXED_OTP, PosFlow } from '../testing/flow';
import { TestApp } from '../testing/test-app';

describe('merchant portal — every route and the happy path', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
  });
  afterAll(async () => { await t.close(); });

  it('GET /merchant-portal/me — cashier sees only its own store, admin sees all', async () => {
    const staff = parseWith(MerchantProfile, (await t.getJson('/merchant-portal/me', f.staff1())).body);
    expect(staff).toMatchObject({ role: 'MERCHANT_STAFF', currentStoreId: fx.storeA1.id, merchant: { id: fx.merchantA.id, code: 'TEMUULEL', status: 'ACTIVE', maxTicketAmount: 15_000_000, dailyLimitAmount: 50_000_000 } });
    expect(staff.stores.map((s) => s.id)).toEqual([fx.storeA1.id]);
    expect(staff.plans.map((p) => p.code).sort()).toEqual(['GAMES', 'LAPTOP', 'PROMO0']);
    const admin = parseWith(MerchantProfile, (await t.getJson('/merchant-portal/me', f.admin())).body);
    expect(admin).toMatchObject({ role: 'MERCHANT_ADMIN', currentStoreId: null });
    expect(admin.stores.map((s) => s.id).sort()).toEqual([fx.storeA1.id, fx.storeA2.id].sort());
  });

  it('POST /merchant-portal/quotes — server computed, matches @los/calc', async () => {
    const res = await t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, goodsCategory: 'COMPUTER' });
    expect(res.status).toBe(200);
    const quote = parseWith(PosQuote, res.body);
    expect(quote).toEqual(quotePosLease({ planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, annualRate: 0.24, feeRate: 0.01, commissionRate: 0.03 }));
    expect(quote).toMatchObject({ financedAmount: 2_400_000, feeAmount: 24_000, principal: 2_424_000, monthlyPayment: 229_212.46, merchantCommissionAmount: 72_000, merchantNetAmount: 2_328_000 });
  });

  it('a plan commission rate overrides the merchant commission rate', async () => {
    const plan = await t.postJson('/pos-plans', f.lender(), {
      code: 'LOWCOMM', name: 'Тусгай шимтгэл', goodsCategories: ['COMPUTER'], minAmount: 100_000, maxAmount: 10_000_000, termOptions: [12], annualRate: 0.2, commissionRate: 0.05,
    });
    expect(plan.status).toBe(201);
    const res = await t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LOWCOMM', goodsPrice: 1_000_000, downPayment: 0, termMonths: 12 });
    expect(parseWith(PosQuote, res.body)).toMatchObject({ merchantCommissionRate: 0.05, merchantCommissionAmount: 50_000, merchantNetAmount: 950_000 });
  });

  it('full lifecycle DRAFT -> APPROVED -> ACCEPTED -> DELIVERED -> SETTLED with ordered outbox events', async () => {
    const before = t.outbox.events.length;
    const smsBefore = t.sms.sent.length;

    // 1. create
    const created = await f.create({ digit: 0, seed: 100 });
    expect(created.status).toBe(201);
    const withOtp = parseWith(PosLeaseWithOtp, created.body);
    const lease = withOtp.lease;
    expect(lease).toMatchObject({
      status: 'DRAFT', planCode: 'LAPTOP', storeId: fx.storeA1.id, storeName: 'Төв дэлгүүр', consentVerifiedAt: null,
      buyer: { registerMasked: maskRegister(buyerRegister(0, 100)), phoneMasked: '99****00', fullName: null },
      decision: { result: null, publicReason: null, decidedAt: null, decidedBy: null, decisionSeconds: null },
      allowedActions: ['SUBMIT', 'RESEND_CONSENT_OTP', 'CANCEL'],
    });
    expect(lease.leaseNo).toMatch(/^POS-261028-[0-9A-Z]{6}$/);
    expect(withOtp.otp).toMatchObject({ purpose: 'CONSENT', phoneMasked: '99****00' });
    expect(t.sms.sent).toHaveLength(smsBefore + 1);
    expect(t.sms.sent.at(-1)!.to).toBe(buyerPhone(100));
    expect(created.headers['x-correlation-id']).toBeTruthy();

    // 2. GET + list
    const got = parseWith(PosLeaseView, (await f.get(lease.id)).body);
    expect(got.id).toBe(lease.id);
    const list = parseWith(Paged(PosLeaseListItem), (await t.getJson('/merchant-portal/leases', f.staff1())).body);
    expect(list.items.some((i) => i.id === lease.id)).toBe(true);
    expect(list.items.find((i) => i.id === lease.id)).toMatchObject({ status: 'DRAFT', buyerName: null, buyerRegisterMasked: maskRegister(buyerRegister(0, 100)), storeName: 'Төв дэлгүүр' });

    // 3. submit -> APPROVED
    t.clock.advanceSeconds(12);
    const approved = parseWith(PosLeaseView, (await f.submit(lease.id)).body);
    expect(approved).toMatchObject({
      status: 'APPROVED', consentVerifiedAt: expect.any(String), buyer: { fullName: 'Тест Харилцагч' },
      decision: { result: 'APPROVE', publicReason: null, suggestedMinDownPayment: null, decidedBy: 'SYSTEM', decisionSeconds: 12 },
      allowedActions: ['REQUEST_ACCEPT_OTP', 'ACCEPT', 'CANCEL'],
    });
    expect(approved.expiresAt).toBe(new Date(t.clock.now().getTime() + 30 * 60_000).toISOString());

    // 4. accept otp + accept -> ACCEPTED
    t.clock.advanceSeconds(40);
    const acceptOtp = parseWith(OtpSent, (await f.acceptOtp(lease.id)).body);
    expect(acceptOtp.purpose).toBe('ACCEPT');
    const accepted = parseWith(PosLeaseView, (await f.accept(lease.id)).body);
    expect(accepted).toMatchObject({ status: 'ACCEPTED', expiresAt: null, acceptedAt: t.clock.now().toISOString(), allowedActions: ['DELIVER', 'CANCEL'] });

    // 5. deliver -> DELIVERED
    t.clock.advanceMinutes(5);
    const delivered = parseWith(PosLeaseView, (await f.deliver(lease.id, { serialNo: 'SN-REAL-77' })).body);
    expect(delivered).toMatchObject({ status: 'DELIVERED', goods: { serialNo: 'SN-REAL-77' }, deliveredAt: t.clock.now().toISOString(), allowedActions: [] });

    // 6. settle (back-office) -> SETTLED
    const settled = parseWith(PosLeaseAdminView, (await f.settle(lease.id, 'PAY-2026-1001')).body);
    expect(settled).toMatchObject({ status: 'SETTLED', merchantName: 'Тэмүүлэл Дижитал', review: { settlementRef: 'PAY-2026-1001', comment: null } });

    // timeline
    expect(settled.timeline.map((e) => [e.action, e.fromStatus, e.toStatus, e.actor])).toEqual([
      ['CREATED', null, 'DRAFT', 'MERCHANT:staff-1'],
      ['CONSENT_VERIFIED', 'DRAFT', 'DRAFT', 'BUYER'],
      ['DECIDED', 'DRAFT', 'APPROVED', 'SYSTEM'],
      ['ACCEPTED', 'APPROVED', 'ACCEPTED', 'BUYER'],
      ['DELIVERED', 'ACCEPTED', 'DELIVERED', 'MERCHANT:staff-1'],
      ['SETTLED', 'DELIVERED', 'SETTLED', 'LENDER:lender-admin-1'],
    ]);

    // outbox: нэг tx-д бичигдсэн event-үүд дарааллаараа
    const events = t.outbox.events.slice(before);
    expect(events.map((e) => e.type)).toEqual(['PosLeaseDecided', 'PosLeaseAccepted', 'PosLeaseDelivered', 'PosLeaseSettled']);
    expect(events[0]).toMatchObject({ decision: 'APPROVE', decidedBy: 'SYSTEM', financedAmount: 2_400_000, decisionSeconds: 12, leaseId: lease.id, leaseNo: lease.leaseNo, merchantId: fx.merchantA.id, actorId: 'staff-1', orgId: 'org-test' });
    expect(events[1]).toMatchObject({ financedAmount: 2_400_000, principal: 2_424_000, termMonths: 12, annualRate: 0.24, monthlyPayment: 229_212.46 });
    expect(events[2]).toMatchObject({ netAmount: 2_328_000, commissionAmount: 72_000 });
    expect(events[3]).toMatchObject({ netAmount: 2_328_000, settlementRef: 'PAY-2026-1001', actorId: 'lender-admin-1' });
    expect(events.every((e) => typeof e.correlationId === 'string' && e.correlationId.length > 0)).toBe(true);
  });

  it('POST /merchant-portal/leases/:id/otp/consent — resend respects the cooldown', async () => {
    const lease = await f.createOk({ seed: 101 });
    const tooSoon = await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1());
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body).toMatchObject({ code: 'OTP_RESEND_TOO_SOON', details: { retryAfterSeconds: 30 } });
    t.clock.advanceSeconds(30);
    const again = await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1());
    expect(again.status).toBe(200);
    expect(parseWith(OtpSent, again.body)).toMatchObject({ purpose: 'CONSENT', phoneMasked: '99****01' });
    expect((await f.submit(lease.id)).status).toBe(200);
    // зөвшөөрөл баталгаажсан тул дахин илгээх боломжгүй
    t.clock.advanceSeconds(60);
    const after = await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1());
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('INVALID_TRANSITION');
  });

  it('POST /merchant-portal/leases/:id/cancel — cancels an open lease and emits PosLeaseCancelled', async () => {
    const lease = await f.createOk({ seed: 102 });
    const res = await f.cancel(lease.id, 'Худалдан авагч бодлоо өөрчилсөн');
    expect(res.status).toBe(200);
    const view = parseWith(PosLeaseView, res.body);
    expect(view).toMatchObject({ status: 'CANCELLED', cancelReason: 'Худалдан авагч бодлоо өөрчилсөн', allowedActions: [] });
    expect(view.cancelledAt).toBe(t.clock.now().toISOString());
    expect(t.outbox.events.at(-1)).toMatchObject({ type: 'PosLeaseCancelled', leaseId: lease.id, fromStatus: 'DRAFT', reason: 'Худалдан авагч бодлоо өөрчилсөн' });
    expect((await f.cancel(lease.id)).status).toBe(409); // дахин цуцлах боломжгүй
  });

  it('cancel is possible from REFERRED, APPROVED and ACCEPTED', async () => {
    const referred = await f.toDecided({ digit: 2 });
    expect(referred.status).toBe('REFERRED');
    expect(parseWith(PosLeaseView, (await f.cancel(referred.id)).body).status).toBe('CANCELLED');
    const approved = await f.toDecided({ digit: 0 });
    expect(parseWith(PosLeaseView, (await f.cancel(approved.id)).body).status).toBe('CANCELLED');
    const accepted = await f.toAccepted({ digit: 9 });
    expect(parseWith(PosLeaseView, (await f.cancel(accepted.id)).body).status).toBe('CANCELLED');
    const delivered = await f.toDelivered({ digit: 0 });
    expect((await f.cancel(delivered.id)).body.code).toBe('INVALID_TRANSITION'); // DELIVERED-ийг цуцлах боломжгүй
  });

  it('GET /merchant-portal/leases — filters by status, store, search and paginates', async () => {
    const r = new PosFlow(t, fx);
    const mine = await r.toDecided({ digit: 3, seed: 150 }); // DECLINED
    const url = (q: string) => `/merchant-portal/leases?${q}`;
    const byStatus = parseWith(Paged(PosLeaseListItem), (await t.getJson(url('status=DECLINED'), r.staff1())).body);
    expect(byStatus.items.length).toBeGreaterThan(0);
    expect(byStatus.items.every((i) => i.status === 'DECLINED')).toBe(true);
    const multi = parseWith(Paged(PosLeaseListItem), (await t.getJson(url('status=DECLINED,CANCELLED'), r.staff1())).body);
    expect(multi.items.every((i) => ['DECLINED', 'CANCELLED'].includes(i.status))).toBe(true);
    const byNo = parseWith(Paged(PosLeaseListItem), (await t.getJson(url(`q=${mine.leaseNo}`), r.staff1())).body);
    expect(byNo.items.map((i) => i.id)).toContain(mine.id);
    const byPhone = parseWith(Paged(PosLeaseListItem), (await t.getJson(url(`q=${buyerPhone(150).slice(-6)}`), r.staff1())).body);
    expect(byPhone.items.map((i) => i.id)).toEqual([mine.id]);
    const byRegister = parseWith(Paged(PosLeaseListItem), (await t.getJson(url(`q=${encodeURIComponent(buyerRegister(3, 150).toLowerCase())}`), r.staff1())).body);
    expect(byRegister.items.map((i) => i.id)).toEqual([mine.id]);
    expect(byRegister.items[0]).toMatchObject({ buyerName: 'Тест Харилцагч', publicReason: 'CREDIT_POLICY' });
    const tooShort = parseWith(Paged(PosLeaseListItem), (await t.getJson(url('q=PO'), r.staff1())).body);
    expect(tooShort.total).toBeGreaterThan(1); // 3-аас богино хайлт үл тооцогдоно
    const p1 = parseWith(Paged(PosLeaseListItem), (await t.getJson(url('page=1&pageSize=2'), r.staff1())).body);
    expect(p1).toMatchObject({ page: 1, pageSize: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = parseWith(Paged(PosLeaseListItem), (await t.getJson(url('page=2&pageSize=2'), r.staff1())).body);
    expect(p2.items.map((i) => i.id)).not.toEqual(p1.items.map((i) => i.id));
    const future = parseWith(Paged(PosLeaseListItem), (await t.getJson(url('from=2030-01-01T00:00:00Z'), r.staff1())).body);
    expect(future.total).toBe(0);
    const adminOther = parseWith(Paged(PosLeaseListItem), (await t.getJson(url(`storeId=${fx.storeA2.id}`), r.admin())).body);
    expect(adminOther.items.every((i) => i.storeId === fx.storeA2.id)).toBe(true);
  });

  it('GET /merchant-portal/dashboard — parses the contract and reflects the flow', async () => {
    const res = await t.getJson('/merchant-portal/dashboard', f.admin());
    expect(res.status).toBe(200);
    const d = parseWith(MerchantDashboard, res.body);
    expect(d.totals.requests).toBeGreaterThanOrEqual(1);
    expect(d.totals.settled).toBeGreaterThanOrEqual(1);
    expect(d.totals.financedAmount).toBeGreaterThanOrEqual(2_400_000);
    expect(d.daily.at(-1)!.date).toBe('2026-10-28');
    expect(d.daily).toHaveLength(30);
    expect(d.limits).toMatchObject({ maxTicketAmount: 15_000_000, dailyLimitAmount: 50_000_000 });
    expect(d.limits.dailyUsedAmount).toBeGreaterThanOrEqual(2_400_000);
    expect(d.recent.length).toBeLessThanOrEqual(8);
    expect(d.range.to).toBe(t.clock.now().toISOString());
    expect(d.byStore.map((s) => s.storeName)).toEqual(expect.arrayContaining(['Төв дэлгүүр', 'Салбар дэлгүүр']));
  });

  it('dashboard: STAFF is forced to its own store; ADMIN may filter by store; range limits', async () => {
    const staff2Own = parseWith(MerchantDashboard, (await t.getJson(`/merchant-portal/dashboard?storeId=${fx.storeA1.id}`, f.staff2())).body);
    expect(staff2Own.totals.requests).toBe(0); // store 1-ийг асуусан ч албадан store 2
    expect(staff2Own.byStore.map((s) => s.storeId)).toEqual([fx.storeA2.id]);
    const adminStore1 = parseWith(MerchantDashboard, (await t.getJson(`/merchant-portal/dashboard?storeId=${fx.storeA1.id}`, f.admin())).body);
    expect(adminStore1.totals.requests).toBeGreaterThan(0);
    expect(adminStore1.byStore.map((s) => s.storeId)).toEqual([fx.storeA1.id]);
    const foreignStore = await t.getJson(`/merchant-portal/dashboard?storeId=${fx.storeB1.id}`, f.admin());
    expect(foreignStore.status).toBe(404);
    const tooLong = await t.getJson('/merchant-portal/dashboard?from=2026-01-01T00:00:00Z&to=2026-10-28T04:00:00Z', f.admin());
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('VALIDATION_FAILED');
    const inverted = await t.getJson('/merchant-portal/dashboard?from=2026-10-28T04:00:00Z&to=2026-10-01T00:00:00Z', f.admin());
    expect(inverted.status).toBe(400);
    const custom = parseWith(MerchantDashboard, (await t.getJson('/merchant-portal/dashboard?from=2026-10-26T00:00:00%2B08:00&to=2026-10-28T04:00:00Z', f.admin())).body);
    expect(custom.daily.map((x) => x.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
  });

  it('submit without leaving the consent step is rejected until the code is correct', async () => {
    const lease = await f.createOk({ seed: 103 });
    expect((await f.submit(lease.id, null)).body.code).toBe('CONSENT_REQUIRED');
    expect((await f.submit(lease.id, '000000')).body).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 2 } });
    expect((await f.submit(lease.id, FIXED_OTP)).status).toBe(200);
    // зөвшөөрөл баталгаажсан → дахин submit хориотой (APPROVED)
    expect((await f.submit(lease.id, FIXED_OTP)).body.code).toBe('INVALID_TRANSITION');
  });

  it('every successful lease JSON parses with the contract (create body with extra unknown fields is tolerated)', async () => {
    const body = { ...leaseBody(fx.storeA1.id, 0, {}, 160), unknownField: 'ignored' };
    const res = await t.postJson('/merchant-portal/leases', f.staff1(), body, { 'idempotency-key': 'idem-extra-fields' });
    expect(res.status).toBe(201);
    parseWith(PosLeaseWithOtp, res.body);
  });
});
