import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentView } from '@los/contracts';
import { actors, createSchedule, hasTestDb } from '../../test-utils/factories';
import { toPaymentView, PAYMENT_INCLUDE } from './payment.mapper';
import { PaymentService } from './payment.service';
import { bootPayment, makeInvoice, paymentEvents, PaymentEnv, resetPayment, row, seedLoan, sumRows } from './payment.test-helpers';

describe.skipIf(!hasTestDb)('payment: callback → checkInvoice → recordPayment (HTTP)', () => {
  let env: PaymentEnv;
  beforeAll(async () => { env = await bootPayment(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const qpayGet = (q: string) => env.http().get(`/api/payments/callbacks/qpay?${q}`);
  const officer = actors.officer();

  async function qpayInvoice(body: Record<string, unknown> = {}) {
    const loan = await seedLoan(env);
    const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', ...body });
    return { ...loan, ...inv };
  }
  const loadPayments = () => env.t.prisma.payment.findMany({ include: PAYMENT_INCLUDE, orderBy: { createdAt: 'asc' } });

  it('QPay GET callback (нэвтрэлтгүй): 200 SUCCESS text/plain, төлбөр хуваарилагдана, invoice PAID, event outbox-д', async () => {
    const { app, rows, view, db } = await qpayInvoice();
    env.qpay.simulatePayment(db.providerInvoiceId as string, { payerName: 'Тест', payerAccount: '5012345678' });

    const res = await qpayGet(`invoice=${view.senderInvoiceNo}&qpay_payment_id=abc123`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('SUCCESS');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);

    const payments = await loadPayments();
    expect(payments).toHaveLength(1);
    const p = payments[0];
    expect(p).toMatchObject({ applicationId: app.id, invoiceId: view.id, provider: 'QPAY', currency: 'MNT', payerAccountMasked: '******5678', createdBy: null });
    expect(p.providerPaymentId).toBe(`${db.providerInvoiceId}_P1`);
    expect(Number(p.amount)).toBe(sumRows(rows, 0, 2));
    expect(Number(p.unallocatedAmount)).toBe(0);
    // хуваарилалт: хамгийн эрт мөрөөс, мөр дотор хүү → үндсэн
    expect(p.allocations.map((a) => a.scheduleRowId).sort()).toEqual([rows[0].id, rows[1].id].sort());
    for (const a of p.allocations) {
      const r = rows.find((x) => x.id === a.scheduleRowId)!;
      expect(Number(a.interestPaid)).toBe(Number(r.interest));
      expect(Number(a.principalPaid)).toBe(Number(r.principal));
    }
    PaymentView.parse(toPaymentView(p));
    expect(JSON.stringify(p.rawJson)).not.toContain('5012345678');

    const invoice = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } });
    expect(invoice).toMatchObject({ status: 'PAID' });
    expect(invoice.paidAt?.toISOString()).toBe('2026-10-28T02:00:00.000Z');

    const events = await paymentEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ paymentId: p.id, applicationId: app.id, provider: 'QPAY', amount: sumRows(rows, 0, 2), currency: 'MNT', unallocatedAmount: 0, actorId: null });
    expect([...events[0].scheduleRowIds].sort()).toEqual([rows[0].id, rows[1].id].sort());
  });

  it('POST callback: query-ээр, JSON body-оор (invoice / sender_invoice_no)', async () => {
    const a = await qpayInvoice({ amount: 5000 });
    env.qpay.simulatePayment(a.db.providerInvoiceId as string);
    expect((await env.http().post(`/api/payments/callbacks/qpay?invoice=${a.view.senderInvoiceNo}`)).text).toBe('SUCCESS');
    expect(await env.t.prisma.payment.count()).toBe(1);

    const b = await makeInvoice(env, officer, { applicationId: a.app.id, provider: 'QPAY', amount: 6000 });
    env.qpay.simulatePayment(b.db.providerInvoiceId as string);
    expect((await env.http().post('/api/payments/callbacks/qpay').send({ invoice: b.view.senderInvoiceNo, qpay_payment_id: 'x' })).status).toBe(200);
    expect(await env.t.prisma.payment.count()).toBe(2);

    const c = await makeInvoice(env, officer, { applicationId: a.app.id, provider: 'QPAY', amount: 7000 });
    env.qpay.simulatePayment(c.db.providerInvoiceId as string);
    expect((await env.http().post('/api/payments/callbacks/qpay').send({ sender_invoice_no: c.view.senderInvoiceNo })).status).toBe(200);
    expect(await env.t.prisma.payment.count()).toBe(3);
  });

  it('callback-ийн агуулгад итгэхгүй: провайдерт төлөгдөөгүй бол хуурамч callback нөлөөгүй', async () => {
    const { view } = await qpayInvoice();
    const res = await env.http().post(`/api/payments/callbacks/qpay?invoice=${view.senderInvoiceNo}`).send({ status: 'PAID', amount: 99_999_999, payment_status: 'PAID' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('SUCCESS');
    expect(await env.t.prisma.payment.count()).toBe(0);
    expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PENDING');
  });

  it('үл мэдэгдэх / буруу / дутуу invoice → үргэлж 200 SUCCESS, юу ч бүртгэгдэхгүй', async () => {
    await qpayInvoice();
    for (const q of ['invoice=LOS-NOPE-1', 'invoice=', '', "invoice=' OR 1=1 --", `invoice=${'X'.repeat(65)}`, 'qpay_payment_id=only']) {
      const res = await qpayGet(q);
      expect(res.status, q).toBe(200);
      expect(res.text, q).toBe('SUCCESS');
    }
    expect((await env.http().post('/api/payments/callbacks/qpay').send('not json')).status).toBeLessThan(500);
    expect(await env.t.prisma.payment.count()).toBe(0);
  });

  it('өөр провайдерын invoice-д QPay callback ирвэл үл тоомсорлоно; SocialPay callback-аар бүртгэгдэнэ', async () => {
    const loan = await seedLoan(env);
    const sp = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'SOCIALPAY', amount: 20_000 });
    env.socialpay.simulatePayment(sp.db.providerInvoiceId as string);
    await qpayGet(`invoice=${sp.view.senderInvoiceNo}`);
    expect(await env.t.prisma.payment.count()).toBe(0);
    const res = await env.http().post('/api/payments/callbacks/socialpay').send({ invoice: sp.view.senderInvoiceNo });
    expect(res.status).toBe(200);
    expect(res.text).toBe('SUCCESS');
    const [p] = await loadPayments();
    expect(p).toMatchObject({ provider: 'SOCIALPAY', invoiceId: sp.view.id });
    expect(Number(p.amount)).toBe(20_000);
  });

  it('давхар callback (дараалан) → нэг л Payment, дахин хуваарилахгүй', async () => {
    const { view, db, rows } = await qpayInvoice();
    env.qpay.simulatePayment(db.providerInvoiceId as string);
    for (let i = 0; i < 3; i++) await qpayGet(`invoice=${view.senderInvoiceNo}`);
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await env.t.prisma.paymentAllocation.count()).toBe(2);
    expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
    expect(Number((await loadPayments())[0].amount)).toBe(sumRows(rows, 0, 2));
  });

  it('ЗЭРЭГЦЭЭ ижил callback 8 удаа (Promise.all) → яг нэг Payment, нэг event', async () => {
    const { view, db, rows } = await qpayInvoice();
    env.qpay.simulatePayment(db.providerInvoiceId as string);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? qpayGet(`invoice=${view.senderInvoiceNo}`) : env.http().post(`/api/payments/callbacks/qpay?invoice=${view.senderInvoiceNo}`))));
    expect(results.every((r) => r.status === 200 && r.text === 'SUCCESS')).toBe(true);
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await env.t.prisma.paymentAllocation.count()).toBe(2);
    expect(await env.t.prisma.outbox.count({ where: { type: 'PaymentReceived' } })).toBe(1);
    const sums = await env.t.prisma.paymentAllocation.aggregate({ _sum: { totalPaid: true } });
    expect(Number(sums._sum.totalPaid)).toBe(sumRows(rows, 0, 2));
  });

  it('ЗЭРЭГЦЭЭ callback + GET poll + maintenance-ийн нэг төлбөр → нэг Payment', async () => {
    const { view, db } = await qpayInvoice();
    env.qpay.simulatePayment(db.providerInvoiceId as string);
    await Promise.all([
      qpayGet(`invoice=${view.senderInvoiceNo}`),
      env.http().get(`/api/payments/invoices/${view.id}`).set(officer),
      env.http().get(`/api/payments/invoices/${view.id}`).set(actors.admin()),
      qpayGet(`invoice=${view.senderInvoiceNo}`),
    ]);
    expect(await env.t.prisma.payment.count()).toBe(1);
    expect(await env.t.prisma.paymentAllocation.count()).toBe(2);
  });

  it('провайдер алдаатай үед callback 200 SUCCESS (бүртгэхгүй); дараагийн callback/poll бүртгэнэ', async () => {
    const { view, db } = await qpayInvoice();
    env.qpay.simulatePayment(db.providerInvoiceId as string);
    env.qpay.failNext({ method: 'checkInvoice' });
    const res = await qpayGet(`invoice=${view.senderInvoiceNo}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('SUCCESS');
    expect(await env.t.prisma.payment.count()).toBe(0);
    await qpayGet(`invoice=${view.senderInvoiceNo}`);
    expect(await env.t.prisma.payment.count()).toBe(1);
  });

  it('дүн таарахгүй бол төлсөн дүнгээр бүртгэнэ, invoice PAID', async () => {
    const { view, db, rows } = await qpayInvoice({ amount: 30_000 });
    env.qpay.simulatePayment(db.providerInvoiceId as string, { amount: 40_000 });
    await qpayGet(`invoice=${view.senderInvoiceNo}`);
    const [p] = await loadPayments();
    expect(Number(p.amount)).toBe(40_000);
    expect(Number(p.unallocatedAmount)).toBe(0);
    expect(p.allocations.reduce((s, a) => s + Number(a.totalPaid), 0)).toBe(40_000);
    expect(p.allocations).toHaveLength(1); // 40,000 < мөр 1-ийн нийт төлбөр → зөвхөн мөр 1 хэсэгчлэн
    expect(p.allocations[0].scheduleRowId).toBe(rows[0].id);
    expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status).toBe('PAID');
  });

  it('хугацаа дууссан / цуцлагдсан invoice-д хожуу орж ирсэн төлбөрийг ч бүртгэнэ (мөнгө алдахгүй)', async () => {
    for (const status of ['EXPIRED', 'CANCELLED']) {
      await resetPayment(env);
      const { view, db } = await qpayInvoice({ amount: 10_000 });
      await env.t.prisma.paymentInvoice.update({ where: { id: view.id }, data: { status } });
      env.qpay.simulatePayment(db.providerInvoiceId as string);
      await qpayGet(`invoice=${view.senderInvoiceNo}`);
      expect(await env.t.prisma.payment.count(), status).toBe(1);
      expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } })).status, status).toBe('PAID');
    }
  });

  describe('хуваарилалт (бизнес дүрэм 4)', () => {
    it('хэсэгчилсэн төлөлтүүд дараалан нэмэгдэнэ: хүү → үндсэн, дараа нь дараагийн мөр', async () => {
      const loan = await seedLoan(env);
      const { rows } = loan;
      const pay = async (amount: number) => {
        const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount });
        env.qpay.simulatePayment(inv.db.providerInvoiceId as string);
        await qpayGet(`invoice=${inv.view.senderInvoiceNo}`);
      };
      const interest1 = Number(rows[0].interest);
      await pay(interest1 + 1000); // хүү бүтэн + үндсэнээс 1000
      await pay(2000);              // үндсэн +2000
      const allocs = await env.t.prisma.paymentAllocation.findMany({ where: { scheduleRowId: rows[0].id }, orderBy: { id: 'asc' } });
      const paidInterest = allocs.reduce((s, a) => s + Number(a.interestPaid), 0);
      const paidPrincipal = allocs.reduce((s, a) => s + Number(a.principalPaid), 0);
      expect(paidInterest).toBe(interest1);
      expect(Math.round(paidPrincipal * 100) / 100).toBe(3000);
      // нийт төлсөн 3000+interest1 → мөр 2 хөндөгдөөгүй
      expect(await env.t.prisma.paymentAllocation.count({ where: { scheduleRowId: rows[1].id } })).toBe(0);
    });

    it('мөр бүрэн төлөгдсөний дараа дараагийн төлбөр дараагийн мөрөөс эхэлнэ', async () => {
      const loan = await seedLoan(env);
      const { rows } = loan;
      const pay = async (amount: number) => {
        const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount });
        env.qpay.simulatePayment(inv.db.providerInvoiceId as string);
        await qpayGet(`invoice=${inv.view.senderInvoiceNo}`);
      };
      await pay(row(rows, 0));
      await pay(5000);
      const second = await env.t.prisma.payment.findMany({ orderBy: { createdAt: 'desc' }, take: 1, include: { allocations: true } });
      expect(second[0].allocations).toHaveLength(1);
      expect(second[0].allocations[0].scheduleRowId).toBe(rows[1].id);
    });

    it('нийт үлдэгдлээс их төлвөл илүүг unallocated гэж бүртгэнэ (урьдчилсан төлөлт)', async () => {
      const loan = await seedLoan(env, { months: 2 });
      const total = sumRows(loan.rows, 0, 2);
      const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 1000 });
      env.qpay.simulatePayment(inv.db.providerInvoiceId as string, { amount: total + 5000 });
      await qpayGet(`invoice=${inv.view.senderInvoiceNo}`);
      const [p] = await loadPayments();
      expect(Number(p.amount)).toBe(total + 5000);
      expect(Number(p.unallocatedAmount)).toBe(5000);
      expect(p.allocations.reduce((s, a) => s + Number(a.totalPaid), 0)).toBe(total);
      expect((await paymentEvents(env))[0].unallocatedAmount).toBe(5000);
    });

    it('төлбөр орох үед ЭТХ stale болсон бол бүх дүн unallocated (алдаагүй, мөнгө алдахгүй)', async () => {
      const { view, db, app, schedule } = await qpayInvoice({ amount: 10_000 });
      await env.t.prisma.repaymentSchedule.update({ where: { id: schedule!.id }, data: { isStale: true } });
      env.qpay.simulatePayment(db.providerInvoiceId as string);
      await qpayGet(`invoice=${view.senderInvoiceNo}`);
      const [p] = await loadPayments();
      expect(p.applicationId).toBe(app.id);
      expect(Number(p.amount)).toBe(10_000);
      expect(Number(p.unallocatedAmount)).toBe(10_000);
      expect(p.allocations).toHaveLength(0);
      expect((await paymentEvents(env))[0]).toMatchObject({ unallocatedAmount: 10_000, scheduleRowIds: [] });
    });

    it('ЭТХ огт байхгүй бол ч бүртгэнэ', async () => {
      const { view, db, schedule } = await qpayInvoice({ amount: 10_000 });
      await env.t.prisma.repaymentSchedule.delete({ where: { id: schedule!.id } });
      env.qpay.simulatePayment(db.providerInvoiceId as string);
      await qpayGet(`invoice=${view.senderInvoiceNo}`);
      const [p] = await loadPayments();
      expect(Number(p.unallocatedAmount)).toBe(10_000);
    });

    it('шинэ (stale биш) ЭТХ үүссэн бол түүний мөрүүдэд хуваарилна', async () => {
      const { view, db, app, schedule } = await qpayInvoice({ amount: 10_000 });
      await env.t.prisma.repaymentSchedule.update({ where: { id: schedule!.id }, data: { isStale: true } });
      const fresh = await createSchedule(env.t.prisma, app.id, { firstDue: '2026-10-28', principal: 600_000, months: 6 });
      env.qpay.simulatePayment(db.providerInvoiceId as string);
      await qpayGet(`invoice=${view.senderInvoiceNo}`);
      const [p] = await loadPayments();
      expect(Number(p.unallocatedAmount)).toBe(0);
      expect(p.allocations.every((a) => fresh.rows.some((r) => r.id === a.scheduleRowId))).toBe(true);
    });

    it('валют зөрүүтэй төлбөр хуваарилагдахгүй (unallocated)', async () => {
      const loan = await seedLoan(env);
      const inv = await makeInvoice(env, officer, { applicationId: loan.app.id, provider: 'QPAY', amount: 10_000 });
      // mock нь зөвхөн MNT тул service-ийг шууд дуудна
      const res = await env.t.app.get(PaymentService).recordPayment({ orgId: loan.app.orgId, userId: null, correlationId: 'c' }, {
        applicationId: loan.app.id, invoiceId: inv.view.id, provider: 'QPAY', providerPaymentId: 'USD-1', amount: 100, currency: 'USD', paidAt: new Date(),
      });
      expect(Number(res.payment.unallocatedAmount)).toBe(100);
      expect(res.payment.allocations).toHaveLength(0);
    });
  });
});
