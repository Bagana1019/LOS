import { PosLeaseAdminView, PosLeaseView, type PosScreeningRequest, type PosScreeningResponse } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockScreeningFor } from '../integrations/screening/mock-buyer-screening';
import { MockSmsGateway } from '../integrations/sms/mock-sms.gateway';
import { LeaseRepository, OtpRepository } from '../persistence/repositories';
import { BuyerScreeningPort, Clock, SmsGateway } from '../ports';
import { parseWith } from '../testing/expect-schema';
import { leaseBody, type Fixtures } from '../testing/fixtures';
import { FIXED_OTP, PosFlow } from '../testing/flow';
import { TestApp } from '../testing/test-app';

// Лизингийн домэйн засваруудын HTTP e2e тест: n=0 (version), n=2 (баталгаажаагүй суваг), n=4 (салбар), n=5/10 (timeline actor), n=13 (зэрэгцээ create), n=15, n=16.
// Санах ойн persistence; Postgres дээрх ижил урсгал нь persistence/prisma.flow.test.ts.

/** Mock fixture-ийг тест бүрт өөрчилдөг лавлагаа (phoneMatches, төрсөн огноо, орлого …). */
class ScriptedScreening extends BuyerScreeningPort {
  clock: Clock | null = null;
  patch: (r: PosScreeningResponse, req: PosScreeningRequest) => PosScreeningResponse = (r) => r;
  async screen(req: PosScreeningRequest): Promise<PosScreeningResponse> {
    return this.patch(mockScreeningFor(req.registerNo, this.clock?.now() ?? new Date('2026-10-28T04:00:00.000Z')), req);
  }
}

/** SMS operator: хаалга хаалттай үед илгээлт хүлээнэ (үүсгэгчийн SMS гацсан үеийн уралдааныг дуурайна). */
class GatedSms extends MockSmsGateway {
  attempts = 0;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  close(): void { this.gate = new Promise<void>((resolve) => { this.release = resolve; }); }
  open(): void { this.release?.(); this.gate = null; this.release = null; }
  override async send(toPhone: string, text: string): Promise<void> {
    this.attempts++;
    if (this.gate) await this.gate;
    return super.send(toPhone, text);
  }
}

