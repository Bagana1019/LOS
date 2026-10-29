import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_1, DEMO_2, createRealModeApp } from './testing/test-app';

type Rig = Awaited<ReturnType<typeof createRealModeApp>>;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => (res: ServerResponse) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(payload);
};
let seq = 0;
const idem = () => `real-key-${String(++seq).padStart(6, '0')}`;

describe('portal-bff e2e (INTEGRATION_MODE=real against a fake origination over HTTP)', () => {
  let rig: Rig;
  let c1: { accessToken: string; refreshToken: string; customerId: string };

  beforeAll(async () => {
    rig = await createRealModeApp({ PORTAL_INTERNAL_TIMEOUT_MS: '300' });
    c1 = await rig.t.login(DEMO_1.registerNo, DEMO_1.phone, '10.9.0.1');
  });
  afterAll(async () => {
    await rig.close();
  });
  beforeEach(() => {
    rig.origination.overrides.length = 0;
    rig.origination.received.length = 0;
  });
  afterEach(() => {
    rig.origination.overrides.length = 0;
  });

  it('OTP is delivered through the origination notification endpoint (never to the client)', async () => {
    const ch = await rig.t.http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.9.0.2').send({ registerNo: DEMO_1.registerNo, phone: DEMO_1.phone }).expect(200);
    expect(JSON.stringify(ch.body)).not.toMatch(/\d{6}/);
    await rig.t.settle(); // SMS арын ажлаар явна
    expect(rig.origination.otpCodes.get(DEMO_1.customerId)).toMatch(/^\d{6}$/);
    const otpCall = rig.origination.received.find((r) => r.path.endsWith('/otp'));
    expect(otpCall?.headers['x-customer-id']).toBe(DEMO_1.customerId);
  });

  it('unknown customer: lookup 404 → same 200 challenge, nothing sent', async () => {
    await rig.t.http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.9.0.3').send({ registerNo: 'УБ11111111', phone: '99000000' }).expect(200);
    await rig.t.settle();
    expect(rig.origination.received.some((r) => r.path.endsWith('/otp'))).toBe(false);
  });

  it('loads loans/balance/schedule through real adapters with trusted-header propagation', async () => {
    const res = await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).set('X-Correlation-Id', 'corr-real-0001').expect(200);
    expect(res.body).toHaveLength(2);
    const call = rig.origination.received.find((r) => r.path === '/api/internal/portal/loans');
    expect(call?.headers).toMatchObject({ 'x-customer-id': DEMO_1.customerId, 'x-actor-type': 'CUSTOMER', 'x-roles': 'CUSTOMER', 'x-correlation-id': 'corr-real-0001' });
    expect(call?.headers.authorization).toBeUndefined(); // харилцагчийн JWT дотоод руу дамжихгүй

    await rig.t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(200);
    const sched = await rig.t.http().get('/api/portal/loans/loan_demo_001/schedule').set(auth(c1.accessToken)).expect(200);
    expect(sched.body.rows).toHaveLength(36);
  });

  it('streams the contract PDF from origination', async () => {
    const res = await rig.t.http().get('/api/portal/loans/loan_demo_001/contract/download').set(auth(c1.accessToken)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.headers['content-disposition']).toContain('B10026102801.pdf');
  });

  it('creates a payment with the Idempotency-Key forwarded downstream; replay does not hit origination again', async () => {
    const key = idem();
    const body = { amountType: 'CUSTOM', method: 'QPAY', amount: 50_000 };
    const first = await rig.t.http().post('/api/portal/loans/loan_demo_001/payments').set(auth(c1.accessToken)).set('Idempotency-Key', key).send(body).expect(201);
    const posts = () => rig.origination.received.filter((r) => r.method === 'POST' && r.path.endsWith('/payments')).length;
    expect(posts()).toBe(1);
    expect(rig.origination.received.find((r) => r.method === 'POST' && r.path.endsWith('/payments'))?.headers['idempotency-key']).toBe(key);
    const replay = await rig.t.http().post('/api/portal/loans/loan_demo_001/payments').set(auth(c1.accessToken)).set('Idempotency-Key', key).send(body).expect(201);
    expect(replay.body.paymentId).toBe(first.body.paymentId);
    expect(posts()).toBe(1);
    const status = await rig.t.http().get(`/api/portal/payments/${first.body.paymentId}`).set(auth(c1.accessToken)).expect(200);
    expect(status.body.status).toBe('PENDING');
  });

  describe('failure handling', () => {
    it('retries an idempotent GET on 503 and succeeds', async () => {
      rig.origination.overrides.push({ match: /\/loans$/, times: 2, respond: reply(503, {}) });
      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200);
      expect(rig.origination.received.filter((r) => r.path === '/api/internal/portal/loans')).toHaveLength(3);
    });

    it('gives up after 3 attempts → 503 DOWNSTREAM_UNAVAILABLE with a correlation id', async () => {
      rig.origination.overrides.push({ match: /\/loans$/, times: 10, respond: reply(503, {}) });
      const res = await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(503);
      expect(res.body.error).toMatchObject({ code: 'DOWNSTREAM_UNAVAILABLE', correlationId: res.headers['x-correlation-id'] });
      expect(rig.origination.received.filter((r) => r.path === '/api/internal/portal/loans')).toHaveLength(3);
    });

    it('never retries a POST; the idempotency key is released so the client can retry safely', async () => {
      const key = idem();
      const body = { amountType: 'CUSTOM', method: 'QPAY', amount: 10_000 };
      rig.origination.overrides.push({ match: /\/loans\/loan_demo_001\/payments$/, times: 1, respond: reply(503, {}) });
      // харьяалал шалгах `GET /loans` дуудлага дундуур override-ыг идэхгүйн тулд эхлээд owned cache-ийг дулаацуулна
      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200);
      rig.origination.received.length = 0;
      await rig.t.http().post('/api/portal/loans/loan_demo_001/payments').set(auth(c1.accessToken)).set('Idempotency-Key', key).send(body).expect(503);
      expect(rig.origination.received.filter((r) => r.method === 'POST')).toHaveLength(1);
      await rig.t.http().post('/api/portal/loans/loan_demo_001/payments').set(auth(c1.accessToken)).set('Idempotency-Key', key).send(body).expect(201);
    });

    it('times out slow downstream calls', async () => {
      rig.origination.overrides.push({ match: /\/loans$/, times: 3, respond: () => undefined /* хариу өгөхгүй */ });
      const started = Date.now();
      const res = await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(503);
      expect(res.body.error.code).toBe('DOWNSTREAM_UNAVAILABLE');
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('maps downstream 404 to LOAN_NOT_FOUND and passes through known business codes only', async () => {
      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200); // owned cache
      rig.origination.overrides.push({ match: /\/loan_demo_001\/balance$/, times: 1, respond: reply(404, { error: { code: 'LOAN_NOT_FOUND' } }) });
      const nf = await rig.t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(404);
      expect(nf.body.error.code).toBe('LOAN_NOT_FOUND');

      rig.origination.overrides.push({ match: /\/loan_demo_001\/payments$/, times: 1, respond: reply(409, { error: { code: 'LOAN_NOT_PAYABLE' } }) });
      const biz = await rig.t.http().post('/api/portal/loans/loan_demo_001/payments').set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'CUSTOM', method: 'QPAY', amount: 1000 }).expect(409);
      expect(biz.body.error.code).toBe('LOAN_NOT_PAYABLE');

      rig.origination.overrides.push({ match: /\/loan_demo_001\/payments$/, times: 1, respond: reply(422, { error: { code: 'SOME_INTERNAL_RULE', secret: 'x' } }) });
      const unknown = await rig.t.http().post('/api/portal/loans/loan_demo_001/payments').set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'CUSTOM', method: 'QPAY', amount: 1000 }).expect(502);
      expect(unknown.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
      expect(JSON.stringify(unknown.body)).not.toContain('SOME_INTERNAL_RULE');
    });

    it('rejects malformed downstream payloads (502) and strips fields outside the contract', async () => {
      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200);
      rig.origination.overrides.push({ match: /\/loan_demo_001\/balance$/, times: 1, respond: reply(200, '{not json') });
      const bad = await rig.t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(502);
      expect(bad.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');

      rig.origination.overrides.push({ match: /\/loan_demo_001\/balance$/, times: 1, respond: reply(200, { loanId: 'loan_demo_001' }) });
      await rig.t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(502);

      const real = rig.origination.ledger.getBalance(DEMO_1.customerId, 'loan_demo_001');
      rig.origination.overrides.push({ match: /\/loan_demo_001\/balance$/, times: 1, respond: reply(200, { ...real, internalRiskScore: 987, collateralNote: 'secret' }) });
      const ok = await rig.t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(200);
      expect(ok.body.internalRiskScore).toBeUndefined();
      expect(JSON.stringify(ok.body)).not.toContain('secret');
    });

    it('defends in depth: a downstream answer about another loan/payment is never shown', async () => {
      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200);
      const other = rig.origination.ledger.getBalance(DEMO_2.customerId, 'loan_demo_003');
      rig.origination.overrides.push({ match: /\/loan_demo_001\/balance$/, times: 1, respond: reply(200, other) });
      await rig.t.http().get('/api/portal/loans/loan_demo_001/balance').set(auth(c1.accessToken)).expect(502);

      const pay = rig.origination.ledger.createPayment(DEMO_2.customerId, { loanId: 'loan_demo_003', method: 'QPAY', amountType: 'CUSTOM', amount: 1000, currency: 'MNT' }, 'other-cust-key-1');
      rig.origination.overrides.push({ match: /\/payments\/.+$/, times: 1, respond: reply(200, pay) });
      const res = await rig.t.http().get(`/api/portal/payments/${pay.paymentId}`).set(auth(c1.accessToken)).expect(404);
      expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
    });

    it('does not follow redirects and rejects non-PDF contract bodies', async () => {
      // Redirect-ийн зорилтот хаяг нь ӨӨРӨӨ origination (бодит, хүрч болох хаяг): дагавал `received`-д заавал харагдана.
      // Тестийн хост дээрх сүлжээний байдлаас (metadata IP зэрэг) үл хамаарна.
      const target = `${rig.origination.url}/api/internal/portal/loans?followed=1`;
      rig.origination.overrides.push({ match: /\/loans$/, times: 3, respond: reply(302, {}, { Location: target }) });
      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(503);
      expect(rig.origination.received.filter((r) => r.path.includes('followed=1'))).toHaveLength(0);

      await rig.t.http().get('/api/portal/loans').set(auth(c1.accessToken)).expect(200);
      rig.origination.overrides.push({ match: /\/contract\/content$/, times: 1, respond: reply(200, '<html>not a pdf</html>', { 'Content-Type': 'text/html' }) });
      const res = await rig.t.http().get('/api/portal/loans/loan_demo_001/contract/download').set(auth(c1.accessToken)).expect(502);
      expect(res.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });
  });
});
