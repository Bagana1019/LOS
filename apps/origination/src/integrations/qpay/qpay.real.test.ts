import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ProviderRejectedError, ProviderUnavailableError } from '../payment-provider/provider-errors';
import { QPAY_DEFAULT_BASE_URL, RealQPayClient } from './qpay.real';

// QPay merchant API v2 (нийтийн баримт) — fetch stub-тай тест. Sandbox-д жинхэнэ дуудлага хийгээгүй.
const ENV = { QPAY_USERNAME: 'merchant', QPAY_PASSWORD: 'p@ss:word', QPAY_INVOICE_CODE: 'LOS_INVOICE', QPAY_CALLBACK_BASE_URL: 'https://los.example.mn/api/' };
const req = { senderInvoiceNo: 'LOS-APP-00001-1', amount: 120_000, currency: 'MNT', description: 'Эргэн төлөлт APP-00001', receiverCode: 'APP-00001', expiresAt: new Date('2026-10-28T03:00:00Z') };
const ref = { providerInvoiceId: 'INV-123', senderInvoiceNo: req.senderInvoiceNo };

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
type Handler = (call: Call, n: number) => Response | Promise<Response> | Error;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const token = (expires_in: number | string = 3600, access = 'TOKEN-1') => json(200, { token_type: 'bearer', access_token: access, expires_in, refresh_token: 'REFRESH-SECRET', refresh_expires_in: 7200 });

function harness(handlers: Record<string, Handler | Handler[]>, opts: { now?: () => Date; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxRetries?: number } = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const path = new URL(call.url).pathname.replace(/^\/v2/, '');
    const key = `${call.method} ${path.startsWith('/invoice/') ? '/invoice/:id' : path}`;
    const h = handlers[key];
    if (!h) return json(404, { error: 'NOT_FOUND_IN_STUB', key });
    const n = counts.get(key) ?? 0; counts.set(key, n + 1);
    const handler = Array.isArray(h) ? h[Math.min(n, h.length - 1)] : h;
    const r = await handler(call, n);
    if (r instanceof Error) throw r;
    if (init?.signal) { /* stub: signal-ийг handler өөрөө ашиглахгүй */ }
    return r;
  }) as typeof fetch;
  const client = new RealQPayClient({ env: opts.env ?? ENV, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: opts.now, timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries });
  return { client, calls, sleeps, count: (k: string) => counts.get(k) ?? 0 };
}

const okInvoice = () => json(200, {
  invoice_id: 'INV-123', qr_text: '0002010102...', qr_image: 'iVBORw0KGgo=', qPay_shortUrl: 'https://s.qpay.mn/abc',
  urls: [{ name: 'Khan bank', description: 'Хаан банк', logo: 'https://qpay.mn/q/logo/khanbank.png', link: 'khanbank://q?qPay_QRcode=0002' }, { name: 'Most', link: 'most://x' }],
});

describe('RealQPayClient — тохиргоо', () => {
  it('env дутуу: available биш, NOT_CONFIGURED, дуудлага IntegrationNotConfiguredError (HTTP хийхгүй)', async () => {
    const h = harness({}, { env: { QPAY_USERNAME: 'x' } });
    expect(h.client.isAvailable()).toBe(false);
    expect(h.client.unavailableReason()).toBe('NOT_CONFIGURED');
    await expect(h.client.createInvoice(req)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    await expect(h.client.checkInvoice(ref)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(h.calls).toHaveLength(0);
  });

  it('env бүрэн: available; анхдагч base URL нь sandbox', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': okInvoice });
    expect(h.client.isAvailable()).toBe(true);
    expect(h.client.mode).toBe('real');
    await h.client.createInvoice(req);
    expect(h.calls[0].url).toBe(`${QPAY_DEFAULT_BASE_URL}/auth/token`);
  });

  it('QPAY_BASE_URL-ийг хүндэтгэнэ (төгсгөлийн / хасна)', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': okInvoice }, { env: { ...ENV, QPAY_BASE_URL: 'https://merchant.qpay.mn/v2/' } });
    await h.client.createInvoice(req);
    expect(h.calls.map((c) => c.url)).toEqual(['https://merchant.qpay.mn/v2/auth/token', 'https://merchant.qpay.mn/v2/invoice']);
  });
});