const key = (k: string) => ({ 'idempotency-key': k });
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe('lease domain fixes over HTTP', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  const screening = new ScriptedScreening();
  const sms = new GatedSms();
  beforeAll(async () => {
    t = await TestApp.create({ overrides: [{ provide: BuyerScreeningPort, useValue: screening }, { provide: SmsGateway, useValue: sms }] });
    screening.clock = t.clock;
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
  });
  afterAll(async () => { await t.close(); });
  const reset = () => { screening.patch = (r) => r; };
  const leaseRepo = () => t.get(LeaseRepository);

  // ───────────── n=0 ─────────────
  it('a created lease starts at version 1 (pos_lease_version_check requires version >= 1) and saves increase it', async () => {
    reset();
    const lease = await f.createOk({ seed: 400 });
    expect((await leaseRepo().findLease({ orgId: 'org-test' }, lease.id))!.version).toBe(1);
    await f.ok(await f.submit(lease.id));
    expect((await leaseRepo().findLease({ orgId: 'org-test' }, lease.id))!.version).toBeGreaterThan(1); // зөвшөөрөл баталгаажуулах + шийдвэр = save бүр +1
  });

  // ───────────── n=2 ─────────────
  describe('unverified consent channel (identity.phoneMatches !== true) leaks no buyer name and no credit category', () => {
    const phoneCases: Array<[string, boolean | null, string]> = [['false', false, 'PHONE_MISMATCH'], ['null', null, 'PHONE_UNVERIFIED']];

    it.each(phoneCases)('phoneMatches=%s + DPD >= 90: REFERRED / MANUAL_REVIEW, no name anywhere on the merchant side, reasons stay in the lender view', async (_label, phoneMatches, phoneReason) => {
      reset();
      screening.patch = (r) => ({ ...r, identity: { ...r.identity, phoneMatches } }); // digit 3 = 120 хоног хугацаа хэтрэлт
      const created = await f.createOk({ digit: 3, seed: phoneMatches === null ? 411 : 410 });
      const decided = parseWith(PosLeaseView, (await f.submit(created.id)).body);
      expect(decided).toMatchObject({
        status: 'REFERRED', allowedActions: ['CANCEL'],
        buyer: { fullName: null }, decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW', suggestedMinDownPayment: null },
      });
      const got = await f.get(created.id);
      const list = await t.getJson('/merchant-portal/leases', f.staff1());
      const item = list.body.items.find((i: { id: string }) => i.id === created.id);
      expect(item).toMatchObject({ buyerName: null, publicReason: 'MANUAL_REVIEW', status: 'REFERRED' });
      const merchantSide = JSON.stringify([created, decided, got.body, item]); // зөвхөн энэ лизингийн мерчантад харагдах бүх хэлбэр
      expect(merchantSide).not.toContain('Харилцагч');
      expect(merchantSide).not.toMatch(/CREDIT_POLICY|AFFORDABILITY|ELIGIBILITY|DPD_EXCEEDED|PHONE_MISMATCH|PHONE_UNVERIFIED|"DECLINE"/);

      // lender: дотоод шалтгаан хадгалагдсан, нэр байхгүй
      const admin = parseWith(PosLeaseAdminView, (await f.adminGet(created.id)).body);
      expect(admin.buyer.fullName).toBeNull();
      expect(admin.review.reasons.map((r) => r.code)).toEqual(expect.arrayContaining([phoneReason, 'DPD_EXCEEDED']));
      expect(admin.review.reasons.every((r) => r.severity !== 'DECLINE')).toBe(true); // DECLINE → REFER болгож хадгалсан
      const record = await leaseRepo().findLease({ orgId: 'org-test' }, created.id);
      expect(record).toMatchObject({ buyerLastName: null, buyerFirstName: null, decision: 'REFER', status: 'REFERRED' });
    });

    it.each(phoneCases)('phoneMatches=%s: every credit profile looks the same to the merchant (no APPROVE/DECLINE oracle)', async (_label, phoneMatches) => {
      reset();
      screening.patch = (r) => ({ ...r, identity: { ...r.identity, phoneMatches } });
      const outcomes = new Set<string>();
      for (const [i, digit] of [0, 1, 2, 3, 5, 7].entries()) { // эрүүл, бага орлого, хар жагсаалт, DPD, PEP, FICO 480
        const v = parseWith(PosLeaseView, await f.toDecided({ digit, seed: 420 + i + (phoneMatches === null ? 10 : 0) }));
        outcomes.add(`${v.status}/${v.decision.result}/${v.decision.publicReason}/${v.decision.suggestedMinDownPayment}/${v.buyer.fullName}`);
      }
      expect([...outcomes]).toEqual(['REFERRED/REFER/MANUAL_REVIEW/null/null']);
    });

    it('control: a verified channel (phoneMatches=true) keeps the old behaviour — name shown, DECLINED / CREDIT_POLICY', async () => {
      reset();
      const v = parseWith(PosLeaseView, await f.toDecided({ digit: 3, seed: 430 }));
      expect(v).toMatchObject({ status: 'DECLINED', buyer: { fullName: 'Тест Харилцагч' }, decision: { result: 'DECLINE', publicReason: 'CREDIT_POLICY' } });
    });

    it('a reviewer can still approve a REFERRED lease of an unverified channel; the buyer name stays hidden', async () => {
      reset();
      screening.patch = (r) => ({ ...r, identity: { ...r.identity, phoneMatches: false } });
      const referred = await f.toDecided({ digit: 0, seed: 431 });
      expect(referred.status).toBe('REFERRED');
      const approved = parseWith(PosLeaseAdminView, (await f.review(referred.id, 'APPROVE', 'Утсыг лавлаж баталгаажууллаа')).body);
      expect(approved).toMatchObject({ status: 'APPROVED', buyer: { fullName: null } });
    });
  });

  // ───────────── n=15 ─────────────
  it('a found identity without a birth date is referred for a manual age check instead of being approved', async () => {
    reset();
    screening.patch = (r) => ({ ...r, identity: { ...r.identity, birthDate: null } });
    const v = parseWith(PosLeaseView, await f.toDecided({ digit: 0, seed: 440 }));
    expect(v).toMatchObject({ status: 'REFERRED', decision: { result: 'REFER', publicReason: 'MANUAL_REVIEW' }, buyer: { fullName: 'Тест Харилцагч' } });
    expect((await f.adminView(v.id)).review.reasons).toEqual([{ code: 'BIRTH_DATE_MISSING', severity: 'REFER' }]);
  });

  // ───────────── n=16 ─────────────
  describe('suggested minimum down payment is applicable', () => {
    it('low capacity: no down payment satisfies both the DTI and the plan minimum financed amount → no suggestion', async () => {
      reset();
      // LAPTOP minAmount 300,000₮; орлого 700,000, сарын өр 370,000 → чадамж (0.55 × 700,000 − 370,000 = 15,000₮/сар) бага
      screening.patch = (r) => ({ ...r, income: { ...r.income, monthlyAmount: 700_000 }, cib: { ...r.cib, monthlyDebtService: 370_000 } });
      const v = parseWith(PosLeaseView, await f.toDecided({ digit: 0, seed: 450 }));
      expect(v).toMatchObject({ status: 'DECLINED', decision: { result: 'DECLINE', publicReason: 'AFFORDABILITY', suggestedMinDownPayment: null } });
      const admin = await f.adminView(v.id);
      expect(admin.review.affordability!.maxFinancedAmount).toBeLessThan(300_000);
      expect(admin.review.affordability!.suggestedMinDownPayment).toBeNull();
    });

    it('every suggestion passes the quote validation and the retried lease is APPROVED', async () => {
      reset();
      let suggestions = 0;
      for (const [i, income] of [600_000, 750_000, 900_000, 1_100_000].entries()) {
        screening.patch = (r) => ({ ...r, income: { ...r.income, monthlyAmount: income }, cib: { ...r.cib, monthlyDebtService: 150_000 } });
        const over = (downPayment: number) => ({ goods: { category: 'COMPUTER', name: 'Зөөврийн компьютер', price: 5_000_000 }, downPayment });
        const first = parseWith(PosLeaseView, await f.toDecided({ digit: 0, seed: 460 + i * 2, over: over(1_000_000) }));
        const suggested = first.decision.suggestedMinDownPayment;
        if (suggested === null) continue;
        suggestions++;
        const retry = parseWith(PosLeaseView, await f.toDecided({ digit: 0, seed: 461 + i * 2, over: over(suggested) })); // AMOUNT_OUT_OF_RANGE (422) болохгүй
        expect(retry, `income ${income}`).toMatchObject({ status: 'APPROVED', decision: { result: 'APPROVE' }, quote: { downPayment: suggested } });
      }
      expect(suggestions).toBeGreaterThanOrEqual(2);
    });
  });

  // ───────────── n=5 / n=10 ─────────────
  it('merchant timeline shows only roles (no staff ids); the back-office timeline keeps full actors', async () => {
    reset();
    const lease = await f.toDecided({ digit: 2, seed: 470 }); // хар жагсаалт → REFER
    expect(lease.status).toBe('REFERRED');
    await f.ok(await f.review(lease.id, 'APPROVE', 'Хянаж баталгаажууллаа'));
    t.clock.advanceSeconds(31);
    await f.ok(await f.acceptOtp(lease.id));
    await f.ok(await f.accept(lease.id));
    await f.ok(await f.deliver(lease.id));
    await f.ok(await f.settle(lease.id, 'PAY-ROLES-1'));

    for (const headers of [f.staff1(), f.admin()]) {
      const res = await f.get(lease.id, headers);
      const merchantView = parseWith(PosLeaseView, res.body);
      expect(merchantView.timeline.map((e) => [e.action, e.actor])).toEqual([
        ['CREATED', 'MERCHANT'], ['CONSENT_VERIFIED', 'BUYER'], ['DECIDED', 'SYSTEM'], ['REVIEWED', 'LENDER'], ['ACCEPTED', 'BUYER'], ['DELIVERED', 'MERCHANT'], ['SETTLED', 'LENDER'],
      ]);
      expect(res.text).not.toMatch(/approver-1|lender-admin-1|staff-1/);
    }
    const list = await t.getJson('/merchant-portal/leases', f.staff1());
    expect(list.text).not.toMatch(/approver-1|lender-admin-1/);
    const admin = await f.adminView(lease.id);
    expect(admin.timeline.map((e) => e.actor)).toEqual(['MERCHANT:staff-1', 'BUYER', 'SYSTEM', 'LENDER:approver-1', 'BUYER', 'MERCHANT:staff-1', 'LENDER:lender-admin-1']);
  });

  // ───────────── n=4 ─────────────
  it("BRANCH_MANAGER access follows the merchant's CURRENT branch: moving the merchant moves its leases (snapshot column stays)", async () => {
    reset();
    const bm = (branchId: string) => f.p.branchManager(branchId);
    const referred = await f.toDecided({ digit: 5, seed: 480 }); // PEP → REFER
    const other = await f.toDecided({ digit: 5, seed: 481 });
    expect(referred.status).toBe('REFERRED');
    const listIds = async (branchId: string) => ((await t.getJson('/pos-leases?pageSize=100', bm(branchId))).body.items as Array<{ id: string }>).map((i) => i.id);

    // BR-X ёсоор харагдана
    expect((await t.getJson(`/pos-leases/${referred.id}`, bm('BR-X'))).status).toBe(200);
    expect(await listIds('BR-X')).toContain(referred.id);
    expect((await t.getJson(`/pos-leases/${referred.id}`, bm('BR-Z'))).status).toBe(404);
    expect(await listIds('BR-Z')).not.toContain(referred.id);

    // ADMIN мерчантыг BR-Z руу шилжүүлнэ
    try {
      const moved = await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { branchId: 'BR-Z' });
      expect(moved.status).toBe(200);
      expect(moved.body.branchId).toBe('BR-Z');

      // BR-X менежер: мерчант шиг 404, жагсаалтад алга, шийдэж чадахгүй
      expect((await t.getJson(`/merchants/${fx.merchantA.id}`, bm('BR-X'))).status).toBe(404);
      expect((await t.getJson(`/pos-leases/${referred.id}`, bm('BR-X'))).status).toBe(404);
      expect(await listIds('BR-X')).not.toContain(referred.id);
      expect((await t.getJson(`/pos-leases?merchantId=${fx.merchantA.id}`, bm('BR-X'))).body.total).toBe(0);
      expect((await f.review(referred.id, 'APPROVE', 'Хуучин салбар батлав', bm('BR-X'))).status).toBe(404);

      // BR-Z менежер: харна, жагсаалтад байна, шийднэ
      expect((await t.getJson(`/pos-leases/${referred.id}`, bm('BR-Z'))).status).toBe(200);
      expect(await listIds('BR-Z')).toEqual(expect.arrayContaining([referred.id, other.id]));
      const reviewed = await f.review(referred.id, 'APPROVE', 'Шинэ салбар батлав', bm('BR-Z'));
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.status).toBe('APPROVED');

      // pos_lease.branch_id нь үүсгэх үеийн түүхэн хуулбар хэвээр; шинэ лизинг мерчантын одоогийн салбарыг хуулна
      expect((await leaseRepo().findLease({ orgId: 'org-test' }, referred.id))!.branchId).toBe('BR-X');
      const fresh = await f.createOk({ digit: 5, seed: 482 });
      expect((await leaseRepo().findLease({ orgId: 'org-test' }, fresh.id))!.branchId).toBe('BR-Z');
    } finally {
      expect((await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { branchId: 'BR-X' })).status).toBe(200); // бусад тест BR-X-ийг хүлээнэ
    }
    expect((await t.getJson(`/pos-leases/${referred.id}`, bm('BR-X'))).status).toBe(200);
  });

  // ───────────── n=13 ─────────────
  describe('idempotent create under concurrency (POS-BR-12)', () => {
    it('N parallel creates with the same key: one 201, the rest 200 replays, one lease, one SMS and one OTP — never 429', async () => {
      reset();
      const body = leaseBody(fx.storeA1.id, 0, {}, 490);
      const attemptsBefore = sms.attempts;
      const sentBefore = sms.sent.length;
      sms.close(); // үүсгэгчийн SMS гацаж байх үед бусад хүсэлт орж ирнэ (давхар SMS-ийн цонх)
      let results: Array<{ status: number; body: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        const all = Promise.all(Array.from({ length: 8 }, () => t.postJson('/merchant-portal/leases', f.staff1(), body, key('idem-concurrent-0001'))));
        await waitFor(() => sms.attempts > attemptsBefore, 'the creator to reach the SMS gateway');
        await new Promise<void>((resolve) => setTimeout(resolve, 100)); // бусад 7 нь replay хийж дуусах цонх
        sms.open();
        results = await all;
      } finally {
        sms.open();
      }
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      const ids = new Set(results.map((r) => r.body.lease.id as string));
      expect(ids.size).toBe(1);
      expect(sms.attempts - attemptsBefore).toBe(1);
      expect(sms.sent.length - sentBefore).toBe(1);
      const [leaseId] = [...ids];
      expect(await t.get(OtpRepository).countOtps(leaseId)).toBe(1);
      for (const r of results) expect(r.body.otp).toMatchObject({ purpose: 'CONSENT' });
      const list = await t.getJson(`/merchant-portal/leases?q=${results[0].body.lease.leaseNo}`, f.staff1());
      expect(list.body.total).toBe(1);
      expect((await f.submit(leaseId)).status).toBe(200); // тэр нэг код хүчинтэй
    });

    it('the creator treats OTP_RESEND_TOO_SOON from a healing replay as success (no 429) and returns the latest code', async () => {
      reset();
      const body = leaseBody(fx.storeA1.id, 0, {}, 491);
      const otps = t.get(OtpRepository);
      const original = otps.latestOtp.bind(otps);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let blocked = false;
      otps.latestOtp = async (leaseId, purpose) => {
        if (!blocked) { blocked = true; await gate; } // үүсгэгчийн эхний уншилт зогсоно
        return original(leaseId, purpose);
      };
      const sentBefore = sms.sent.length;
      try {
        const creator = t.postJson('/merchant-portal/leases', f.staff1(), body, key('idem-concurrent-0002'));
        await waitFor(() => blocked, 'the creator to reach latestOtp');
        t.clock.advanceSeconds(31); // лизинг дахин илгээх хугацаанаас хөгшин → replay өөрөө код илгээж "эдгээнэ"
        const replay = await t.postJson('/merchant-portal/leases', f.staff1(), body, key('idem-concurrent-0002'));
        expect(replay.status).toBe(200);
        release();
        const created = await creator;
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.otp).toEqual(replay.body.otp); // үүсгэгч сүүлийн кодыг буцаана
        expect(sms.sent.length - sentBefore).toBe(1);
        expect(await otps.countOtps(created.body.lease.id)).toBe(1);
      } finally {
        release();
        otps.latestOtp = original;
      }
    });

    it('a retry inside the resend window returns the same OTP info without a second SMS', async () => {
      reset();
      const body = leaseBody(fx.storeA1.id, 0, {}, 492);
      const first = await t.postJson('/merchant-portal/leases', f.staff1(), body, key('idem-concurrent-0003'));
      expect(first.status).toBe(201);
      const sent = sms.sent.length;
      const replay = await t.postJson('/merchant-portal/leases', f.staff1(), body, key('idem-concurrent-0003'));
      expect(replay.status).toBe(200);
      expect(replay.body.otp).toEqual(first.body.otp);
      expect(sms.sent.length).toBe(sent);
    });
  });

  it('no merchant-portal response of the new flows carries the OTP code or its hash', () => {
    const portal = t.transcript.filter((l) => l.includes(' /merchant-portal/')).join('\n');
    expect(portal).not.toMatch(new RegExp(`(?<!\\d)${FIXED_OTP}(?!\\d)`));
    expect(portal).not.toMatch(/codeHash|code_hash/);
  });
});
