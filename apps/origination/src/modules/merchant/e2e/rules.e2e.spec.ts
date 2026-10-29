import { PosLeaseView, PosLeaseWithOtp } from '@los/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseWith } from '../testing/expect-schema';
import { leaseBody, type Fixtures } from '../testing/fixtures';
import { FIXED_OTP, PosFlow } from '../testing/flow';
import { TestApp } from '../testing/test-app';

const KEY = { 'idempotency-key': '' };
const keyed = (k: string) => ({ ...KEY, 'idempotency-key': k });

/** Глобал төлөв (мерчантын төлөв, лимит, цаг) өөрчилдөг тест тусдаа апп-д ажиллана. */
async function isolated(fn: (t: TestApp, fx: Fixtures, f: PosFlow) => Promise<void>): Promise<void> {
  const t2 = await TestApp.create();
  try {
    const fx2 = await t2.fixtures();
    await fn(t2, fx2, new PosFlow(t2, fx2));
  } finally {
    await t2.close();
  }
}

describe('business rules over HTTP', () => {
  let t: TestApp;
  let fx: Fixtures;
  let f: PosFlow;
  beforeAll(async () => {
    t = await TestApp.create();
    fx = await t.fixtures();
    f = new PosFlow(t, fx);
  });
  afterAll(async () => { await t.close(); });
  beforeEach(() => { t.screening.failing = false; t.sms.failing = false; });

  // ───────────── POS-BR-12 ─────────────
  describe('idempotency (POS-BR-12)', () => {
    it('replay returns the same lease with 200 and sends no new SMS; a different body is 409', async () => {
      const body = leaseBody(fx.storeA1.id, 0, {}, 200);
      const first = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-replay-0001'));
      expect(first.status).toBe(201);
      const sms = t.sms.sent.length;
      t.clock.advanceSeconds(5);
      const replay = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-replay-0001'));
      expect(replay.status).toBe(200);
      const parsed = parseWith(PosLeaseWithOtp, replay.body);
      expect(parsed.lease.id).toBe(first.body.lease.id);
      expect(parsed.lease.leaseNo).toBe(first.body.lease.leaseNo);
      expect(parsed.otp).toEqual(first.body.otp); // сүүлийн CONSENT код
      expect(t.sms.sent.length).toBe(sms);
      const conflict = await t.postJson('/merchant-portal/leases', f.staff1(), { ...body, downPayment: 700_000 }, keyed('idem-replay-0001'));
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      const otherBuyer = await t.postJson('/merchant-portal/leases', f.staff1(), leaseBody(fx.storeA1.id, 0, {}, 201), keyed('idem-replay-0001'));
      expect(otherBuyer.body.code).toBe('IDEMPOTENCY_CONFLICT');
      const list = await t.getJson('/merchant-portal/leases?q=' + first.body.lease.leaseNo, f.staff1());
      expect(list.body.total).toBe(1);
    });
    it('a replay after the lease progressed returns the current state', async () => {
      const body = leaseBody(fx.storeA1.id, 0, {}, 202);
      const first = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-progress-01'));
      await f.submit(first.body.lease.id);
      const replay = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-progress-01'));
      expect(replay.status).toBe(200);
      expect(replay.body.lease.status).toBe('APPROVED');
    });
    it('the storeId is resolved before hashing, so omitting it for a cashier is the same request', async () => {
      const explicit = leaseBody(fx.storeA1.id, 0, {}, 203);
      const { storeId: _storeId, ...implicit } = explicit;
      void _storeId;
      expect((await t.postJson('/merchant-portal/leases', f.staff1(), implicit, keyed('idem-store-0001'))).status).toBe(201);
      expect((await t.postJson('/merchant-portal/leases', f.staff1(), explicit, keyed('idem-store-0001'))).status).toBe(200);
    });
    it('the key is scoped per merchant', async () => {
      const a = await t.postJson('/merchant-portal/leases', f.staff1(), leaseBody(fx.storeA1.id, 0, {}, 204), keyed('idem-shared-key1'));
      const b = await t.postJson('/merchant-portal/leases', f.adminB(), leaseBody(fx.storeB1.id, 0, {}, 205), keyed('idem-shared-key1'));
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.lease.id).not.toBe(b.body.lease.id);
    });
    it('concurrent identical requests create exactly one lease', async () => {
      const body = leaseBody(fx.storeA1.id, 0, {}, 206);
      const [x, y] = await Promise.all([1, 2].map(() => t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-race-00001'))));
      expect([x.status, y.status].sort()).toEqual([200, 201]);
      expect(x.body.lease.id).toBe(y.body.lease.id);
    });
    it('Idempotency-Key is mandatory and must be 8-64 characters of [A-Za-z0-9_-]', async () => {
      const body = leaseBody(fx.storeA1.id, 0, {}, 207);
      for (const bad of [undefined, 'short', 'has spaces in it', 'x'.repeat(65), 'bad/char/key1']) {
        const res = await t.postJson('/merchant-portal/leases', f.staff1(), body, bad === undefined ? {} : { 'idempotency-key': bad });
        expect(res.status, String(bad)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.details.issues[0].path).toBe('Idempotency-Key');
      }
      expect((await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('x'.repeat(64)))).status).toBe(201);
    });
    it('a lease number collision is retried with a new suffix (up to 5 retries)', async () => {
      t.ids.forcedSuffixes.push('AAAAAA');
      const first = await f.createOk({ seed: 210 });
      expect(first.leaseNo.endsWith('-AAAAAA')).toBe(true);
      t.ids.forcedSuffixes.push('AAAAAA', 'AAAAAA', 'AAAAAA', 'AAAAAA', 'AAAAAA', 'BBBBBB'); // 5 давхцал → 6 дахь оролдлого амжилттай
      const second = await f.createOk({ seed: 211 });
      expect(second.leaseNo.endsWith('-BBBBBB')).toBe(true);
      t.ids.forcedSuffixes.push('AAAAAA', 'AAAAAA', 'AAAAAA', 'AAAAAA', 'AAAAAA', 'AAAAAA', 'CCCCCC'); // 6 давхцал → бууна
      const failed = await f.create({ seed: 212 });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ code: 'INTERNAL', message: 'Internal error' });
      t.ids.forcedSuffixes.length = 0;
    });
  });

  // ───────────── POS-BR-8 ─────────────
  describe('OTP rules (POS-BR-8)', () => {
    it('3 wrong codes exhaust the OTP; a correct code no longer works; a fresh code does', async () => {
      const lease = await f.createOk({ seed: 220 });
      const wrong = (code: string) => f.submit(lease.id, code);
      const a = await wrong('000001');
      expect(a.status).toBe(422);
      expect(a.body).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 2 } });
      expect((await wrong('000002')).body.details).toEqual({ attemptsLeft: 1 });
      const c = await wrong('000003');
      expect(c.status).toBe(429);
      expect(c.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      expect((await f.submit(lease.id, FIXED_OTP)).body.code).toBe('OTP_ATTEMPTS_EXCEEDED'); // зөв код ч нэмэлт оролдлого олгохгүй
      t.clock.advanceSeconds(31);
      expect((await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1())).status).toBe(200);
      expect((await f.submit(lease.id, FIXED_OTP)).status).toBe(200);
    });
    it('an expired consent code returns OTP_EXPIRED; resend recovers', async () => {
      const lease = await f.createOk({ seed: 221 });
      t.clock.advanceSeconds(301);
      const res = await f.submit(lease.id, FIXED_OTP);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OTP_EXPIRED');
      expect((await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1())).status).toBe(200);
      expect((await f.submit(lease.id, FIXED_OTP)).status).toBe(200);
    });
    it('at most 5 codes may be sent per lease', async () => {
      const lease = await f.createOk({ seed: 222 }); // 1
      for (let i = 0; i < 4; i++) {
        t.clock.advanceSeconds(31);
        expect((await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1())).status).toBe(200); // 2..5
      }
      t.clock.advanceSeconds(31);
      const sixth = await t.postJson(`/merchant-portal/leases/${lease.id}/otp/consent`, f.staff1());
      expect(sixth.status).toBe(429);
      expect(sixth.body).toMatchObject({ code: 'OTP_ATTEMPTS_EXCEEDED', details: { reason: 'MAX_SENDS', maxSends: 5 } });
    });
    it('accept: not requested / wrong / expired / exhausted / recovered', async () => {
      const approved = await f.toDecided({ seed: 223 });
      expect((await f.accept(approved.id, FIXED_OTP)).body.code).toBe('OTP_NOT_REQUESTED'); // зөвшөөрлийн (CONSENT) код ACCEPT-д хүчингүй
      t.clock.advanceSeconds(31);
      expect((await f.acceptOtp(approved.id)).status).toBe(200);
      expect((await f.acceptOtp(approved.id)).status).toBe(429); // дахин илгээх хязгаар
      expect((await f.accept(approved.id, '111111')).body).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 2 } });
      t.clock.advanceMinutes(6);
      expect((await f.accept(approved.id, FIXED_OTP)).body.code).toBe('OTP_EXPIRED');
      expect((await f.acceptOtp(approved.id)).status).toBe(200);
      const ok = await f.accept(approved.id, FIXED_OTP);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('ACCEPTED');
      expect((await f.accept(approved.id, FIXED_OTP)).body.code).toBe('INVALID_TRANSITION'); // код дахин ашиглагдахгүй
    });
    it('the OTP code never appears in any HTTP response', async () => {
      const bodies = t.transcript.filter((l) => l.includes('/merchant-portal/')).join('\n');
      expect(bodies).not.toContain(FIXED_OTP);
      expect(bodies).not.toMatch(/codeHash|code_hash/);
    });
    it('SMS outage: lease is created (DRAFT) but the call is 503; resend works as soon as SMS recovers; a same-key retry inside the cooldown sends no second SMS', async () => {
      t.sms.failing = true;
      const body = leaseBody(fx.storeA1.id, 0, {}, 224);
      const failed = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-smsfail-001'));
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('SMS_UNAVAILABLE');
      const listed = await t.getJson('/merchant-portal/leases?status=DRAFT', f.staff1());
      const draft = listed.body.items.find((i: { buyerPhoneMasked: string; buyerRegisterMasked: string }) => i.buyerPhoneMasked === '99****24');
      expect(draft).toBeTruthy();
      expect((await t.postJson(`/merchant-portal/leases/${draft.id}/otp/consent`, f.staff1())).body.code).toBe('SMS_UNAVAILABLE');
      t.sms.failing = false;
      // n=13: лизинг дахин илгээх хугацаанаас залуу байхад ижил key-ээр дахин оролдоход шинэ SMS илгээхгүй (үүсгэгч SMS-ээ илгээж байгаа байж болно) — resendAvailableAt-аар хариулна
      const sent = t.sms.sent.length;
      const replay = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-smsfail-001'));
      expect(replay.status).toBe(200);
      expect(replay.body.lease.id).toBe(draft.id);
      expect(replay.body.otp).toMatchObject({ purpose: 'CONSENT', phoneMasked: '99****24' });
      expect(new Date(replay.body.otp.resendAvailableAt).getTime()).toBeGreaterThan(t.clock.now().getTime());
      expect(t.sms.sent.length).toBe(sent);
      // амжилтгүй илгээлт cooldown/тоолуур зарцуулаагүй тул кассир шууд resend хийж болно
      expect((await t.postJson(`/merchant-portal/leases/${draft.id}/otp/consent`, f.staff1())).status).toBe(200);
      expect(t.sms.sent.length).toBe(sent + 1);
      expect((await f.submit(draft.id)).status).toBe(200);
    });
    it('SMS outage: a same-key retry after the resend window issues the missing code (replay heals)', async () => {
      t.sms.failing = true;
      const body = leaseBody(fx.storeA1.id, 0, {}, 226);
      expect((await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-smsfail-002'))).status).toBe(503);
      t.sms.failing = false;
      t.clock.advanceSeconds(31);
      const sent = t.sms.sent.length;
      const replay = await t.postJson('/merchant-portal/leases', f.staff1(), body, keyed('idem-smsfail-002'));
      expect(replay.status).toBe(200);
      expect(replay.body.otp.purpose).toBe('CONSENT');
      expect(t.sms.sent.length).toBe(sent + 1);
      expect((await f.submit(replay.body.lease.id)).status).toBe(200);
    });
    it('SMS outage on the accept code leaves the lease APPROVED', async () => {
      const approved = await f.toDecided({ seed: 225 });
      t.sms.failing = true;
      const res = await f.acceptOtp(approved.id);
      expect(res.status).toBe(503);
      t.sms.failing = false;
      expect(parseWith(PosLeaseView, (await f.get(approved.id)).body).status).toBe('APPROVED');
      expect((await f.acceptOtp(approved.id)).status).toBe(200);
    });
  });

  // ───────────── lazy expiry ─────────────
  describe('expiry (lazy)', () => {
    it('DRAFT expires after 60 minutes: reads show EXPIRED, actions give INVALID_TRANSITION, expiry is persisted once', async () => {
      const lease = await f.createOk({ seed: 230 });
      const mark = f.eventTypes(lease.id).length;
      t.clock.advanceMinutes(60);
      expect((await f.get(lease.id)).body.status).toBe('DRAFT'); // expiresAt == now: хараахан биш
      t.clock.advanceSeconds(1);
      const read = parseWith(PosLeaseView, (await f.get(lease.id)).body);
      expect(read).toMatchObject({ status: 'EXPIRED', allowedActions: [] });
      expect(f.eventTypes(lease.id).length).toBe(mark); // уншилт хадгалахгүй
      const submit = await f.submit(lease.id);
      expect(submit.status).toBe(409);
      expect(submit.body).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'EXPIRED' } });
      expect((await f.submit(lease.id)).body.code).toBe('INVALID_TRANSITION');
      expect((await f.cancel(lease.id)).body.code).toBe('INVALID_TRANSITION');
      const events = t.outbox.events.filter((e) => (e as { leaseId?: string }).leaseId === lease.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'PosLeaseCancelled', fromStatus: 'DRAFT', reason: 'EXPIRED', actorId: null });
      const view = parseWith(PosLeaseView, (await f.get(lease.id)).body);
      expect(view.timeline.at(-1)).toMatchObject({ action: 'EXPIRED', fromStatus: 'DRAFT', toStatus: 'EXPIRED', actor: 'SYSTEM' });
    });
    it('APPROVED offer expires after 30 minutes: OFFER_EXPIRED', async () => {
      const approved = await f.toDecided({ seed: 231 });
      t.clock.advanceMinutes(31);
      expect((await f.get(approved.id)).body).toMatchObject({ status: 'EXPIRED', allowedActions: [] });
      const otp = await f.acceptOtp(approved.id);
      expect(otp.status).toBe(409);
      expect(otp.body.code).toBe('OFFER_EXPIRED');
      expect((await f.accept(approved.id)).body.code).toBe('OFFER_EXPIRED');
      expect((await f.cancel(approved.id)).body.code).toBe('INVALID_TRANSITION');
    });
    it('REFERRED expires after 72 hours: review and cancel are rejected', async () => {
      const referred = await f.toDecided({ digit: 2, seed: 232 });
      t.clock.advanceHours(71);
      expect((await f.get(referred.id)).body.status).toBe('REFERRED');
      t.clock.advanceHours(2);
      expect((await f.get(referred.id)).body.status).toBe('EXPIRED');
      expect((await f.adminView(referred.id)).status).toBe('EXPIRED');
      const review = await f.review(referred.id, 'APPROVE');
      expect(review.status).toBe(409);
      expect(review.body.code).toBe('INVALID_TRANSITION');
      expect((await f.cancel(referred.id)).body.code).toBe('INVALID_TRANSITION');
    });
    it('list items use the effective status as well', async () => {
      const lease = await f.createOk({ seed: 233 });
      t.clock.advanceMinutes(61);
      const list = await t.getJson('/merchant-portal/leases?q=' + lease.leaseNo, f.staff1());
      expect(list.body.items[0].status).toBe('EXPIRED');
    });
    it('expireStale() persists EXPIRED for all stale leases once and is idempotent', async () => {
      const a = await f.createOk({ seed: 234 });
      const b = await f.toDecided({ seed: 235 });
      const c = await f.toDecided({ digit: 2, seed: 236 });
      const fresh = await f.toDecided({ seed: 237 });
      t.clock.advanceMinutes(31); // b, fresh-offer дууссан; a (60 мин) хараахан биш
      t.clock.advanceMinutes(30); // a дууссан; c (72 цаг) хараахан биш
      const n = await t.services.leases.expireStale();
      expect(n).toBeGreaterThanOrEqual(3);
      expect(await t.services.leases.expireStale()).toBe(0);
      for (const id of [a.id, b.id, fresh.id]) expect((await f.get(id)).body.status).toBe('EXPIRED');
      expect((await f.get(c.id)).body.status).toBe('REFERRED');
      expect(f.eventTypes(a.id)).toEqual(['PosLeaseCancelled']);
      expect(f.eventTypes(b.id)).toEqual(['PosLeaseDecided', 'PosLeaseCancelled']);
    });
  });

  // ───────────── limits ─────────────
  describe('limits', () => {
    it('ticket limit: financed amount above merchant.maxTicketAmount is rejected before anything is created', async () => {
      const res = await f.create({ seed: 240, over: { goods: { category: 'COMPUTER', name: 'Том бараа', price: 20_000_000 }, downPayment: 4_000_000 } });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'TICKET_LIMIT_EXCEEDED', details: { maxTicketAmount: 15_000_000 } });
      const quote = await t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LAPTOP', goodsPrice: 20_000_000, downPayment: 4_000_000, termMonths: 12 });
      expect(quote.body.code).toBe('TICKET_LIMIT_EXCEEDED');
    });
    it('daily limit (Ulaanbaatar day): sum of accepted + new must not exceed dailyLimitAmount; resets at 00:00 MN', () => isolated(async (t, fx, f) => {
      const patch = await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { dailyLimitAmount: 5_000_000 });
      expect(patch.status).toBe(200);
      t.clock.set('2026-10-28T15:50:00.000Z'); // 23:50 MN
      await f.toAccepted({ seed: 241 }); // 2 400 000 хэрэглэгдсэн
      const second = await f.toDecided({ seed: 242 });
      t.clock.advanceSeconds(31);
      await f.acceptOtp(second.id); // 2.4M + 2.4M = 4.8M ≤ 5M — зөвшөөрнө
      expect((await f.accept(second.id)).status).toBe(200);
      const third = await f.toDecided({ seed: 243 }); // 4.8M + 2.4M = 7.2M > 5M
      t.clock.advanceSeconds(31);
      await f.acceptOtp(third.id);
      const blocked = await f.accept(third.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED', details: { dailyLimitAmount: 5_000_000, usedAmount: 4_800_000 } });
      const dash = await t.getJson('/merchant-portal/dashboard', f.admin());
      expect(dash.body.limits).toMatchObject({ dailyLimitAmount: 5_000_000, dailyUsedAmount: 4_800_000 });
      // exact fit: лимитийг 7.2M болговол зөвшөөрнө (≤)
      await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { dailyLimitAmount: 7_200_000 });
      expect((await f.accept(third.id)).status).toBe(200); // 4.8M + 2.4M = 7.2M ≤ 7.2M (яг тэнцүү — зөвшөөрнө); амжилтгүй оролдлого OTP-г зарцуулаагүй
      // хугацаа 16:00Z-ээс хойш → шинэ өдөр, лимит сэргэнэ
      await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { dailyLimitAmount: 5_000_000 });
      t.clock.set('2026-10-28T16:00:05.000Z');
      const next = await f.toDecided({ seed: 244 });
      t.clock.advanceSeconds(31);
      await f.acceptOtp(next.id);
      expect((await f.accept(next.id)).status).toBe(200);
      expect((await t.getJson('/merchant-portal/dashboard', f.admin())).body.limits.dailyUsedAmount).toBe(2_400_000);
    }));
    it('a null dailyLimitAmount means unlimited', () => isolated(async (t, fx, f) => {
      await t.patchJson(`/merchants/${fx.merchantA.id}`, f.lender(), { dailyLimitAmount: null });
      for (let i = 0; i < 7; i++) await f.toAccepted({ seed: 245 + i, over: { goods: { category: 'COMPUTER', name: 'Бараа', price: 8_000_000 }, downPayment: 800_000 } }); // 7 × 7.2M > 50M
      expect((await t.getJson('/merchant-portal/dashboard', f.admin())).body.limits).toMatchObject({ dailyLimitAmount: null, dailyUsedAmount: 7 * 7_200_000 });
    }));
  });

  // ───────────── POS-BR-10 ─────────────
  describe('merchant status (POS-BR-10)', () => {
    it('SUSPENDED blocks create/quote/submit/accept but still allows deliver and cancel; TERMINATED blocks everything', () => isolated(async (t, fx, f) => {
      const setStatus = (status: string, reason = 'Тест шалтгаан') => t.postJson(`/merchants/${fx.merchantA.id}/status`, f.lender(), { status, reason });
      const draft = await f.createOk({ seed: 250 });
      const approved = await f.toDecided({ seed: 251 });
      const toDeliver = await f.toAccepted({ seed: 252 });
      const toCancel = await f.toAccepted({ seed: 253 });
      await f.acceptOtp(approved.id).catch(() => undefined);
      t.clock.advanceSeconds(31);
      await f.acceptOtp(approved.id);

      expect((await setStatus('SUSPENDED')).status).toBe(200);
      const blocked = async (res: Promise<{ status: number; body: { code?: string } }>) => {
        const r = await res;
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('MERCHANT_NOT_ACTIVE');
      };
      await blocked(f.create({ seed: 254 }));
      await blocked(t.postJson('/merchant-portal/quotes', f.staff1(), { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12 }));
      await blocked(f.submit(draft.id));
      await blocked(f.accept(approved.id));
      await blocked(f.acceptOtp(approved.id));
      await blocked(t.postJson(`/merchant-portal/leases/${draft.id}/otp/consent`, f.staff1()));
      // server-driven UI: идэвхгүй мерчантын үйлдэл зөвхөн DELIVER/CANCEL
      expect((await f.get(approved.id)).body.allowedActions).toEqual(['CANCEL']);
      expect((await f.get(toDeliver.id)).body.allowedActions).toEqual(['DELIVER', 'CANCEL']);
      // нээлттэй лизингийг дуусгана
      const delivered = await f.deliver(toDeliver.id, { serialNo: 'SN-SUSP-1' });
      expect(delivered.status).toBe(200);
      expect(delivered.body.status).toBe('DELIVERED');
      expect((await f.cancel(toCancel.id)).status).toBe(200);
      // dashboard, жагсаалт, профайл уншигдана
      expect((await t.getJson('/merchant-portal/dashboard', f.staff1())).status).toBe(200);
      expect((await t.getJson('/merchant-portal/me', f.staff1())).body.merchant.status).toBe('SUSPENDED');

      expect((await setStatus('ACTIVE')).status).toBe(200);
      expect((await f.submit(draft.id)).status).toBe(200); // сэргээгдсэн
      await setStatus('TERMINATED');
      const accepted = await f.get(approved.id);
      expect(accepted.body.allowedActions).toEqual([]);
      await blocked(f.create({ seed: 255 }));
      await blocked(f.accept(approved.id));
      await blocked(f.cancel(approved.id));
      await blocked(f.cancel(draft.id));
      const me = await t.getJson('/merchant-portal/me', f.staff1());
      expect(me.body.merchant.status).toBe('TERMINATED');
      expect(me.body.plans).toEqual([]);
      expect((await setStatus('ACTIVE')).body.code).toBe('INVALID_TRANSITION');
    }));
    it('TERMINATED blocks deliver', async () => {
      const t2 = await TestApp.create();
      try {
        const fx2 = await t2.fixtures();
        const f2 = new PosFlow(t2, fx2);
        const accepted = await f2.toAccepted({ seed: 260 });
        await t2.postJson(`/merchants/${fx2.merchantA.id}/status`, f2.lender(), { status: 'TERMINATED', reason: 'Гэрээ цуцлагдсан' });
        const res = await f2.deliver(accepted.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('MERCHANT_NOT_ACTIVE');
      } finally {
        await t2.close();
      }
    });
    it('PENDING merchants cannot sell', async () => {
      const t2 = await TestApp.create();
      try {
        const fx2 = await t2.fixtures();
        const created = await t2.postJson('/merchants', new PosFlow(t2, fx2).lender(), {
          code: 'PEND', name: 'Хүлээгдэж буй', contactName: 'Д. Дорж', phone: '99001122', branchId: 'BR-X', commissionRate: 0.02, maxTicketAmount: 1_000_000,
          settlement: { bankCode: 'KHAN', accountNo: '5011223344', holderName: 'Хүлээгдэж буй' },
        });
        const personas = t2.personas(created.body.id);
        const res = await t2.postJson('/merchant-portal/quotes', personas.merchantAdmin(), { planCode: 'LAPTOP', goodsPrice: 1_000_000, downPayment: 200_000, termMonths: 12 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('MERCHANT_NOT_ACTIVE');
      } finally {
        await t2.close();
      }
    });
  });

  // ───────────── concurrency ─────────────
  describe('concurrency', () => {
    it('two simultaneous accepts: exactly one succeeds, the other is 409', async () => {
      const approved = await f.toDecided({ seed: 270 });
      t.clock.advanceSeconds(31);
      await f.acceptOtp(approved.id);
      const [x, y] = await Promise.all([f.accept(approved.id), f.accept(approved.id)]);
      const statuses = [x.status, y.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = x.status === 409 ? x : y;
      expect(['CONCURRENT_UPDATE', 'INVALID_TRANSITION', 'OTP_NOT_REQUESTED']).toContain(loser.body.code);
      expect(f.eventTypes(approved.id)).toEqual(['PosLeaseDecided', 'PosLeaseAccepted']); // нэг л event
      expect((await f.get(approved.id)).body.status).toBe('ACCEPTED');
    });
    it('two simultaneous submits: one decision only', async () => {
      const lease = await f.createOk({ seed: 271 });
      const [x, y] = await Promise.all([f.submit(lease.id), f.submit(lease.id)]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect(f.eventTypes(lease.id)).toEqual(['PosLeaseDecided']);
    });
  });

  // ───────────── screening outage ─────────────
  describe('screening outage', () => {
    it('503 SCREENING_UNAVAILABLE keeps the lease DRAFT with consent kept; retry without a code succeeds', async () => {
      const lease = await f.createOk({ seed: 280 });
      t.screening.failing = true;
      const calls = t.screening.calls.length;
      const failed = await f.submit(lease.id, FIXED_OTP);
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('SCREENING_UNAVAILABLE');
      expect(t.screening.calls.length).toBe(calls + 1);
      const after = parseWith(PosLeaseView, (await f.get(lease.id)).body);
      expect(after).toMatchObject({ status: 'DRAFT', decision: { result: null }, allowedActions: ['SUBMIT', 'CANCEL'] }); // RESEND_CONSENT_OTP байхгүй: зөвшөөрөл хадгалагдсан
      expect(after.consentVerifiedAt).toBe(t.clock.now().toISOString());
      expect(f.eventTypes(lease.id)).toEqual([]);
      // кодгүй дахин оролдлого: ойролцоох бүтэлгүйтэл
      expect((await f.submit(lease.id, null)).status).toBe(503);
      t.screening.failing = false;
      const retry = await f.submit(lease.id, null);
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('APPROVED');
      expect(f.eventTypes(lease.id)).toEqual(['PosLeaseDecided']);
      const view = parseWith(PosLeaseView, retry.body);
      expect(view.timeline.filter((e) => e.action === 'CONSENT_VERIFIED')).toHaveLength(1);
    });
  });

  // ───────────── quote validation matrix ─────────────
  describe('quote and create validation (server recomputes everything)', () => {
    const quote = (over: Record<string, unknown>, headers = f.staff1()) => t.postJson('/merchant-portal/quotes', headers, { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, goodsCategory: 'COMPUTER', ...over });
    it.each([
      ['PLAN_NOT_AVAILABLE', 422, { planCode: 'NOPE' }],
      ['GOODS_CATEGORY_NOT_ALLOWED', 422, { goodsCategory: 'GAMES' }],
      ['TERM_NOT_ALLOWED', 422, { termMonths: 5 }],
      ['DOWN_PAYMENT_TOO_LOW', 422, { downPayment: 299_999 }],
      ['DOWN_PAYMENT_TOO_HIGH', 422, { downPayment: 3_000_000 }],
      ['AMOUNT_OUT_OF_RANGE', 422, { goodsPrice: 320_000, downPayment: 32_000 }],
      ['AMOUNT_OUT_OF_RANGE', 422, { goodsPrice: 25_000_000, downPayment: 2_500_000 }],
    ])('%s (%i)', async (code, status, over) => {
      const res = await quote(over);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
    });
    it('down payment minimum is ceil(minRate x price): exactly the minimum passes, one tögrög less fails', async () => {
      expect((await quote({ goodsPrice: 3_000_001, downPayment: 300_001 })).status).toBe(200); // ceil(0.1 × 3 000 001) = 300 001
      expect((await quote({ goodsPrice: 3_000_001, downPayment: 300_000 })).body.code).toBe('DOWN_PAYMENT_TOO_LOW');
      expect((await quote({ goodsPrice: 3_000_000, downPayment: 300_000 })).status).toBe(200); // float шуугиан (0.1 × 3e6) нөлөөлөхгүй
    });
    it('the amount range is inclusive at both ends', async () => {
      expect((await quote({ goodsPrice: 333_334, downPayment: 33_334 })).status).toBe(200); // financed 300 000 = minAmount
      expect((await quote({ goodsPrice: 333_333, downPayment: 33_334 })).body.code).toBe('AMOUNT_OUT_OF_RANGE'); // 299 999
    });
    it('a plan without goodsCategory in the request skips the category check', async () => {
      const { goodsCategory: _c, ...rest } = { planCode: 'LAPTOP', goodsPrice: 3_000_000, downPayment: 600_000, termMonths: 12, goodsCategory: 'GAMES' };
      void _c;
      expect((await t.postJson('/merchant-portal/quotes', f.staff1(), rest)).status).toBe(200);
    });
    it('the same validation applies to lease creation, and nothing is created on failure', async () => {
      const total = (await t.getJson('/merchant-portal/leases', f.admin())).body.total;
      const res = await f.create({ seed: 290, over: { termMonths: 5 } });
      expect(res.body.code).toBe('TERM_NOT_ALLOWED');
      expect((await f.create({ seed: 291, over: { goods: { category: 'GAMES', name: 'Тоглоом', price: 3_000_000 } } })).body.code).toBe('GOODS_CATEGORY_NOT_ALLOWED');
      expect((await t.getJson('/merchant-portal/leases', f.admin())).body.total).toBe(total);
    });
    it('the server ignores client supplied amounts (extra fields are stripped, quote is recomputed)', async () => {
      const lease = await t.postJson('/merchant-portal/leases', f.staff1(), { ...leaseBody(fx.storeA1.id, 0, {}, 292), quote: { monthlyPayment: 1, financedAmount: 1 }, financedAmount: 1 }, keyed('idem-ignore-0001'));
      expect(lease.status).toBe(201);
      expect(lease.body.lease.quote).toMatchObject({ financedAmount: 2_400_000, monthlyPayment: 229_212.46 });
    });
    it('the plan used is frozen into the lease quote even if the plan changes later', async () => {
      const lease = await f.createOk({ seed: 293 });
      await t.patchJson(`/pos-plans/${fx.laptop.id}`, f.lender(), { annualRate: 0.5 });
      const view = parseWith(PosLeaseView, (await f.get(lease.id)).body);
      expect(view.quote.annualRate).toBe(0.24);
      await t.patchJson(`/pos-plans/${fx.laptop.id}`, f.lender(), { annualRate: 0.24 });
    });
  });

  it('deliver stores the optional serial number and keeps the original when omitted', async () => {
    const accepted = await f.toAccepted({ seed: 295 });
    const view = parseWith(PosLeaseView, (await f.deliver(accepted.id, {})).body);
    expect(view.goods.serialNo).toBe('SN-0001');
    expect((await f.deliver(accepted.id, {})).body.code).toBe('INVALID_TRANSITION');
  });
});
