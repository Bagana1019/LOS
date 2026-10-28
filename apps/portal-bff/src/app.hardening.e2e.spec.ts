import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_1, DEMO_2, createRealModeApp, createTestApp, type TestApp } from './testing/test-app';

/**
 * Олон талт review-ээр баталгаажсан дутагдлуудын регрессийн тест: нэвтрэлтийн хамгаалалт, объект түвшний эрх,
 * PDF stream-ийн бүрэн бүтэн байдал, алдааны гэрээ. Тест бүр засвараа буцаавал унадаг (mutation-аар шалгасан).
 */
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => (res: ServerResponse) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
let seq = 0;
const idem = () => `hard-key-${String(++seq).padStart(6, '0')}`;
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

describe('hardening (mock integrations)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ PORTAL_OTP_REQUESTS_PER_HOUR: '5', PORTAL_OTP_REQUESTS_PER_HOUR_PER_IP: '1000' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('OTP request quotas', () => {
    const otp = (registerNo: string, phone: string, ip = '10.20.0.1') => t.http().post('/api/portal/auth/otp').set('X-Forwarded-For', ip).send({ registerNo, phone });

    it('someone who knows only a register number (or only a phone) cannot lock its owner out, however many requests they send', async () => {
      // Хэдэн ч өөр IP-ээс, 60 удаа (хуучин identity-wide 30/цагийн хязгаараас олон): хос бүр өөр тул хос тус бүрийн хязгаарт хүрэхгүй
      for (let i = 0; i < 60; i++) await otp(DEMO_1.registerNo, `9900${String(i).padStart(4, '0')}`, `198.51.100.${i + 1}`).expect(200);
      for (let i = 0; i < 60; i++) await otp(`УБ${String(10000000 + i)}`, DEMO_1.phone, `203.0.113.${i + 1}`).expect(200);
      await otp(DEMO_1.registerNo, DEMO_1.phone, '192.0.2.77').expect(200); // эзэн нь нэвтэрч чадна
      await t.settle();
      expect(t.otp.lastCodeFor(DEMO_1.customerId)).toMatch(/^\d{6}$/);
    });

    it('the per-pair quota (5/hour) still stops SMS bombing of one customer', async () => {
      for (let i = 0; i < 5; i++) await otp('УБ22222222', '99220022').expect(200);
      const blocked = await otp('УБ22222222', '99220022').expect(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

  });

  it('the documented mock login works with the default fixed code 123456', async () => {
    const ch = await t.http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.20.1.1').send({ registerNo: DEMO_1.registerNo, phone: DEMO_1.phone }).expect(200);
    await t.http().post('/api/portal/auth/verify').set('X-Forwarded-For', '10.20.1.1').send({ challengeId: ch.body.challengeId, code: '123456' }).expect(200);
  });

  describe('request context on parser errors', () => {
    it('malformed JSON keeps the caller correlation id and no-store headers', async () => {
      const res = await t.http().post('/api/portal/auth/otp').set('Content-Type', 'application/json').set('X-Correlation-Id', 'corr-bad-json-1').send('{bad').expect(400);
      expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST', correlationId: 'corr-bad-json-1' });
      expect(res.headers['x-correlation-id']).toBe('corr-bad-json-1');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('an oversized body is 413 PAYLOAD_TOO_LARGE with a correlation id', async () => {
      const res = await t.http().post('/api/portal/auth/otp').set('Content-Type', 'application/json').send(JSON.stringify({ registerNo: 'x'.repeat(200_000) })).expect(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(res.body.error.correlationId).not.toBe('unknown');
      expect(res.headers['x-correlation-id']).toBe(res.body.error.correlationId);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  it('refresh-token reuse is detected even when the stale token is several rotations old', async () => {
    const s = await t.login(DEMO_1.registerNo, DEMO_1.phone, '10.20.2.1');
    const r1 = await t.http().post('/api/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    const r2 = await t.http().post('/api/portal/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(200);
    const r3 = await t.http().post('/api/portal/auth/refresh').send({ refreshToken: r2.body.refreshToken }).expect(200);
    const before = t.audit.actions().filter((a) => a === 'AUTH_REFRESH_REUSE_DETECTED').length;
    await t.http().post('/api/portal/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401); // 3 эргэлтийн өмнөх токен
    expect(t.audit.actions().filter((a) => a === 'AUTH_REFRESH_REUSE_DETECTED')).toHaveLength(before + 1);
    await t.http().get('/api/portal/me').set(auth(r3.body.accessToken)).expect(401);
    await t.http().post('/api/portal/auth/refresh').send({ refreshToken: r3.body.refreshToken }).expect(401);
  });

  it('payment-options advertise exactly the amounts a payment is created for', async () => {
    const s = await t.login(DEMO_2.registerNo, DEMO_2.phone, '10.20.3.1');
    const opts = await t.http().get('/api/portal/loans/loan_demo_003/payment-options').set(auth(s.accessToken)).expect(200);
    for (const [amountType, advertised] of [
      ['INSTALLMENT', opts.body.installment.amount],
      ['OVERDUE', opts.body.overdue.amount],
      ['PAYOFF', opts.body.payoff.amount],
    ] as const) {
      const created = await t.http().post('/api/portal/loans/loan_demo_003/payments').set(auth(s.accessToken)).set('Idempotency-Key', idem()).send({ amountType, method: 'QPAY' }).expect(201);
      expect(created.body.amount, amountType).toBe(advertised);
    }
  });
});

describe('hardening (INTEGRATION_MODE=real, fake origination over HTTP)', () => {
  let rig: Awaited<ReturnType<typeof createRealModeApp>>;
  let c1: { accessToken: string; refreshToken: string; customerId: string };
  const L1 = 'loan_demo_001';
  const L2 = 'loan_demo_002';
  const L3 = 'loan_demo_003'; // cust_demo_002-ийнх

  beforeAll(async () => {
    rig = await createRealModeApp({ PORTAL_INTERNAL_TIMEOUT_MS: '500' });
    c1 = await rig.t.login(DEMO_1.registerNo, DEMO_1.phone, '10.21.0.1');
  });
  afterAll(async () => {
    await rig.close();
  });
  beforeEach(() => {
    rig.origination.overrides.length = 0;
    rig.origination.received.length = 0;
  });
  const http = () => rig.t.http();
  const ledger = () => rig.origination.ledger;

  describe('OTP delivery', () => {
    const ask = (registerNo: string, phone: string) => http().post('/api/portal/auth/otp').set('X-Forwarded-For', '10.21.1.1').send({ registerNo, phone });

    it('is not awaited and its failure is invisible: known and unknown pairs get the same response', async () => {
      let held: ServerResponse | undefined;
      rig.origination.overrides.push({ match: /\/otp$/, times: 1, respond: (res) => void (held = res) }); // origination SMS-ийг гацаана
      const known = await ask(DEMO_1.registerNo, DEMO_1.phone).expect(200); // downstream дуусаагүй байхад хариу ирнэ
      expect(await until(() => held !== undefined)).toBe(true);

      held?.writeHead(503, { 'Content-Type': 'application/json' });
      held?.end('{}');
      await rig.t.settle();
      expect(rig.t.audit.actions()).toContain('AUTH_OTP_SEND_FAILED');

      const unknown = await ask('УБ11111111', '99000000').expect(200);
      expect(Object.keys(known.body).sort()).toEqual(Object.keys(unknown.body).sort());
      expect(known.body.maskedDestination).toMatch(/\*/);
      expect(known.body.expiresInSec).toBe(unknown.body.expiresInSec);
      expect(known.body.resendAfterSec).toBe(unknown.body.resendAfterSec);
    });

    it('a failed delivery does not lock the customer out: the next request delivers a new code', async () => {
      rig.origination.overrides.push({ match: /\/otp$/, times: 1, respond: reply(503, {}) });
      await ask(DEMO_1.registerNo, DEMO_1.phone).expect(200);
      await rig.t.settle();
      await ask(DEMO_1.registerNo, DEMO_1.phone).expect(200); // TEST_ENV: resend cooldown 0
      await rig.t.settle();
      const sent = rig.origination.received.filter((r) => r.path.endsWith('/otp'));
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toMatchObject({ ttlSec: 300 });
    });
  });

  describe('every adapter route reaches origination with the exact contract', () => {
    it('GET /me and GET /loans/:id use the documented internal paths and trusted headers', async () => {
      await http().get('/api/portal/me').set(auth(c1.accessToken)).expect(200);
      await http().get(`/api/portal/loans/${L1}`).set(auth(c1.accessToken)).expect(200);
      const me = rig.origination.received.find((r) => r.path === '/api/internal/portal/customers/me');
      expect(me?.headers).toMatchObject({ 'x-customer-id': DEMO_1.customerId, 'x-actor-type': 'CUSTOMER' });
      expect(rig.origination.received.some((r) => r.path === `/api/internal/portal/loans/${L1}`)).toBe(true);
    });

    it('payment history forwards limit and cursor and pages through every payment exactly once', async () => {
      const created: string[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await http().post(`/api/portal/loans/${L1}/payments`).set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'CUSTOM', method: 'QPAY', amount: 1000 + i }).expect(201);
        created.push(p.body.paymentId);
      }
      rig.origination.received.length = 0;
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res: { body: { items: Array<{ paymentId: string }>; nextCursor: string | null } } = await http()
          .get(`/api/portal/loans/${L1}/payments`)
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .set(auth(c1.accessToken))
          .expect(200);
        seen.push(...res.body.items.map((i) => i.paymentId));
        cursor = res.body.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length); // давхардалгүй
      for (const id of created) expect(seen).toContain(id);
      const lists = rig.origination.received.filter((r) => r.method === 'GET' && r.path.includes(`/loans/${L1}/payments?`));
      expect(lists[0].path).toContain('limit=2');
      expect(lists.slice(1).every((r) => /cursor=[A-Za-z0-9_.=-]+/.test(r.path))).toBe(true);
      expect(lists.length).toBeGreaterThan(1);
    });

    it('a cursor origination does not know is a 400 to the client (never an endless first page)', async () => {
      const res = await http().get(`/api/portal/loans/${L1}/payments`).query({ cursor: 'pay_does_not_exist' }).set(auth(c1.accessToken)).expect(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    });

    it('a cursor that origination invents but the client could not send back is rejected as a downstream contract violation', async () => {
      rig.origination.overrides.push({ match: /\/payments$/, times: 1, respond: reply(200, { items: [], nextCursor: 'a/b+c|d' }) });
      const res = await http().get(`/api/portal/loans/${L1}/payments`).set(auth(c1.accessToken)).expect(502);
      expect(res.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });
  });

  describe('object-level authorization is enforced by the BFF itself (PRT-NFR-1, independent of origination)', () => {
    // Origination-ийн X-Customer-Id шүүлтүүр алдагдсан/буруу гэж үзье: BFF ӨӨРИЙН жагсаалтаар хаах ёстой.
    // Бодит хамгаалалт = BFF зээлийн ID-г downstream-д огт дамжуулахгүй байх (received-д харагдахгүй).
    const routes: Array<[string, string, (loan: string) => string]> = [
      ['GET', 'detail', (l) => `/api/portal/loans/${l}`],
      ['GET', 'balance', (l) => `/api/portal/loans/${l}/balance`],
      ['GET', 'schedule', (l) => `/api/portal/loans/${l}/schedule`],
      ['GET', 'contract info', (l) => `/api/portal/loans/${l}/contract`],
      ['GET', 'contract download', (l) => `/api/portal/loans/${l}/contract/download`],
      ['GET', 'payment options', (l) => `/api/portal/loans/${l}/payment-options`],
      ['GET', 'payment history', (l) => `/api/portal/loans/${l}/payments`],
    ];

    it.each(routes)('%s %s of another customer\'s loan → 404 and origination is never asked about it', async (_m, _name, path) => {
      const res = await http().get(path(L3)).set(auth(c1.accessToken)).expect(404);
      expect(res.body.error.code).toBe('LOAN_NOT_FOUND');
      expect(rig.origination.received.filter((r) => r.path.includes(L3))).toEqual([]);
    });

    it('POST payments on another customer\'s loan → 404, nothing is created downstream', async () => {
      const res = await http().post(`/api/portal/loans/${L3}/payments`).set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'PAYOFF', method: 'QPAY' }).expect(404);
      expect(res.body.error.code).toBe('LOAN_NOT_FOUND');
      expect(rig.origination.received.filter((r) => r.path.includes(L3) || r.method === 'POST')).toEqual([]);
    });

    it('a payment of another customer is 404 PAYMENT_NOT_FOUND even if origination hands it over', async () => {
      const foreign = ledger().createPayment(DEMO_2.customerId, { loanId: L3, method: 'QPAY', amountType: 'CUSTOM', amount: 1000, currency: 'MNT' }, idem());
      rig.origination.overrides.push({ match: /\/payments\/.+$/, times: 1, respond: reply(200, foreign) });
      const res = await http().get(`/api/portal/payments/${foreign.paymentId}`).set(auth(c1.accessToken)).expect(404);
      expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  describe('a downstream answer about a different loan is never shown (ensureSameLoan on every route)', () => {
    const otherLoan = () => ({
      detail: ledger().getLoan(DEMO_1.customerId, L2),
      balance: ledger().getBalance(DEMO_1.customerId, L2),
      schedule: ledger().getSchedule(DEMO_1.customerId, L2),
      contract: ledger().contractInfo(DEMO_1.customerId, L2),
    });
    const bad = (match: RegExp, body: unknown) => rig.origination.overrides.push({ match, times: 1, respond: reply(200, body) });

    it.each([
      ['detail', new RegExp(`/loans/${L1}$`), '', (o: ReturnType<typeof otherLoan>) => o.detail],
      ['balance', new RegExp(`/loans/${L1}/balance$`), '/balance', (o: ReturnType<typeof otherLoan>) => o.balance],
      ['schedule', new RegExp(`/loans/${L1}/schedule$`), '/schedule', (o: ReturnType<typeof otherLoan>) => o.schedule],
      ['contract info', new RegExp(`/loans/${L1}/contract$`), '/contract', (o: ReturnType<typeof otherLoan>) => o.contract],
      ['contract download (info)', new RegExp(`/loans/${L1}/contract$`), '/contract/download', (o: ReturnType<typeof otherLoan>) => o.contract],
      ['payment options (balance)', new RegExp(`/loans/${L1}/balance$`), '/payment-options', (o: ReturnType<typeof otherLoan>) => o.balance],
    ])('%s', async (_name, match, suffix, body) => {
      bad(match, body(otherLoan()));
      const res = await http().get(`/api/portal/loans/${L1}${suffix}`).set(auth(c1.accessToken)).expect(502);
      expect(res.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });

    it('payment creation never charges on the strength of another loan\'s balance', async () => {
      bad(new RegExp(`/loans/${L1}/balance$`), otherLoan().balance);
      await http().post(`/api/portal/loans/${L1}/payments`).set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'PAYOFF', method: 'QPAY' }).expect(502);
      expect(rig.origination.received.filter((r) => r.method === 'POST')).toEqual([]); // төлбөр үүсгэх дуудлага огт явсангүй
    });

    it('an INVALID_REQUEST from origination on a normal call is contract drift: a 502, not a 400 blamed on the customer', async () => {
      rig.origination.overrides.push({ match: new RegExp(`/loans/${L1}/payments$`), times: 1, respond: reply(400, { error: { code: 'INVALID_REQUEST' } }) });
      const res = await http().post(`/api/portal/loans/${L1}/payments`).set(auth(c1.accessToken)).set('Idempotency-Key', idem()).send({ amountType: 'CUSTOM', method: 'QPAY', amount: 1500 }).expect(502);
      expect(res.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });

    it('payment history and payment creation', async () => {
      const pay = ledger().createPayment(DEMO_1.customerId, { loanId: L1, method: 'QPAY', amountType: 'CUSTOM', amount: 1500, currency: 'MNT' }, idem());
      const wrongLoan = { ...pay, loanId: L2 };
      bad(new RegExp(`/loans/${L1}/payments$`), { items: [wrongLoan], nextCursor: null });
      await http().get(`/api/portal/loans/${L1}/payments`).set(auth(c1.accessToken)).expect(502);

      rig.origination.overrides.push({ match: new RegExp(`/loans/${L1}/payments$`), times: 1, respond: reply(201, wrongLoan) });
      const key = idem();
      await http().post(`/api/portal/loans/${L1}/payments`).set(auth(c1.accessToken)).set('Idempotency-Key', key).send({ amountType: 'CUSTOM', method: 'QPAY', amount: 1500 }).expect(502);
    });
  });

  describe('contract PDF integrity', () => {
    let small: Awaited<ReturnType<typeof createRealModeApp>>;
    let token: string;
    let baseUrl: string;
    const pdf = () => small.origination.ledger.contractPdf(DEMO_1.customerId, L1);

    beforeAll(async () => {
      small = await createRealModeApp({ PORTAL_MAX_CONTRACT_BYTES: '2048', PORTAL_INTERNAL_TIMEOUT_MS: '500' });
      token = (await small.t.login(DEMO_1.registerNo, DEMO_1.phone, '10.22.0.1')).accessToken;
      await small.t.app.listen(0, '127.0.0.1');
      baseUrl = await small.t.app.getUrl();
    });
    afterAll(async () => {
      await small.close();
    });
    beforeEach(() => {
      small.origination.overrides.length = 0;
      small.origination.received.length = 0;
    });

    const download = async () => {
      const res = await fetch(`${baseUrl}/api/portal/loans/${L1}/contract/download`, { headers: auth(token) });
      try {
        return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()), aborted: false };
      } catch {
        return { status: res.status, headers: res.headers, body: Buffer.alloc(0), aborted: true };
      }
    };
    const content = (respond: (res: ServerResponse) => void) => small.origination.overrides.push({ match: /\/contract\/content$/, times: 1, respond });
    const pdfHeaders = { 'Content-Type': 'application/pdf' };

    it('a valid PDF is delivered whole, with its length declared to the client', async () => {
      expect(pdf().length).toBeLessThan(2048);
      const r = await download();
      expect(r.status).toBe(200);
      expect(r.aborted).toBe(false);
      expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(r.body.equals(pdf())).toBe(true);
      expect(Number(r.headers.get('content-length'))).toBe(pdf().length);
      expect(small.t.audit.actions()).toContain('CONTRACT_DOWNLOADED');
    });

    it('a size declared above the cap is a clean JSON 502 (docs: PORTAL_MAX_CONTRACT_BYTES)', async () => {
      content((res) => {
        res.writeHead(200, { ...pdfHeaders, 'Content-Length': 5000 });
        res.end(Buffer.alloc(5000, 1));
      });
      const r = await download();
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body.toString()).error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });

    it('an undeclared size that overruns in the FIRST chunk is a clean JSON 502, not a text 400 labelled PDF', async () => {
      content((res) => {
        res.writeHead(200, pdfHeaders); // chunked, Content-Length-гүй
        res.write(Buffer.alloc(3000, 1));
        setTimeout(() => res.end(), 30);
      });
      const downloaded = () => small.t.audit.actions().filter((x) => x === 'CONTRACT_DOWNLOADED').length;
      const before = downloaded();
      const r = await download();
      expect(r.status).toBe(502);
      expect(r.headers.get('content-type')).toContain('application/json');
      expect(JSON.parse(r.body.toString()).error).toMatchObject({ code: 'DOWNSTREAM_INVALID_RESPONSE' });
      expect(downloaded()).toBe(before); // амжилттай татсан гэж аудитад бичигдээгүй
    });

    it('an overrun in the middle of the stream aborts the transfer instead of ending it cleanly', async () => {
      content((res) => {
        res.writeHead(200, pdfHeaders);
        res.write(Buffer.alloc(1000, 1));
        setTimeout(() => {
          res.write(Buffer.alloc(3000, 1));
          setTimeout(() => res.end(), 30);
        }, 80);
      });
      const r = await download();
      expect(r.aborted).toBe(true); // харилцагчид «200 + дутуу файл» бус, дамжуулалтын алдаа харагдана
      expect(await until(() => small.t.audit.actions().includes('CONTRACT_DOWNLOAD_ABORTED'))).toBe(true);
    });

    it('an upstream that dies after declaring a length aborts the transfer (truncated PDF is never a success)', async () => {
      content((res) => {
        res.writeHead(200, { ...pdfHeaders, 'Content-Length': 2000 });
        res.write(Buffer.alloc(500, 1));
        setTimeout(() => res.socket?.destroy(), 50);
      });
      const r = await download();
      expect(r.aborted).toBe(true);
    });

    it('a client that gives up while origination is still preparing the file is recorded as aborted, not as a successful download', async () => {
      const cid = 'corr-abort-window-01';
      const mine = (action: string) => small.t.audit.records.filter((r) => r.action === action && r.correlationId === cid);
      content((res) => {
        setTimeout(() => {
          res.writeHead(200, { ...pdfHeaders, 'Content-Length': pdf().length });
          res.end(pdf());
        }, 400);
      });
      const ac = new AbortController();
      const pending = fetch(`${baseUrl}/api/portal/loans/${L1}/contract/download`, { headers: { ...auth(token), 'X-Correlation-Id': cid }, signal: ac.signal }).catch(() => null);
      setTimeout(() => ac.abort(), 150);
      await pending;
      expect(await until(() => mine('CONTRACT_DOWNLOAD_ABORTED').length === 1, 3000)).toBe(true); // дамжуулалт дуусаагүй гэж тэмдэглэгдсэн
    });

    it('a Content-Encoding upstream is not framed with the encoded length', async () => {
      const gz = gzipSync(pdf());
      content((res) => {
        res.writeHead(200, { ...pdfHeaders, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
        res.end(gz);
      });
      const r = await download();
      expect(r.aborted).toBe(false);
      expect(r.status).toBe(200);
      expect(r.body.equals(pdf())).toBe(true);
    });

    it('an empty body is a clean JSON 502', async () => {
      content((res) => {
        res.writeHead(200, { ...pdfHeaders, 'Content-Length': 0 });
        res.end();
      });
      const r = await download();
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body.toString()).error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });

    it('an upstream that sends headers and then stalls is cut off by the timeout (503) rather than holding the request', async () => {
      content((res) => {
        res.writeHead(200, pdfHeaders);
        res.flushHeaders(); // толгой явуулаад бие нь ирэхгүй
      });
      const started = Date.now();
      const r = await download();
      expect(r.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });
});
