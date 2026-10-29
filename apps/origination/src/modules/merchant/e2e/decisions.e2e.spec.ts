import { PosLeaseAdminView, PosLeaseView, PosQuote } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWith } from '../testing/expect-schema';
import { buyerRegister, type Fixtures } from '../testing/fixtures';
import { FIXED_OTP, PosFlow } from '../testing/flow';
import { TestApp } from '../testing/test-app';

// POS-BR-6: мерчантад ил гарч болохгүй дотоод мэдээлэл
const INTERNAL = /blacklist|BLACKLIST|dpd|DPD|dti|DTI|"affordability"|screening|SCREENING|fico|FICO|\bpep\b|\bPEP\b|income|INCOME|severity|maxMonthly|maxFinanced|decisionReasons|reasons/;

describe('instant decisions (APPROVE / REFER / DECLINE)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
  });
  afterAll(async () => { await t.close(); });

  const merchantBodiesSince = (mark: number) => t.transcript.slice(mark).filter((l) => l.includes(' /merchant-portal/')).join('\n');

  it('DECLINE (mock digit 3: 120 days past due) shows only the public reason and leaks nothing internal', async () => {
    const mark = t.transcript.length;
    const lease = await f.createOk({ digit: 3, seed: 10 });
    const decided = parseWith(PosLeaseView, (await f.submit(lease.id)).body);
    expect(decided).toMatchObject({
      status: 'DECLINED', expiresAt: null, allowedActions: [], buyer: { fullName: 'Тест Харилцагч' },
      decision: { result: 'DECLINE', publicReason: 'CREDIT_POLICY', suggestedMinDownPayment: null, decidedBy: 'SYSTEM' },
    });
    await f.get(lease.id);
    await t.getJson('/merchant-portal/leases', f.staff1());
    await t.getJson('/merchant-portal/dashboard', f.staff1());
    await t.getJson('/merchant-portal/leases?q=' + lease.leaseNo, f.admin());
    const bodies = merchantBodiesSince(mark);
    expect(bodies.length).toBeGreaterThan(500);
    expect(bodies).not.toMatch(INTERNAL);
    // нэмэлт: ямар ч талбарт дотоод шалтгааны код байхгүй
    for (const code of ['DPD_EXCEEDED', 'FICO_TOO_LOW', 'DTI_EXCEEDED', 'BLACKLISTED', 'INCOME_UNVERIFIED', 'MOCK_BLACKLIST']) expect(bodies).not.toContain(code);
    // харин лизингийн байгууллагад харагдана
    const admin = await f.adminView(lease.id);
    expect(admin.review.reasons).toEqual([{ code: 'DPD_EXCEEDED', severity: 'DECLINE' }]);
    expect(admin.review.dtiRatio).toBeCloseTo(0.1517, 3); // (229 212.46 + 150 000) / 2 500 000
    // эцсийн төлөвөөс үйлдэл хийх боломжгүй
    expect((await f.acceptOtp(lease.id)).body.code).toBe('INVALID_TRANSITION');
    expect((await f.cancel(lease.id)).body.code).toBe('INVALID_TRANSITION');
    expect(f.eventTypes(lease.id)).toEqual(['PosLeaseDecided']);
    expect(t.outbox.events.at(-1)).toMatchObject({ decision: 'DECLINE', decidedBy: 'SYSTEM' });
  });

  it('DECLINE publicReason by cause: AFFORDABILITY (hard DTI), ELIGIBILITY (age)', async () => {
    const hard = parseWith(PosLeaseView, (await f.submit((await f.createOk({ digit: 1, seed: 11, over: { goods: { category: 'COMPUTER', name: 'Дэлгүүрийн сервер', price: 5_000_000 }, downPayment: 500_000 } })).id)).body);
    expect(hard).toMatchObject({ status: 'DECLINED', decision: { result: 'DECLINE', publicReason: 'AFFORDABILITY' } });
    expect(hard.decision.suggestedMinDownPayment).toBeGreaterThan(500_000); // ӨОХ-оос шалтгаалсан тул урьдчилгааны санал харагдана
    const underage = parseWith(PosLeaseView, (await f.submit((await f.createOk({ digit: 0, seed: 12, over: { buyer: { registerNo: 'УЕ15210100', phone: '99112299' } } })).id)).body);
    expect(underage).toMatchObject({ status: 'DECLINED', decision: { publicReason: 'ELIGIBILITY', suggestedMinDownPayment: null } });
    const old = parseWith(PosLeaseView, (await f.submit((await f.createOk({ digit: 0, seed: 13, over: { buyer: { registerNo: 'УЕ50010100', phone: '99112298' } } })).id)).body);
    expect(old.decision.publicReason).toBe('ELIGIBILITY');
    expect(JSON.stringify([hard, underage, old])).not.toMatch(INTERNAL);
  });

  it('REFER (digit 2 blacklist) -> reviewer APPROVE -> buyer accepts; events in order', async () => {
    const mark = t.transcript.length;
    const before = t.outbox.events.length;
    const lease = await f.createOk({ digit: 2, seed: 20 });
    t.clock.advanceSeconds(20);
    const referred = parseWith(PosLeaseView, (await f.submit(lease.id)).body);
    expect(referred).toMatchObject({ status: 'REFERRED', allowedActions: ['CANCEL'], decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW', suggestedMinDownPayment: null, decidedBy: 'SYSTEM' } });
    expect(referred.expiresAt).toBe(new Date(t.clock.now().getTime() + 72 * 3_600_000).toISOString());
    expect(merchantBodiesSince(mark)).not.toMatch(INTERNAL);

    // хянах хүртэл accept хийх боломжгүй
    expect((await f.acceptOtp(lease.id)).body.code).toBe('INVALID_TRANSITION');

    const admin = await f.adminView(lease.id);
    expect(admin.review.reasons).toEqual([{ code: 'BLACKLISTED', severity: 'REFER' }]);

    t.clock.advanceMinutes(10);
    const reviewed = parseWith(PosLeaseAdminView, (await f.review(lease.id, 'APPROVE', 'Хар жагсаалтын шалтгааныг шалгасан, зөвшөөрлөө')).body);
    expect(reviewed).toMatchObject({
      status: 'APPROVED', allowedActions: ['REQUEST_ACCEPT_OTP', 'ACCEPT', 'CANCEL'],
      decision: { result: 'APPROVE', publicReason: null, suggestedMinDownPayment: null, decidedBy: 'REVIEWER', decisionSeconds: null },
      review: { comment: 'Хар жагсаалтын шалтгааныг шалгасан, зөвшөөрлөө' },
    });
    expect(reviewed.expiresAt).toBe(new Date(t.clock.now().getTime() + 30 * 60_000).toISOString());

    t.clock.advanceSeconds(35);
    expect((await f.acceptOtp(lease.id)).status).toBe(200);
    const accepted = parseWith(PosLeaseView, (await f.accept(lease.id)).body);
    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.timeline.map((e) => e.action)).toEqual(['CREATED', 'CONSENT_VERIFIED', 'DECIDED', 'REVIEWED', 'ACCEPTED']);

    const events = t.outbox.events.slice(before);
    expect(events.map((e) => e.type)).toEqual(['PosLeaseDecided', 'PosLeaseDecided', 'PosLeaseAccepted']);
    expect(events[0]).toMatchObject({ decision: 'REFER', decidedBy: 'SYSTEM', decisionSeconds: 20 });
    expect(events[1]).toMatchObject({ decision: 'APPROVE', decidedBy: 'REVIEWER', actorId: 'approver-1', decisionSeconds: 20 + 600 });
  });

  it('REFER -> reviewer DECLINE is final and shows a generic public reason', async () => {
    const lease = await f.toDecided({ digit: 5, seed: 21 }); // PEP
    expect(lease.status).toBe('REFERRED');
    const declined = parseWith(PosLeaseAdminView, (await f.review(lease.id, 'DECLINE', 'PEP мэдүүлэг дутуу')).body);
    expect(declined).toMatchObject({ status: 'DECLINED', decision: { result: 'DECLINE', publicReason: 'CREDIT_POLICY', decidedBy: 'REVIEWER' } });
    const merchantView = parseWith(PosLeaseView, (await f.get(lease.id)).body);
    expect(JSON.stringify(merchantView)).not.toMatch(INTERNAL);
    expect(JSON.stringify(merchantView)).not.toContain('PEP мэдүүлэг'); // review тайлбар мерчантад харагдахгүй
  });

  it.each([[4, 'INCOME_UNVERIFIED'], [5, 'PEP'], [6, 'CREDIT_DATA_UNAVAILABLE'], [7, 'FICO_LOW'], [8, 'IDENTITY_NOT_FOUND']])('digit %i -> REFER (%s)', async (digit, code) => {
    const lease = await f.toDecided({ digit, seed: 30 + digit });
    expect(lease).toMatchObject({ status: 'REFERRED', decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW' } });
    expect((await f.adminView(lease.id)).review.reasons.map((r) => r.code)).toContain(code);
    expect(JSON.stringify(lease)).not.toMatch(INTERNAL);
  });

  it('identity not found -> no buyer name is shown', async () => {
    const lease = await f.toDecided({ digit: 8, seed: 50 });
    expect(lease.buyer.fullName).toBeNull();
  });

  it('DTI REFER suggests a minimum down payment; re-quoting with it becomes APPROVE', async () => {
    const over = (downPayment: number) => ({ goods: { category: 'COMPUTER', name: 'Зөөврийн компьютер', price: 3_500_000 }, downPayment });
    const referred = await f.toDecided({ digit: 1, seed: 60, over: over(700_000) });
    expect(referred).toMatchObject({ status: 'REFERRED', decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW' } });
    const suggested = referred.decision.suggestedMinDownPayment!;
    expect(suggested).toBeGreaterThan(700_000);
    expect(suggested % 1000).toBe(0);
    expect(JSON.stringify(referred)).not.toMatch(INTERNAL);

    const admin = await f.adminView(referred.id);
    expect(admin.review.reasons).toEqual([{ code: 'DTI_EXCEEDED', severity: 'REFER' }]);
    expect(admin.review.affordability).toMatchObject({ maxMonthlyPayment: 235_000, suggestedMinDownPayment: suggested });
    expect(admin.review.dtiRatio).toBeGreaterThan(0.55);
    expect(admin.review.dtiRatio).toBeLessThanOrEqual(0.65);

    // амьд quote: санал болгосон урьдчилгаатай бол сарын төлбөр ≤ 235 000 (ӨОХ ≤ 55%)
    const quote = parseWith(PosQuote, (await t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LAPTOP', goodsPrice: 3_500_000, downPayment: suggested, termMonths: 12 })).body);
    expect(quote.monthlyPayment).toBeLessThanOrEqual(235_000);

    // 1000₮-өөр бага бол хангалтгүй (санал хамгийн бага)
    const almost = await f.toDecided({ digit: 1, seed: 61, over: over(suggested - 1000) });
    expect(almost.status).toBe('REFERRED');

    const approved = await f.toDecided({ digit: 1, seed: 62, over: over(suggested) });
    expect(approved).toMatchObject({ status: 'APPROVED', decision: { result: 'APPROVE', publicReason: null, suggestedMinDownPayment: null }, quote: { downPayment: suggested } });
  });

  it('plan.policy overrides the defaults at decision time (autoDeclineEnabled=false turns DECLINE into REFER; offerTtlMinutes)', async () => {
    const plan = await t.postJson('/pos-plans', f.lender(), {
      code: 'MANUAL', name: 'Гараар хянах', goodsCategories: ['COMPUTER'], minAmount: 100_000, maxAmount: 10_000_000, termOptions: [12], annualRate: 0.24, policy: { autoDeclineEnabled: false, offerTtlMinutes: 5 },
    });
    expect(plan.status).toBe(201);
    const declinedElsewhere = await f.toDecided({ digit: 3, seed: 70, over: { planCode: 'MANUAL' } });
    expect(declinedElsewhere).toMatchObject({ status: 'REFERRED', decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW' } });
    const approved = await f.toDecided({ digit: 0, seed: 71, over: { planCode: 'MANUAL' } });
    expect(approved.expiresAt).toBe(new Date(t.clock.now().getTime() + 5 * 60_000).toISOString());
    // plan.policy-г submit-ийн мөчид дахин уншина
    const lease = await f.createOk({ digit: 0, seed: 72, over: { planCode: 'MANUAL' } });
    const patched = await t.patchJson(`/pos-plans/${plan.body.id}`, f.lender(), { policy: { offerTtlMinutes: 10 } });
    expect(patched.status).toBe(200);
    const decided = parseWith(PosLeaseView, (await f.submit(lease.id)).body);
    expect(decided.expiresAt).toBe(new Date(t.clock.now().getTime() + 10 * 60_000).toISOString());
  });

  it('amount above autoApproveMaxAmount is referred', async () => {
    const lease = await f.toDecided({ digit: 0, seed: 80, over: { goods: { category: 'COMPUTER', name: 'Том худалдан авалт', price: 12_000_000 }, downPayment: 1_200_000, termMonths: 24 } });
    expect(lease.status).toBe('REFERRED');
    expect((await f.adminView(lease.id)).review.reasons.map((r) => r.code)).toContain('AMOUNT_ABOVE_AUTO_LIMIT');
  });

  it('decision persists only a PII/amount-free screening summary, and names for the buyer', async () => {
    const lease = await f.toDecided({ digit: 0, seed: 90 });
    const rec = await (t.services.leases as unknown as { leases: { findLease(s: object, id: string): Promise<{ screeningSummary: Record<string, unknown>; buyerLastName: string; buyerFirstName: string; dtiRatio: number } | null> } })
      .leases.findLease({ orgId: 'org-test' }, lease.id);
    expect(rec!.screeningSummary).toEqual({ blacklistHit: false, pep: false, cibAvailable: true, ficoScore: 700, activeLoanCount: 1, maxDpdDays: 0, incomeSource: 'NDSH', incomeMonths: 12 });
    expect(JSON.stringify(rec!.screeningSummary)).not.toMatch(/2500000|150000|Тест/);
    expect(rec).toMatchObject({ buyerLastName: 'Тест', buyerFirstName: 'Харилцагч' });
  });

  it('consent code is required before any screening call', async () => {
    const calls = t.screening.calls.length;
    const lease = await f.createOk({ digit: 0, seed: 95 });
    expect((await f.submit(lease.id, null)).body.code).toBe('CONSENT_REQUIRED');
    expect((await f.submit(lease.id, '999999')).body.code).toBe('OTP_INVALID');
    expect(t.screening.calls.length).toBe(calls); // зөвшөөрөлгүй лавлагаа татаагүй
    expect((await f.submit(lease.id, FIXED_OTP)).status).toBe(200);
    expect(t.screening.calls.length).toBe(calls + 1);
    expect(t.screening.calls.at(-1)).toMatchObject({ leaseId: lease.id, registerNo: buyerRegister(0, 95) });
  });
});
