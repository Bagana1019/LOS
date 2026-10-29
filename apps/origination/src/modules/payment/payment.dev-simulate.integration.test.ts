import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentInvoiceView } from '@los/contracts';
import { actors, hasTestDb } from '../../test-utils/factories';
import { bootPayment, makeInvoice, PaymentEnv, resetPayment, seedLoan } from './payment.test-helpers';

describe.skipIf(!hasTestDb)('payment: POST payments/dev/simulate (зөвхөн mock ба NODE_ENV≠production)', () => {
  let env: PaymentEnv;
  beforeAll(async () => { env = await bootPayment(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const simulate = (headers: Record<string, string>, body: object) => env.http().post('/api/payments/dev/simulate').set(headers).send(body);

  it('зөвхөн ADMIN: нэвтрээгүй 401, ЗЭЗ 403', async () => {
    expect((await simulate(actors.anonymous(), { invoiceId: 'x' })).status).toBe(401);
    expect((await simulate(actors.officer(), { invoiceId: 'x' })).status).toBe(403);
  });

  it('validation 400; үл мэдэгдэх invoice 404', async () => {
    expect((await simulate(actors.admin(), {})).status).toBe(400);
    expect((await simulate(actors.admin(), { invoiceId: 'missing' })).status).toBe(404);
  });

  it('QPay: mock ledger-т төлөгдсөн болгож жинхэнэ callback урсгалаар бүртгэнэ → PAID invoice буцаана', async () => {
    const loan = await seedLoan(env);
    const { view } = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'QPAY', amount: 40_000 });
    const res = await simulate(actors.admin(), { invoiceId: view.id });
    expect(res.status).toBe(200);
    expect(PaymentInvoiceView.parse(res.body)).toMatchObject({ id: view.id, status: 'PAID', paidAt: '2026-10-28T02:00:00.000Z' });
    const [p] = await env.t.prisma.payment.findMany();
    expect(p).toMatchObject({ provider: 'QPAY', invoiceId: view.id });
    expect(Number(p.amount)).toBe(40_000);
    expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
  });

  it('SocialPay ба өөр дүн (дүн зөрөх тохиолдол)', async () => {
    const loan = await seedLoan(env);
    const { view } = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'SOCIALPAY', amount: 40_000 });
    const res = await simulate(actors.admin(), { invoiceId: view.id, amount: 55_000 });
    expect(res.body.status).toBe('PAID');
    const [p] = await env.t.prisma.payment.findMany();
    expect(p.provider).toBe('SOCIALPAY');
    expect(Number(p.amount)).toBe(55_000);
  });

  it('банкны шилжүүлэг: mock гүйлгээ нэмж тулгалтыг ажиллуулна', async () => {
    const loan = await seedLoan(env);
    const { view } = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 25_000 });
    const res = await simulate(actors.admin(), { invoiceId: view.id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
    const entry = await env.t.prisma.bankTransferEntry.findFirstOrThrow();
    expect(entry.status).toBe('MATCHED');
    expect(entry.description).toContain(view.senderInvoiceNo);
    expect(await env.t.prisma.payment.count()).toBe(1);
  });

  it('PENDING биш invoice-д 409 INVOICE_NOT_PENDING (давхар төлөхгүй)', async () => {
    const loan = await seedLoan(env);
    const { view } = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'QPAY', amount: 40_000 });
    await simulate(actors.admin(), { invoiceId: view.id });
    const again = await simulate(actors.admin(), { invoiceId: view.id });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVOICE_NOT_PENDING');
    expect(await env.t.prisma.payment.count()).toBe(1);
  });

  it('NODE_ENV=production бол 404', async () => {
    const loan = await seedLoan(env);
    const { view } = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'QPAY', amount: 40_000 });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect((await simulate(actors.admin(), { invoiceId: view.id })).status).toBe(404);
    } finally { process.env.NODE_ENV = prev; }
    expect(await env.t.prisma.payment.count()).toBe(0);
    expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PENDING');
  });

  it('өөр байгууллагын invoice → 404', async () => {
    const loan = await seedLoan(env);
    const { view } = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'QPAY', amount: 40_000 });
    expect((await simulate({ ...actors.admin(), 'x-org-id': 'other-org' }, { invoiceId: view.id })).status).toBe(404);
  });
});
