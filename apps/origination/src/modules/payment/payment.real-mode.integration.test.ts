import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentInvoiceView, PaymentProviderInfo } from '@los/contracts';
import { RealBankGateway } from '../../integrations/bank-transfer/bank-transfer.real';
import { BANK_GATEWAY } from '../../integrations/bank-transfer/bank-transfer.provider';
import { QPAY_CLIENT } from '../../integrations/qpay/qpay.provider';
import { RealQPayClient } from '../../integrations/qpay/qpay.real';
import { RealSocialPayClient } from '../../integrations/socialpay/socialpay.real';
import { SOCIALPAY_CLIENT } from '../../integrations/socialpay/socialpay.provider';
import { actors, hasTestDb, ORG } from '../../test-utils/factories';
import { bootPayment, PaymentEnv, resetPayment, seedLoan, setSetting } from './payment.test-helpers';

const QPAY_ENV = { QPAY_USERNAME: 'merchant', QPAY_PASSWORD: 'pw', QPAY_INVOICE_CODE: 'LOS_INVOICE', QPAY_CALLBACK_BASE_URL: 'https://los.example.mn/api' };
const SOCIAL_ENV = { SOCIALPAY_BASE_URL: 'https://x', SOCIALPAY_MERCHANT_ID: 'm', SOCIALPAY_SECRET: 's', SOCIALPAY_CALLBACK_BASE_URL: 'https://cb' };
const BANK_ENV = { BANK_GATEWAY_BASE_URL: 'https://bank', BANK_GATEWAY_CLIENT_ID: 'id', BANK_GATEWAY_SECRET: 's' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Хуурамч QPay merchant сервер (fetch stub). Төлөв хадгална. */
function fakeQPayServer() {
  const invoices = new Map<string, { sender: string; amount: number; paid: boolean; cancelled: boolean }>();
  const log: string[] = [];
  const failures = { invoice: 0 };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/v2', '');
    const method = init?.method ?? 'GET';
    log.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === '/auth/token') return json(200, { access_token: 'TKN', expires_in: 3600 });
    if (method === 'POST' && path === '/invoice') {
      if (failures.invoice > 0) { failures.invoice--; return json(503, {}); }
      const id = `Q-${invoices.size + 1}`;
      invoices.set(id, { sender: body.sender_invoice_no, amount: body.amount, paid: false, cancelled: false });
      return json(200, { invoice_id: id, qr_text: `qr:${id}`, qr_image: 'iVBORw0KGgo=', urls: [{ name: 'Khan bank', description: 'Хаан', logo: 'l', link: `khan://${id}` }] });
    }
    if (method === 'POST' && path === '/payment/check') {
      const inv = invoices.get(body.object_id);
      if (!inv) return json(404, { error: 'INVOICE_NOTFOUND' });
      return json(200, { count: inv.paid ? 1 : 0, rows: inv.paid ? [{ payment_id: `PAY-${body.object_id}`, payment_status: 'PAID', payment_date: '2026-10-28T02:05:00.000Z', payment_amount: inv.amount, payment_currency: 'MNT', paid_by: '5012345678' }] : [] });
    }
    if (method === 'DELETE' && path.startsWith('/invoice/')) {
      const inv = invoices.get(decodeURIComponent(path.slice('/invoice/'.length)));
      if (!inv) return json(404, { error: 'INVOICE_NOTFOUND' });
      if (inv.paid) return json(400, { error: 'INVOICE_PAID' });
      inv.cancelled = true;
      return json(200, {});
    }
    return json(404, {});
  }) as typeof fetch;
  return { invoices, log, failures, fetchImpl, pay: (id: string) => { invoices.get(id)!.paid = true; } };
}