describe('RealQPayClient — createInvoice', () => {
  it('Basic нэвтрэлт, Bearer токен, зөв body, callback_url, хариуны mapping', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': okInvoice });
    const inv = await h.client.createInvoice(req);

    const [auth, create] = h.calls;
    expect(auth.method).toBe('POST');
    expect(auth.headers.Authorization).toBe(`Basic ${Buffer.from('merchant:p@ss:word').toString('base64')}`);
    expect(create.headers.Authorization).toBe('Bearer TOKEN-1');
    expect(create.headers['Content-Type']).toBe('application/json');
    expect(create.body).toEqual({
      invoice_code: 'LOS_INVOICE', sender_invoice_no: 'LOS-APP-00001-1', invoice_receiver_code: 'APP-00001', invoice_description: 'Эргэн төлөлт APP-00001',
      amount: 120_000, callback_url: 'https://los.example.mn/api/payments/callbacks/qpay?invoice=LOS-APP-00001-1',
    });
    expect(inv).toMatchObject({ providerInvoiceId: 'INV-123', qrText: '0002010102...', qrImage: 'iVBORw0KGgo=' });
    expect(inv.deeplinks).toEqual([
      { name: 'Khan bank', description: 'Хаан банк', logo: 'https://qpay.mn/q/logo/khanbank.png', link: 'khanbank://q?qPay_QRcode=0002' },
      { name: 'Most', description: null, logo: null, link: 'most://x' },
    ]);
    expect(inv.raw).toEqual({ invoice_id: 'INV-123', qPay_shortUrl: 'https://s.qpay.mn/abc' });
  });

  it('тайлбарыг 200 тэмдэгтэд тайрна; MNT биш / эерэг биш дүнг HTTP-гүйгээр татгалзана', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': okInvoice });
    await h.client.createInvoice({ ...req, description: 'а'.repeat(500) });
    expect((h.calls[1].body as { invoice_description: string }).invoice_description).toHaveLength(200);
    const before = h.calls.length;
    await expect(h.client.createInvoice({ ...req, currency: 'USD' })).rejects.toMatchObject({ providerCode: 'CURRENCY_UNSUPPORTED' });
    await expect(h.client.createInvoice({ ...req, amount: 0 })).rejects.toMatchObject({ providerCode: 'INVALID_AMOUNT' });
    expect(h.calls).toHaveLength(before);
  });

  it('хариуны хэлбэр буруу (invoice_id үгүй) → ProviderUnavailableError', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': () => json(200, { foo: 1 }) });
    await expect(h.client.createInvoice(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('4xx → ProviderRejectedError (дахин оролдохгүй), код нь хариунаас', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': () => json(400, { error: 'INVOICE_CODE_INVALID', message: 'secret details' }) });
    const err = await h.client.createInvoice(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect(err.providerCode).toBe('INVOICE_CODE_INVALID');
    expect(err.message).not.toContain('secret details');
    expect(h.count('POST /invoice')).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});

describe('RealQPayClient — токен', () => {
  it('токеныг cache хийнэ: дараалсан дуудлагад нэг л нэвтрэлт', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': okInvoice, 'POST /payment/check': () => json(200, { count: 0, rows: [] }) });
    await h.client.createInvoice(req);
    await h.client.checkInvoice(ref);
    await h.client.createInvoice({ ...req, senderInvoiceNo: 'LOS-APP-00001-2' });
    expect(h.count('POST /auth/token')).toBe(1);
  });

  it('зэрэг дуудлага нэг нэвтрэлтийг хуваалцана (single-flight)', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': () => json(200, { rows: [] }) });
    await Promise.all([h.client.checkInvoice(ref), h.client.checkInvoice(ref), h.client.checkInvoice(ref)]);
    expect(h.count('POST /auth/token')).toBe(1);
  });

  it('хугацаа дуусвал дахин нэвтэрнэ (expires_in = үлдсэн секунд)', async () => {
    let nowMs = Date.parse('2026-10-28T02:00:00Z');
    const h = harness({ 'POST /auth/token': [() => token(300, 'T1'), () => token(300, 'T2')], 'POST /payment/check': () => json(200, { rows: [] }) }, { now: () => new Date(nowMs) });
    await h.client.checkInvoice(ref);
    nowMs += 200_000; // 30с тэвчих зайгаар дөнгөж хүчинтэй
    await h.client.checkInvoice(ref);
    expect(h.count('POST /auth/token')).toBe(1);
    nowMs += 100_000; // хугацаа дууссан
    await h.client.checkInvoice(ref);
    expect(h.count('POST /auth/token')).toBe(2);
    expect(h.calls.filter((c) => c.url.endsWith('/payment/check')).map((c) => c.headers.Authorization)).toEqual(['Bearer T1', 'Bearer T1', 'Bearer T2']);
  });

  it('expires_in нь epoch секунд (> 1e9) байж болно', async () => {
    const nowMs = Date.parse('2026-10-28T02:00:00Z');
    const epoch = Math.floor(nowMs / 1000) + 3600;
    let t = nowMs;
    const h = harness({ 'POST /auth/token': [() => token(epoch, 'T1'), () => token(epoch + 7200, 'T2')], 'POST /payment/check': () => json(200, { rows: [] }) }, { now: () => new Date(t) });
    await h.client.checkInvoice(ref);
    t += 3_000_000; // 50 минут — хүчинтэй
    await h.client.checkInvoice(ref);
    expect(h.count('POST /auth/token')).toBe(1);
    t += 600_000; // 60 минут давсан
    await h.client.checkInvoice(ref);
    expect(h.count('POST /auth/token')).toBe(2);
  });

  it('401 → токеныг хаяж НЭГ удаа дахин нэвтэрч дахин илгээнэ', async () => {
    const h = harness({
      'POST /auth/token': [() => token(3600, 'OLD'), () => token(3600, 'NEW')],
      'POST /invoice': [(c) => (c.headers.Authorization === 'Bearer OLD' ? json(401, { error: 'AUTHENTICATION_FAILED' }) : okInvoice())],
    });
    const inv = await h.client.createInvoice(req);
    expect(inv.providerInvoiceId).toBe('INV-123');
    expect(h.count('POST /auth/token')).toBe(2);
    expect(h.calls.filter((c) => c.url.endsWith('/invoice')).map((c) => c.headers.Authorization)).toEqual(['Bearer OLD', 'Bearer NEW']);
  });

  it('дахин нэвтэрсний дараа ч 401 бол ProviderRejectedError (3 дахь оролдлого хийхгүй)', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': () => json(401, { error: 'AUTHENTICATION_FAILED' }) });
    await expect(h.client.createInvoice(req)).rejects.toBeInstanceOf(ProviderRejectedError);
    expect(h.count('POST /invoice')).toBe(2);
    expect(h.count('POST /auth/token')).toBe(2);
  });

  it('буруу credential (token endpoint 401) → ProviderRejectedError, монгол мессеж', async () => {
    const h = harness({ 'POST /auth/token': () => json(401, { error: 'AUTHENTICATION_FAILED' }) });
    const err = await h.client.createInvoice(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRejectedError);
    expect(err.message).toContain('нэвтрэлт амжилтгүй');
    expect(h.count('POST /auth/token')).toBe(1);
  });
});

