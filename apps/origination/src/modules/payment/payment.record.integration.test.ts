import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentService } from './payment.service';
import { actors, hasTestDb } from '../../test-utils/factories';
import { bootPayment, makeInvoice, paymentEvents, PaymentEnv, recordDirect, resetPayment, seedLoan, sumRows } from './payment.test-helpers';

describe.skipIf(!hasTestDb)('payment: PaymentService.recordPayment (нэг транзакц, idempotent, түгжээ)', () => {
  let env: PaymentEnv;
  beforeAll(async () => { env = await bootPayment(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const svc = () => env.t.app.get(PaymentService);
  const actor = (orgId = 'org-test') => ({ orgId, userId: 'tester', correlationId: 'corr-1' });

  it('(provider, providerPaymentId) idempotent: дахин бүртгэхгүй, дүн/хуваарилалт өөрчлөгдөхгүй', async () => {
    const { app, rows } = await seedLoan(env);
    const a = await recordDirect(env, app.id, 50_000, { id: 'X1' });
    const b = await recordDirect(env, app.id, 999_999, { id: 'X1' }); // өөр дүн ирсэн ч байгааг буцаана
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.payment.id).toBe(a.payment.id);
    expect(Number(b.payment.amount)).toBe(50_000);
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await env.t.prisma.paymentAllocation.count()).toBe(a.payment.allocations.length);
    expect(a.payment.allocations[0].scheduleRowId).toBe(rows[0].id);
    expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
  });

  it('ижил providerPaymentId өөр провайдерт өөр төлбөр', async () => {
    const { app } = await seedLoan(env);
    await recordDirect(env, app.id, 5000, { id: 'SAME', provider: 'QPAY' });
    await recordDirect(env, app.id, 5000, { id: 'SAME', provider: 'SOCIALPAY' });
    expect(await env.t.prisma.payment.count()).toBe(2);
  });

  it('ЗЭРЭГЦЭЭ ижил төлбөр 10 удаа → нэг Payment', async () => {
    const { app } = await seedLoan(env);
    const results = await Promise.all(Array.from({ length: 10 }, () => recordDirect(env, app.id, 30_000, { id: 'SAME-1' })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.payment.id)).size).toBe(1);
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await env.t.prisma.outbox.count()).toBe(1);
  });

  it('ЗЭРЭГЦЭЭ ӨӨР төлбөрүүд: түгжээгээр дараалагдаж мөр хэтрүүлж хуваарилахгүй; нийлбэр = төлсөн', async () => {
    const { app, rows } = await seedLoan(env, { months: 3 });
    const total = sumRows(rows, 0, 3);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => recordDirect(env, app.id, 200_000, { id: `C${i}` })));
    expect(results.every((r) => r.created)).toBe(true);
    const allocs = await env.t.prisma.paymentAllocation.findMany();
    for (const r of rows) {
      const paid = allocs.filter((a) => a.scheduleRowId === r.id).reduce((s, a) => s + Number(a.totalPaid), 0);
      expect(Math.round(paid * 100) / 100, `мөр ${r.seq}`).toBe(Number(r.total));
    }
    const payments = await env.t.prisma.payment.findMany();
    const unallocated = payments.reduce((s, p) => s + Number(p.unallocatedAmount), 0);
    expect(Math.round(unallocated * 100) / 100).toBe(Math.round((8 * 200_000 - total) * 100) / 100);
    expect(payments.reduce((s, p) => s + Number(p.amount), 0)).toBe(1_600_000);
  });

  it('дүн эерэг биш → 400; 2 орноос олныг бөөрөнхийлнө; үл мэдэгдэх хүсэлт', async () => {
    const { app } = await seedLoan(env);
    for (const amount of [0, -5, Number.NaN]) {
      await expect(recordDirect(env, app.id, amount)).rejects.toMatchObject({ status: 400 });
    }
    const r = await recordDirect(env, app.id, 1000.005, { id: 'R' });
    expect(Number(r.payment.amount)).toBe(1000.01);
    await expect(svc().recordPayment(actor(), { applicationId: 'missing', provider: 'QPAY', providerPaymentId: 'Z', amount: 5, currency: 'MNT', paidAt: new Date() })).rejects.toMatchObject({ status: 400 });
    await expect(svc().recordPayment(actor('other-org'), { applicationId: app.id, provider: 'QPAY', providerPaymentId: 'Z2', amount: 5, currency: 'MNT', paidAt: new Date() })).rejects.toMatchObject({ status: 400 });
  });

  it('нууц/PII: дансны дугаар нуугдмал, raw-аас токен хасагдана', async () => {
    const { app } = await seedLoan(env);
    const res = await svc().recordPayment(actor(), {
      applicationId: app.id, provider: 'QPAY', providerPaymentId: 'S1', amount: 5000, currency: 'MNT', paidAt: new Date(),
      payerName: 'Бат', payerAccount: '5012345678', raw: { payment_id: 'S1', access_token: 'LEAK', payer_account: '5012345678', nested: { password: 'p' } },
    });
    expect(res.payment.payerAccountMasked).toBe('******5678');
    const json = JSON.stringify(res.payment.rawJson);
    expect(json).not.toContain('LEAK');
    expect(json).not.toContain('5012345678');
    expect(json).not.toContain('password');
  });

  it('PaymentReceived event нэг транзакцид outbox-д: actor, correlationId, scheduleRowIds', async () => {
    const { app, rows } = await seedLoan(env);
    const res = await recordDirect(env, app.id, 500_000, { id: 'E1', invoiceId: null });
    const [ev] = await paymentEvents(env);
    expect(ev).toMatchObject({ paymentId: res.payment.id, applicationId: app.id, provider: 'BANK_TRANSFER', amount: 500_000, currency: 'MNT', unallocatedAmount: 0, actorId: 'tester', correlationId: 'test-corr', orgId: 'org-test', version: 1 });
    expect(ev.scheduleRowIds).toEqual(res.payment.allocations.map((a) => a.scheduleRowId));
    expect(ev.scheduleRowIds[0]).toBe(rows[0].id);
    expect(ev.paidAt).toBe(res.payment.paidAt.toISOString());
  });

  it('hook нь төлбөртэй нэг транзакцид: hook алдаатай бол бүгд rollback (payment, allocation, invoice, event)', async () => {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 20_000 });
    await expect(svc().recordPayment(actor(), {
      applicationId: loan.app.id, invoiceId: inv.view.id, provider: 'BANK_TRANSFER', providerPaymentId: 'H1', amount: 20_000, currency: 'MNT', paidAt: new Date(),
    }, async () => { throw new Error('hook унав'); })).rejects.toThrow('hook унав');
    expect(await env.t.prisma.payment.count()).toBe(0);
    expect(await env.t.prisma.paymentAllocation.count()).toBe(0);
    expect(await env.t.prisma.outbox.count()).toBe(0);
    expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.view.id } })).status).toBe('PENDING');
  });

  it('hook байгаа төлбөрт ч дуудагдана (created=false)', async () => {
    const { app } = await seedLoan(env);
    await recordDirect(env, app.id, 5000, { id: 'HK' });
    const seen: boolean[] = [];
    await svc().recordPayment(actor(), { applicationId: app.id, provider: 'BANK_TRANSFER', providerPaymentId: 'HK', amount: 5000, currency: 'MNT', paidAt: new Date() }, async (_tx, r) => { seen.push(r.created); });
    expect(seen).toEqual([false]);
  });

  it('invoice-ийн дүнтэй зөрүүтэй төлбөр: төлсөн дүнгээр бүртгэнэ, invoice PAID (paidAt-ийг дараагийн төлбөр дарахгүй)', async () => {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, actors.officer(), { applicationId: loan.app.id, provider: 'BANK_TRANSFER', amount: 20_000 });
    const first = await recordDirect(env, loan.app.id, 15_000, { id: 'M1', invoiceId: inv.view.id, paidAt: new Date('2026-10-28T01:00:00Z') });
    await recordDirect(env, loan.app.id, 5_000, { id: 'M2', invoiceId: inv.view.id, paidAt: new Date('2026-10-28T02:00:00Z') });
    const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.view.id } });
    expect(db.status).toBe('PAID');
    expect(db.paidAt?.toISOString()).toBe('2026-10-28T01:00:00.000Z');
    expect(Number(first.payment.amount)).toBe(15_000);
    expect(await env.t.prisma.payment.count({ where: { invoiceId: inv.view.id } })).toBe(2);
  });
});