describe.skipIf(!hasTestDb)('payment: Real QPay (fetch stub) — бүтэн урсгал', () => {
  const server = fakeQPayServer();
  let env: PaymentEnv;
  beforeAll(async () => {
    env = await bootPayment((b) => b.overrideProvider(QPAY_CLIENT).useValue(new RealQPayClient({ env: QPAY_ENV, fetchImpl: server.fetchImpl, sleep: async () => undefined })));
  });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); server.invoices.clear(); server.log.length = 0; server.failures.invoice = 0; });

  const create = (body: object) => env.http().post('/api/payments/invoices').set(actors.officer()).send(body);

  it('GET providers: QPAY real+идэвхтэй', async () => {
    const res = await env.http().get('/api/payments/providers').set(actors.officer());
    const q = (res.body as unknown[]).map((i) => PaymentProviderInfo.parse(i)).find((i) => i.provider === 'QPAY');
    expect(q).toEqual({ provider: 'QPAY', enabled: true, mode: 'real', reason: null });
  });

  it('invoice үүсгэнэ → callback → checkInvoice баталгаажуулж бүртгэнэ → PAID', async () => {
    const { app } = await seedLoan(env);
    const res = await create({ applicationId: app.id, provider: 'QPAY', amount: 30_000 });
    expect(res.status).toBe(201);
    const view = PaymentInvoiceView.parse(res.body);
    expect(view.qrText).toBe('qr:Q-1');
    expect(view.deeplinks[0].link).toBe('khan://Q-1');
    expect(server.invoices.get('Q-1')).toMatchObject({ sender: view.senderInvoiceNo, amount: 30_000 });

    // төлөгдөөгүй байхад хуурамч callback → нөлөөгүй
    await env.http().get(`/api/payments/callbacks/qpay?invoice=${view.senderInvoiceNo}&qpay_payment_id=fake`);
    expect(await env.t.prisma.payment.count()).toBe(0);

    server.pay('Q-1');
    const cb = await env.http().get(`/api/payments/callbacks/qpay?invoice=${view.senderInvoiceNo}&qpay_payment_id=PAY-Q-1`);
    expect(cb.text).toBe('SUCCESS');
    const [p] = await env.t.prisma.payment.findMany();
    expect(p).toMatchObject({ provider: 'QPAY', providerPaymentId: 'PAY-Q-1', payerAccountMasked: null });
    expect(Number(p.amount)).toBe(30_000);
    expect(p.paidAt.toISOString()).toBe('2026-10-28T02:05:00.000Z');
    expect(JSON.stringify(p.rawJson)).not.toContain('5012345678');
    expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PAID');
  });

  it('5xx-ээр 2 удаа амжилтгүй болоод 3 дахь оролдлогоор invoice үүснэ (нэг л мөр)', async () => {
    const { app } = await seedLoan(env);
    server.failures.invoice = 2;
    const res = await create({ applicationId: app.id, provider: 'QPAY', amount: 30_000 });
    expect(res.status).toBe(201);
    expect(server.log.filter((l) => l === 'POST /invoice')).toHaveLength(3);
    expect(await env.t.prisma.paymentInvoice.count()).toBe(1);
  });

  it('провайдер үргэлж 5xx → 502 PROVIDER_UNAVAILABLE, DB-д хагас invoice үлдэхгүй', async () => {
    const { app } = await seedLoan(env);
    server.failures.invoice = 99;
    const res = await create({ applicationId: app.id, provider: 'QPAY', amount: 30_000 });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await env.t.prisma.paymentInvoice.count()).toBe(0);
  });

  it('цуцлах: DELETE /invoice/{id} дуудагдаж CANCELLED болно', async () => {
    const { app } = await seedLoan(env);
    const view = (await create({ applicationId: app.id, provider: 'QPAY', amount: 30_000 })).body;
    const res = await env.http().post(`/api/payments/invoices/${view.id}/cancel`).set(actors.officer());
    expect(res.body.status).toBe('CANCELLED');
    expect(server.log).toContain('DELETE /invoice/Q-1');
    expect(server.invoices.get('Q-1')?.cancelled).toBe(true);
  });

  it('GET poll: callback ирээгүй ч төлөгдсөн бол бүртгэнэ', async () => {
    const { app } = await seedLoan(env);
    const view = (await create({ applicationId: app.id, provider: 'QPAY', amount: 30_000 })).body;
    server.pay('Q-1');
    const res = await env.http().get(`/api/payments/invoices/${view.id}`).set(actors.officer());
    expect(res.body.status).toBe('PAID');
  });

  it('dev/simulate: real горимд 404', async () => {
    const { app } = await seedLoan(env);
    const view = (await create({ applicationId: app.id, provider: 'QPAY', amount: 30_000 })).body;
    expect((await env.http().post('/api/payments/dev/simulate').set(actors.admin()).send({ invoiceId: view.id })).status).toBe(404);
    expect(await env.t.prisma.payment.count()).toBe(0);
  });
});