describe('RealQPayClient — дахин оролдлого ба timeout', () => {
  it('5xx-д exponential backoff-оор 2 удаа дахин оролдоно (нийт 3 дуудлага), дараа нь амжилттай', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': [() => json(503, {}), () => json(500, {}), okInvoice] });
    const inv = await h.client.createInvoice(req);
    expect(inv.providerInvoiceId).toBe('INV-123');
    expect(h.count('POST /invoice')).toBe(3);
    expect(h.sleeps).toEqual([300, 600]);
  });

  it('3 дахь оролдлого ч 5xx бол ProviderUnavailableError', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': () => json(502, {}) });
    await expect(h.client.createInvoice(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(h.count('POST /invoice')).toBe(3);
    expect(h.sleeps).toEqual([300, 600]);
  });

  it('сүлжээний алдаа (fetch throw) дахин оролдогдоно', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': [() => new TypeError('fetch failed'), () => json(200, { rows: [] })] });
    expect(await h.client.checkInvoice(ref)).toEqual({ paid: false, payments: [] });
    expect(h.count('POST /payment/check')).toBe(2);
  });

  it('нэвтрэлтийн endpoint 5xx бол мөн дахин оролдоно', async () => {
    const h = harness({ 'POST /auth/token': [() => json(500, {}), () => token()], 'POST /payment/check': () => json(200, { rows: [] }) });
    await h.client.checkInvoice(ref);
    expect(h.count('POST /auth/token')).toBe(2);
  });

  it('timeout: хариу ирэхгүй бол AbortController-оор таслаад ProviderUnavailableError', async () => {
    let aborted = 0;
    const calls: string[] = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/auth/token')) return Promise.resolve(token());
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }));
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const client = new RealQPayClient({ env: ENV, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, timeoutMs: 20 });
    const err = await client.checkInvoice(ref).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.message).toContain('timeout');
    expect(aborted).toBe(3); // 1 + 2 дахин оролдлого
    expect(sleeps).toEqual([300, 600]);
  });

  it('maxRetries=0 бол дахин оролдохгүй', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': () => json(500, {}) }, { maxRetries: 0 });
    await expect(h.client.createInvoice(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(h.count('POST /invoice')).toBe(1);
  });

  it('2xx боловч JSON биш хариу → ProviderUnavailableError', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /invoice': () => new Response('<html>', { status: 200 }) }, { maxRetries: 0 });
    await expect(h.client.createInvoice(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('RealQPayClient — checkInvoice', () => {
  it('зөв хүсэлт: object_type=INVOICE, object_id, offset', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': () => json(200, { count: 0, rows: [] }) });
    await h.client.checkInvoice(ref);
    expect(h.calls[1].body).toEqual({ object_type: 'INVOICE', object_id: 'INV-123', offset: { page_number: 1, page_limit: 100 } });
  });

  it('PAID мөрүүдийг ProviderPayment болгоно; NEW/FAILED-ийг алгасна; raw нь нууц/PII-гүй', async () => {
    const h = harness({
      'POST /auth/token': () => token(),
      'POST /payment/check': () => json(200, {
        count: 3, paid_amount: 120000,
        rows: [
          { payment_id: 987654321, payment_status: 'PAID', payment_date: '2026-10-28T03:15:00.000Z', payment_amount: '120000.00', payment_currency: 'MNT', payment_wallet: 'Khan bank', paid_by: '5012345678', access_token: 'LEAK' },
          { payment_id: '111', payment_status: 'NEW', payment_amount: 5 },
          { payment_id: '222', payment_status: 'FAILED', payment_amount: 6 },
        ],
      }),
    });
    const res = await h.client.checkInvoice(ref);
    expect(res.paid).toBe(true);
    expect(res.payments).toHaveLength(1);
    expect(res.payments[0]).toMatchObject({ providerPaymentId: '987654321', amount: 120000, currency: 'MNT', paidAt: new Date('2026-10-28T03:15:00.000Z'), payerName: null, payerAccount: null });
    const raw = JSON.stringify(res.payments[0].raw);
    expect(raw).not.toContain('LEAK');
    expect(raw).not.toContain('5012345678');
  });

  it('цагийн бүсгүй payment_date-г Asia/Ulaanbaatar (+08:00) гэж үзнэ', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': () => json(200, { rows: [{ payment_id: 1, payment_status: 'PAID', payment_date: '2026-10-28 11:15:00', payment_amount: 10 }] }) });
    const res = await h.client.checkInvoice(ref);
    expect(res.payments[0].paidAt.toISOString()).toBe('2026-10-28T03:15:00.000Z');
  });

  it('төлөгдөөгүй: paid=false, payments хоосон; rows байхгүй ч алдаагүй', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': () => json(200, { count: 0 }) });
    expect(await h.client.checkInvoice(ref)).toEqual({ paid: false, payments: [] });
  });

  it('дүнгүй/буруу дүнтэй PAID мөрийг таамаглаж бүртгэхгүй — түр алдаа', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': () => json(200, { rows: [{ payment_id: 1, payment_status: 'PAID' }] }) }, { maxRetries: 0 });
    await expect(h.client.checkInvoice(ref)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('PAID бүртгэлийн payment_date байхгүй бол now()', async () => {
    const t = new Date('2026-10-28T05:00:00Z');
    const h = harness({ 'POST /auth/token': () => token(), 'POST /payment/check': () => json(200, { rows: [{ payment_id: 1, payment_status: 'PAID', payment_amount: 10 }] }) }, { now: () => t });
    expect((await h.client.checkInvoice(ref)).payments[0].paidAt).toEqual(t);
  });
});

describe('RealQPayClient — cancelInvoice', () => {
  it('DELETE /invoice/{id}', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'DELETE /invoice/:id': () => json(200, {}) });
    await h.client.cancelInvoice({ providerInvoiceId: 'A/B 1', senderInvoiceNo: 'x' });
    expect(h.calls[1]).toMatchObject({ method: 'DELETE' });
    expect(h.calls[1].url).toBe(`${QPAY_DEFAULT_BASE_URL}/invoice/A%2FB%201`);
    expect(h.calls[1].body).toBeUndefined();
  });

  it('404 = аль хэдийн байхгүй → алдаагүй', async () => {
    const h = harness({ 'POST /auth/token': () => token(), 'DELETE /invoice/:id': () => json(404, { error: 'INVOICE_NOTFOUND' }) });
    await expect(h.client.cancelInvoice(ref)).resolves.toBeUndefined();
  });

  it('төлөгдсөн invoice-ийн цуцлалт (4xx) → ProviderRejectedError, 5xx → дахин оролдоно', async () => {
    const rejected = harness({ 'POST /auth/token': () => token(), 'DELETE /invoice/:id': () => json(400, { error: 'INVOICE_PAID' }) });
    await expect(rejected.client.cancelInvoice(ref)).rejects.toMatchObject({ providerCode: 'INVOICE_PAID' });
    const flaky = harness({ 'POST /auth/token': () => token(), 'DELETE /invoice/:id': [() => json(500, {}), () => json(200, {})] });
    await expect(flaky.client.cancelInvoice(ref)).resolves.toBeUndefined();
    expect(flaky.count('DELETE /invoice/:id')).toBe(2);
  });
});
