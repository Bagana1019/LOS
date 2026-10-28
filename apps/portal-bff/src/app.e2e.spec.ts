import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PortalErrorBody } from '@los/contracts';
import { DEMO_1, DEMO_2, type TestApp, createTestApp } from './testing/test-app';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const idem = () => `test-key-${String(++seq).padStart(6, '0')}`;
const creds = (d: { registerNo: string; phone: string }) => ({ registerNo: d.registerNo, phone: d.phone });

describe('portal-bff e2e (mock integrations)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('health & transport hardening', () => {
    it('GET /api/health is public', async () => {
      const res = await t.http().get('/api/health').expect(200);
      expect(res.body).toEqual({ service: 'portal-bff', ok: true });
    });

    it('sets no-store, correlation id and security headers; echoes a safe incoming correlation id', async () => {
      const res = await t.http().get('/api/health').set('X-Correlation-Id', 'abc-12345678').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-correlation-id']).toBe('abc-12345678');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('replaces an unsafe correlation id', async () => {
      const res = await t.http().get('/api/health').set('X-Correlation-Id', 'bad id\twith spaces').expect(200);
      expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns the uniform error body with Mongolian message for unknown routes and bad JSON', async () => {
      const notFound = await t.http().get('/api/nope').expect(404);
      expect(() => PortalErrorBody.parse(notFound.body)).not.toThrow();
      expect(notFound.body.error.code).toBe('NOT_FOUND');
      const bad = await t.http().post('/api/portal/auth/otp').set('Content-Type', 'application/json').send('{bad json').expect(400);
      expect(bad.body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects oversized bodies', async () => {
      await t.http().post('/api/portal/auth/otp').send({ registerNo: 'x'.repeat(200_000), phone: '1' }).expect(413);
    });
  });

  describe('authentication', () => {
    it('requires a token on every non-public route', async () => {
      for (const path of ['/api/portal/me', '/api/portal/loans', '/api/portal/loans/loan_demo_001', '/api/portal/loans/loan_demo_001/balance', '/api/portal/loans/loan_demo_001/schedule', '/api/portal/loans/loan_demo_001/contract', '/api/portal/loans/loan_demo_001/contract/download', '/api/portal/loans/loan_demo_001/payment-options', '/api/portal/loans/loan_demo_001/payments', '/api/portal/payments/pay_x']) {
        const res = await t.http().get(path).expect(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
        expect(res.headers['www-authenticate']).toBe('Bearer');
      }
      await t.http().post('/api/portal/loans/loan_demo_001/payments').send({}).expect(401);
      await t.http().post('/api/portal/auth/logout').expect(401);
    });

    it('rejects malformed, forged and wrong-audience tokens', async () => {
      await t.http().get('/api/portal/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
      await t.http().get('/api/portal/me').set('Authorization', 'Basic abc').expect(401);
      // alg=none
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: DEMO_1.customerId, sid: 'x', typ: 'access', exp: 9999999999 })).toString('base64url')}.`;
      await t.http().get('/api/portal/me').set('Authorization', `Bearer ${none}`).expect(401);
    });

    it('full login → profile; OTP is single-use', async () => {
      const ch = await t.http().post('/api/portal/auth/otp').send({ registerNo: 'уб90010112', phone: '+976 9911-2233' }).expect(200);
      expect(ch.body).toMatchObject({ maskedDestination: '99****33', expiresInSec: 300 });
      const code = t.otp.lastCodeFor(DEMO_1.customerId) as string;
      expect(code).toMatch(/^\d{6}$/);

      const ok = await t.http().post('/api/portal/auth/verify').send({ challengeId: ch.body.challengeId, code }).expect(200);
      expect(ok.body).toMatchObject({ tokenType: 'Bearer', expiresInSec: 600 });
      const me = await t.http().get('/api/portal/me').set(auth(ok.body.accessToken)).expect(200);
      expect(me.body).toEqual({ displayName: 'Б. Болд', phoneMasked: '99****33' });

      const again = await t.http().post('/api/portal/auth/verify').send({ challengeId: ch.body.challengeId, code }).expect(400);
      expect(again.body.error.code).toBe('OTP_EXPIRED');
    });

    it('does not reveal whether a customer exists (same response shape; verify fails the same way)', async () => {
      const real = await t.http().post('/api/portal/auth/otp').send(creds(DEMO_1)).expect(200);
      const fake = await t.http().post('/api/portal/auth/otp').send({ registerNo: 'УБ11111111', phone: '99000000' }).expect(200);
      expect(Object.keys(fake.body).sort()).toEqual(Object.keys(real.body).sort());
      const wrong = await t.http().post('/api/portal/auth/verify').send({ challengeId: real.body.challengeId, code: '000000' }).expect(400);
      const wrongFake = await t.http().post('/api/portal/auth/verify').send({ challengeId: fake.body.challengeId, code: '000000' }).expect(400);
      expect(wrong.body.error.code).toBe('OTP_INVALID');
      expect(wrongFake.body.error.code).toBe('OTP_INVALID');
    });

    it('locks a challenge after too many wrong codes, even if the right code follows', async () => {
      const ch = await t.http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.1.1.1').send(creds(DEMO_2)).expect(200);
      const code = t.otp.lastCodeFor(DEMO_2.customerId) as string;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const r = await t.http().post('/api/portal/auth/verify').set('X-Forwarded-For', '10.1.1.1').send({ challengeId: ch.body.challengeId, code: wrong }).expect(400);
        expect(r.body.error.code).toBe('OTP_INVALID');
      }
      const locked = await t.http().post('/api/portal/auth/verify').set('X-Forwarded-For', '10.1.1.1').send({ challengeId: ch.body.challengeId, code }).expect(429);
      expect(locked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    });

    it('expires OTP after the TTL', async () => {
      const ch = await t.http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.1.1.2').send(creds(DEMO_1)).expect(200);
      const code = t.otp.lastCodeFor(DEMO_1.customerId) as string;
      t.clock.advance(301_000);
      const res = await t.http().post('/api/portal/auth/verify').set('X-Forwarded-For', '10.1.1.2').send({ challengeId: ch.body.challengeId, code }).expect(400);
      expect(res.body.error.code).toBe('OTP_EXPIRED');
    });

    it('rate-limits OTP requests per register number (default 5/hour)', async () => {
      const strict = await createTestApp({ PORTAL_OTP_REQUESTS_PER_HOUR: '5', PORTAL_OTP_REQUESTS_PER_HOUR_PER_IP: '1000' });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 7; i++) {
          const res = await strict.http().post('/api/portal/auth/otp').set('X-Forwarded-For', `10.2.0.${i}`).send({ registerNo: 'УБ22222222', phone: '99000001' });
          statuses.push(res.status);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
        // нэг цагийн дараа сэргэнэ
        strict.clock.advance(3_601_000);
        await strict.http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.2.0.99').send({ registerNo: 'УБ22222222', phone: '99000001' }).expect(200);
      } finally {
        await strict.app.close();
      }
    });

    it('enforces resend cooldown when configured', async () => {
      const cool = await createTestApp({ PORTAL_OTP_RESEND_SEC: '60' });
      try {
        await cool.http().post('/api/portal/auth/otp').send(creds(DEMO_1)).expect(200);
        const second = await cool.http().post('/api/portal/auth/otp').send(creds(DEMO_1)).expect(429);
        expect(second.body.error.code).toBe('RATE_LIMITED');
        expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
      } finally {
        await cool.app.close();
      }
    });

    it('access token expires; refresh rotates; reusing an old refresh token revokes the session', async () => {
      const s = await t.login(DEMO_1.registerNo, DEMO_1.phone, '10.3.0.1');
      t.clock.advance(601_000);
      await t.http().get('/api/portal/me').set(auth(s.accessToken)).expect(401);

      const r1 = await t.http().post('/api/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      await t.http().get('/api/portal/me').set(auth(r1.body.accessToken)).expect(200);

      // эхний refresh токеныг дахин ашиглах = хулгайн шинж → тухайн session (token family) хүчингүй
      const reuse = await t.http().post('/api/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
      expect(reuse.body.error.code).toBe('UNAUTHENTICATED');
      await t.http().get('/api/portal/me').set(auth(r1.body.accessToken)).expect(401);
      await t.http().post('/api/portal/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
      expect(t.audit.actions()).toContain('AUTH_REFRESH_REUSE_DETECTED');
    });

    it('logout revokes the session immediately', async () => {
      const s = await t.login(DEMO_1.registerNo, DEMO_1.phone, '10.3.0.2');
      await t.http().post('/api/portal/auth/logout').set(auth(s.accessToken)).expect(204);
      await t.http().get('/api/portal/me').set(auth(s.accessToken)).expect(401);
      await t.http().post('/api/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    });

    it('never writes registers, phones, OTP codes or tokens to the audit trail', async () => {
      const s = await t.login(DEMO_1.registerNo, DEMO_1.phone, '10.3.0.3');
      const dump = JSON.stringify(t.audit.records);
      for (const secret of [DEMO_1.registerNo, DEMO_1.phone, s.accessToken, s.refreshToken, t.otp.lastCodeFor(DEMO_1.customerId) as string]) {
        expect(dump).not.toContain(secret);
      }
    });
  });

  describe('loans, balance, schedule', () => {
    let c1: Awaited<ReturnType<TestApp['login']>>;
    let c2: Awaited<ReturnType<TestApp['login']>>;
    beforeEach(async () => {
      c1 = await t.login(DEMO_1.registerNo, DEMO_1.phone, '10.4.0.1');
      c2 = await t.login(DEMO_2.registerNo, DEMO_2.phone, '10.4.0.2');
    });

    it('lists only the caller’s loans with balance summary', async () => {
      const a = await t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200);
      expect(a.body.map((l: { loanId: string }) => l.loanId).sort()).toEqual(['loan_demo_001', 'loan_demo_002']);
      const active = a.body.find((l: { loanId: string }) => l.loanId === 'loan_demo_001');
      expect(active).toMatchObject({ status: 'ACTIVE', overdueAmount: 0, termMonths: 36, annualInterestRatePercent: 23.99 });
      expect(active.nextInstallment).toMatchObject({ seq: 12, dueDate: '2026-11-18', amountDue: 1176828.07 });

      const b = await t.http().get('/api/portal/loans').set(auth(c2.accessToken)).expect(200);
      expect(b.body.map((l: { loanId: string }) => l.loanId)).toEqual(['loan_demo_003']);
      expect(b.body[0]).toMatchObject({ overdueDays: 66, overdueAmount: 2924613.81 });
    });

    it('returns balance with payoff amount', async () => {
      const res = await t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(200);
      expect(res.body.outstandingPrincipal).toBe(22977999.41);
      expect(res.body.payoff.amount).toBeCloseTo(res.body.outstandingPrincipal + res.body.accruedInterest, 2);
      expect(res.body.payoff.validUntil).toBe('2026-10-28');
    });

    it('returns the schedule with FR-7.2 columns and row statuses', async () => {
      const res = await t.http().get('/api/portal/loans/loan_demo_001/schedule').set(auth(c1.accessToken)).expect(200);
      expect(res.body.rows).toHaveLength(36);
      expect(res.body.rows[0]).toMatchObject({ seq: 1, status: 'PAID' });
      expect(res.body.rows[11]).toMatchObject({ seq: 12, status: 'UPCOMING', paidAmount: 0 });
      expect(res.body.rows[35].balance).toBe(0);
      expect(res.body.totals.principal).toBe(30_000_000);
      const overdue = await t.http().get('/api/portal/loans/loan_demo_003/schedule').set(auth(c2.accessToken)).expect(200);
      expect(overdue.body.rows.filter((r: { status: string }) => r.status === 'OVERDUE')).toHaveLength(3);
    });

    it('returns 404 (not 403) for another customer’s loan on every loan route', async () => {
      for (const suffix of ['', '/balance', '/schedule', '/contract', '/contract/download', '/payment-options', '/payments']) {
        const res = await t.http().get(`/api/portal/loans/loan_demo_003${suffix}`).set(auth(c1.accessToken)).expect(404);
        expect(res.body.error.code).toBe('LOAN_NOT_FOUND');
      }
      await t.http().post('/api/portal/loans/loan_demo_003/payments').set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'PAYOFF', method: 'QPAY' }).expect(404);
    });

    it('rejects malformed ids', async () => {
      const res = await t.http().get('/api/portal/loans/..%2F..%2Fetc').set(auth(c1.accessToken));
      expect([400, 404]).toContain(res.status);
      await t.http().get(`/api/portal/loans/${'a'.repeat(65)}`).set(auth(c1.accessToken)).expect(400);
    });
  });

  describe('contract download', () => {
    it('streams the PDF with safe headers and audits the download', async () => {
      const c = await t.login(DEMO_1.registerNo, DEMO_1.phone, '10.5.0.1');
      const info = await t.http().get('/api/portal/loans/loan_demo_001/contract').set(auth(c.accessToken)).expect(200);
      expect(info.body).toMatchObject({ contractNo: 'B10026102801', signed: true, mime: 'application/pdf' });

      const res = await t.http().get('/api/portal/loans/loan_demo_001/contract/download').set(auth(c.accessToken)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="B10026102801.pdf"; filename*=UTF-8\'\'B10026102801.pdf');
      expect(res.headers['cache-control']).toBe('no-store');
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect(t.audit.records.some((r) => r.action === 'CONTRACT_DOWNLOADED' && r.customerId === DEMO_1.customerId && r.target?.id === 'loan_demo_001')).toBe(true);
    });
  });

  describe('payments', () => {
    // Төлбөр ledger-ийн төлөвийг өөрчилдөг тул тест бүр шинэ апп (шинэ fixture, шинэ rate-limit цонх)
    let p: TestApp;
    let c2: Awaited<ReturnType<TestApp['login']>>;
    beforeEach(async () => {
      p = await createTestApp();
      c2 = await p.login(DEMO_2.registerNo, DEMO_2.phone, '10.6.0.1');
    });
    afterEach(async () => {
      await p.app.close();
    });
    const create = (token: string, body: unknown, key: string | null = idem(), loan = 'loan_demo_003') => {
      const req = p.http().post(`/api/portal/loans/${loan}/payments`).set(auth(token)).send(body as object);
      return key ? req.set('Idempotency-Key', key) : req;
    };

    it('offers installment / overdue / payoff amounts and method limits', async () => {
      const res = await p.http().get('/api/portal/loans/loan_demo_003/payment-options').set(auth(c2.accessToken)).expect(200);
      expect(res.body.installment).toMatchObject({ seq: 3, amount: 974871.27 });
      expect(res.body.overdue).toMatchObject({ amount: 2924613.81, days: 66 });
      expect(res.body.methods.map((m: { method: string }) => m.method)).toEqual(['QPAY', 'SOCIALPAY', 'BANK_ACCOUNT']);
    });

    it('requires Idempotency-Key and validates its format', async () => {
      const missing = await create(c2.accessToken, { amountType: 'INSTALLMENT', method: 'QPAY' }, null).expect(400);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const bad = await create(c2.accessToken, { amountType: 'INSTALLMENT', method: 'QPAY' }, 'short').expect(400);
      expect(bad.body.error.code).toBe('INVALID_REQUEST');
    });

    it('validates the body: CUSTOM needs amount, others forbid it, max 2 decimals, unknown fields rejected', async () => {
      for (const body of [
        { amountType: 'CUSTOM', method: 'QPAY' },
        { amountType: 'INSTALLMENT', method: 'QPAY', amount: 100 },
        { amountType: 'CUSTOM', method: 'QPAY', amount: 100.555 },
        { amountType: 'CUSTOM', method: 'QPAY', amount: -5 },
        { amountType: 'CUSTOM', method: 'CASH', amount: 5 },
        { amountType: 'CUSTOM', method: 'QPAY', amount: 5, loanId: 'loan_demo_001' },
      ]) {
        const res = await create(c2.accessToken, body).expect(400);
        expect(res.body.error.code).toBe('INVALID_REQUEST');
      }
    });

    it('never trusts a client amount for server-determined types: overdue payment uses the server amount', async () => {
      const res = await create(c2.accessToken, { amountType: 'OVERDUE', method: 'QPAY' }).expect(201);
      expect(res.body).toMatchObject({ amount: 2924613.81, currency: 'MNT', status: 'PENDING', amountType: 'OVERDUE' });
      expect(res.body.checkout.qrText).toContain(res.body.paymentId);
    });

    it('rejects over-payment, below-minimum and unavailable states with business error codes', async () => {
      const over = await create(c2.accessToken, { amountType: 'CUSTOM', method: 'QPAY', amount: 9_139_411.32 }).expect(422);
      expect(over.body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
      const tiny = await create(c2.accessToken, { amountType: 'CUSTOM', method: 'BANK_ACCOUNT', amount: 500 }).expect(422);
      expect(tiny.body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
      const c1 = await p.login(DEMO_1.registerNo, DEMO_1.phone, '10.6.0.9');
      const noOverdue = await create(c1.accessToken, { amountType: 'OVERDUE', method: 'QPAY' }, idem(), 'loan_demo_001').expect(409);
      expect(noOverdue.body.error.code).toBe('NO_OVERDUE');
      const closed = await create(c1.accessToken, { amountType: 'PAYOFF', method: 'QPAY' }, idem(), 'loan_demo_002').expect(409);
      expect(closed.body.error.code).toBe('LOAN_NOT_PAYABLE');
      expect(p.audit.records.filter((r) => r.action === 'PAYMENT_REJECTED').length).toBeGreaterThanOrEqual(3);
    });

    it('is idempotent: same key+body replays the first response, a different body is a conflict, and only one payment exists', async () => {
      const key = idem();
      const body = { amountType: 'CUSTOM', method: 'SOCIALPAY', amount: 123456.78 };
      const first = await create(c2.accessToken, body, key).expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const second = await create(c2.accessToken, body, key).expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.paymentId).toBe(first.body.paymentId);
      const clash = await create(c2.accessToken, { ...body, amount: 1000 }, key).expect(422);
      expect(clash.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const history = await p.http().get('/api/portal/loans/loan_demo_003/payments?limit=50').set(auth(c2.accessToken)).expect(200);
      expect(history.body.items.filter((p: { paymentId: string }) => p.paymentId === first.body.paymentId)).toHaveLength(1);
    });

    it('concurrent duplicate submissions create exactly one payment', async () => {
      const key = idem();
      const body = { amountType: 'CUSTOM', method: 'QPAY', amount: 5000 };
      const results = await Promise.all(Array.from({ length: 5 }, () => create(c2.accessToken, body, key)));
      const created = results.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === undefined);
      expect(created).toHaveLength(1);
      for (const r of results) expect([201, 409]).toContain(r.status);
      const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.paymentId));
      expect(ids.size).toBe(1);
    });

    it('PENDING → PAID after the provider confirms; balance, schedule and history reflect it', async () => {
      const before = await p.http().get('/api/portal/loans/loan_demo_003/balance').set(auth(c2.accessToken)).expect(200);
      const created = await create(c2.accessToken, { amountType: 'OVERDUE', method: 'QPAY' }).expect(201);

      const pending = await p.http().get(`/api/portal/payments/${created.body.paymentId}`).set(auth(c2.accessToken)).expect(200);
      expect(pending.body.status).toBe('PENDING');
      expect(pending.body.postedAt).toBeNull();

      p.clock.advance(1500);
      const paid = await p.http().get(`/api/portal/payments/${created.body.paymentId}`).set(auth(c2.accessToken)).expect(200);
      expect(paid.body).toMatchObject({ status: 'PAID', checkout: null });
      expect(paid.body.paidAt).not.toBeNull();
      expect(paid.body.postedAt).not.toBeNull();

      const after = await p.http().get('/api/portal/loans/loan_demo_003/balance').set(auth(c2.accessToken)).expect(200);
      expect(after.body.overdue.total).toBe(0);
      expect(after.body.outstandingPrincipal).toBeLessThan(before.body.outstandingPrincipal);
      const schedule = await p.http().get('/api/portal/loans/loan_demo_003/schedule').set(auth(c2.accessToken)).expect(200);
      expect(schedule.body.rows.filter((r: { status: string }) => r.status === 'OVERDUE')).toHaveLength(0);
      expect(p.audit.actions()).toContain('PAYMENT_CREATED');
    });

    it('a pending payment expires, and a failed payment carries the reason', async () => {
      const slow = await createTestApp({ PORTAL_MOCK_PAYMENT_CONFIRM_MS: '3600000', PORTAL_ACCESS_TTL_SEC: '3600' });
      try {
        const s = await slow.login(DEMO_2.registerNo, DEMO_2.phone, '10.7.0.1');
        const pending = await slow.http().post('/api/portal/loans/loan_demo_003/payments').set(auth(s.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'INSTALLMENT', method: 'QPAY' }).expect(201);
        slow.clock.advance(16 * 60_000);
        const expired = await slow.http().get(`/api/portal/payments/${pending.body.paymentId}`).set(auth(s.accessToken)).expect(200);
        expect(expired.body.status).toBe('EXPIRED');
      } finally {
        await slow.app.close();
      }

      p.ledger.failNextPayment('INSUFFICIENT_FUNDS');
      const failing = await create(c2.accessToken, { amountType: 'INSTALLMENT', method: 'SOCIALPAY' }).expect(201);
      p.clock.advance(1500);
      const failed = await p.http().get(`/api/portal/payments/${failing.body.paymentId}`).set(auth(c2.accessToken)).expect(200);
      expect(failed.body).toMatchObject({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' });
    });

    it('another customer cannot read a payment by id', async () => {
      const created = await create(c2.accessToken, { amountType: 'INSTALLMENT', method: 'QPAY' }).expect(201);
      const c1 = await p.login(DEMO_1.registerNo, DEMO_1.phone, '10.6.0.8');
      const res = await p.http().get(`/api/portal/payments/${created.body.paymentId}`).set(auth(c1.accessToken)).expect(404);
      expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
    });

    it('paginates payment history newest-first', async () => {
      const c = await p.login(DEMO_2.registerNo, DEMO_2.phone, '10.6.0.7');
      for (let i = 0; i < 3; i++) {
        p.clock.advance(1000);
        await create(c.accessToken, { amountType: 'CUSTOM', method: 'QPAY', amount: 1000 + i }).expect(201);
      }
      const p1 = await p.http().get('/api/portal/loans/loan_demo_003/payments?limit=2').set(auth(c.accessToken)).expect(200);
      expect(p1.body.items).toHaveLength(2);
      expect(p1.body.nextCursor).not.toBeNull();
      expect(new Date(p1.body.items[0].createdAt) >= new Date(p1.body.items[1].createdAt)).toBe(true);
      const p2 = await p.http().get(`/api/portal/loans/loan_demo_003/payments?limit=2&cursor=${p1.body.nextCursor}`).set(auth(c.accessToken)).expect(200);
      expect(p2.body.items.every((i: { paymentId: string }) => !p1.body.items.some((j: { paymentId: string }) => j.paymentId === i.paymentId))).toBe(true);
      await p.http().get('/api/portal/loans/loan_demo_003/payments?limit=0').set(auth(c.accessToken)).expect(400);
    });

    it('rate-limits payment creation per customer (10/min)', async () => {
      const fresh = await createTestApp();
      try {
        const c = await fresh.login(DEMO_2.registerNo, DEMO_2.phone, '10.6.0.6');
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) {
          const res = await fresh.http().post('/api/portal/loans/loan_demo_003/payments').set(auth(c.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'CUSTOM', method: 'QPAY', amount: 1000 });
          statuses.push(res.status);
        }
        expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
        expect(statuses.slice(10)).toEqual([429, 429]);
      } finally {
        await fresh.app.close();
      }
    });

    it('paying off closes the loan and clears the schedule', async () => {
      const c = await p.login(DEMO_2.registerNo, DEMO_2.phone, '10.6.0.5');
      const payoff = await create(c.accessToken, { amountType: 'PAYOFF', method: 'BANK_ACCOUNT' }).expect(201);
      p.clock.advance(1500);
      await p.http().get(`/api/portal/payments/${payoff.body.paymentId}`).set(auth(c.accessToken)).expect(200);
      const loans = await p.http().get('/api/portal/loans').set(auth(c.accessToken)).expect(200);
      expect(loans.body[0]).toMatchObject({ status: 'CLOSED', outstandingPrincipal: 0, overdueAmount: 0, nextInstallment: null });
      const again = await create(c.accessToken, { amountType: 'PAYOFF', method: 'QPAY' }).expect(409);
      expect(again.body.error.code).toBe('LOAN_NOT_PAYABLE');
    });
  });
});