describe.skipIf(!hasTestDb)('payment: Real горим — тохиргоо дутуу / хэрэгжээгүй skeleton', () => {
  let env: PaymentEnv;
  beforeAll(async () => {
    env = await bootPayment((b) => b
      .overrideProvider(QPAY_CLIENT).useValue(new RealQPayClient({ env: {} }))
      .overrideProvider(SOCIALPAY_CLIENT).useValue(new RealSocialPayClient(SOCIAL_ENV))
      .overrideProvider(BANK_GATEWAY).useValue(new RealBankGateway({})));
  });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const create = (body: object) => env.http().post('/api/payments/invoices').set(actors.officer()).send(body);

  it('GET providers: бүгд идэвхгүй, шалтгаантай', async () => {
    const res = await env.http().get('/api/payments/providers').set(actors.officer());
    const infos = (res.body as unknown[]).map((i) => PaymentProviderInfo.parse(i));
    expect(infos).toEqual([
      { provider: 'QPAY', enabled: false, mode: 'real', reason: 'NOT_CONFIGURED' },
      { provider: 'SOCIALPAY', enabled: false, mode: 'real', reason: 'NOT_IMPLEMENTED' },
      { provider: 'BANK_TRANSFER', enabled: false, mode: 'real', reason: 'NOT_CONFIGURED' },
    ]);
  });

  it('QPay тохиргоо дутуу → 503 PROVIDER_NOT_CONFIGURED, DB цэвэр, мессежэд env нэр гарахгүй', async () => {
    const { app } = await seedLoan(env);
    const res = await create({ applicationId: app.id, provider: 'QPAY' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(JSON.stringify(res.body)).not.toContain('QPAY_');
    expect(await env.t.prisma.paymentInvoice.count()).toBe(0);
  });

  it('SocialPay skeleton → 501 PROVIDER_NOT_IMPLEMENTED', async () => {
    const { app } = await seedLoan(env);
    const res = await create({ applicationId: app.id, provider: 'SOCIALPAY' });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('PROVIDER_NOT_IMPLEMENTED');
    expect(await env.t.prisma.paymentInvoice.count()).toBe(0);
  });

  it('банкны шилжүүлэг: gateway тохиргоо дутуу → 503', async () => {
    const { app } = await seedLoan(env);
    await setSetting(env, 'payment.collection_account', { bankCode: 'KHAN', accountNo: '5000000001', accountName: 'X' });
    const res = await create({ applicationId: app.id, provider: 'BANK_TRANSFER' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('name-check: gateway тохиргоо дутуу → 503', async () => {
    const res = await env.http().post('/api/payments/bank-accounts/name-check').set(actors.officer()).send({ bankCode: 'KHAN', accountNo: '5012345673', holderName: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('reconcile: хүлээн авах данс байхгүй → 503; данс байвал gateway-ийн алдаа 503', async () => {
    const a = await env.http().post('/api/payments/bank-transfers/reconcile').set(actors.admin()).send({});
    expect(a.status).toBe(503);
    await setSetting(env, 'payment.collection_account', { bankCode: 'KHAN', accountNo: '5000000001', accountName: 'X' });
    const b = await env.http().post('/api/payments/bank-transfers/reconcile').set(actors.admin()).send({});
    expect(b.status).toBe(503);
    expect(b.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('банкны gateway тохируулагдсан ч хэрэгжээгүй → name-check 501', async () => {
    const gateway = new RealBankGateway(BANK_ENV);
    expect(gateway.unavailableReason()).toBe('NOT_IMPLEMENTED');
    await expect(gateway.nameCheck({ bankCode: 'KHAN', accountNo: '1234', holderName: 'x' })).rejects.toMatchObject({ name: 'ProviderNotImplementedError' });
  });

  it('боломжгүй провайдерын invoice-д callback ирвэл 200 SUCCESS, бүртгэхгүй', async () => {
    const { app } = await seedLoan(env);
    await env.t.prisma.paymentInvoice.create({ data: { orgId: ORG, applicationId: app.id, provider: 'QPAY', amount: 5000, senderInvoiceNo: 'LOS-X-1', providerInvoiceId: 'Q1', expiresAt: new Date('2026-12-01') } });
    const res = await env.http().get('/api/payments/callbacks/qpay?invoice=LOS-X-1');
    expect(res.status).toBe(200);
    expect(res.text).toBe('SUCCESS');
    expect(await env.t.prisma.payment.count()).toBe(0);
  });

  it('dev/simulate: real горимд 404', async () => {
    const { app } = await seedLoan(env);
    const inv = await env.t.prisma.paymentInvoice.create({ data: { orgId: ORG, applicationId: app.id, provider: 'QPAY', amount: 5000, senderInvoiceNo: 'LOS-X-2', providerInvoiceId: 'Q2', expiresAt: new Date('2026-12-01') } });
    expect((await env.http().post('/api/payments/dev/simulate').set(actors.admin()).send({ invoiceId: inv.id })).status).toBe(404);
  });
});
