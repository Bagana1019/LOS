import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentInvoiceView, PaymentProviderInfo } from '@los/contracts';
import { ProviderRejectedError } from '../../integrations/payment-provider/provider-errors';
import { actors, hasTestDb, ORG } from '../../test-utils/factories';
import { bootPayment, PaymentEnv, recordDirect, resetPayment, row, seedLoan, setSetting, sumRows } from './payment.test-helpers';

describe.skipIf(!hasTestDb)('payment: invoice үүсгэх / унших / цуцлах (HTTP)', () => {
  let env: PaymentEnv;
  beforeAll(async () => { env = await bootPayment(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetPayment(env); });

  const create = (headers: Record<string, string>, body: unknown) => env.http().post('/api/payments/invoices').set(headers).send(body as object);

  describe('эрх ба validation', () => {
    it('нэвтрээгүй → 401; үл мэдэгдэх хүсэлт → 404', async () => {
      const { app } = await seedLoan(env);
      expect((await create(actors.anonymous(), { applicationId: app.id, provider: 'QPAY' })).status).toBe(401);
      const res = await create(actors.admin(), { applicationId: 'missing', provider: 'QPAY' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
    });

    it('өөр ЗЭЗ → 403; батлагч (pay эрхгүй) → 403; өөрийн ЗЭЗ, админ, салбарын захирал → OK', async () => {
      const { app } = await seedLoan(env);
      expect((await create(actors.officer('officer-2'), { applicationId: app.id, provider: 'QPAY' })).status).toBe(403);
      expect((await create(actors.approver(), { applicationId: app.id, provider: 'QPAY' })).status).toBe(403);
      expect((await create(actors.officer('officer-1'), { applicationId: app.id, provider: 'QPAY' })).status).toBe(201);
      expect((await create(actors.admin(), { applicationId: app.id, provider: 'QPAY', amount: 5000 })).status).toBe(201);
      expect((await create(actors.branchManager('bm', 'branch-1'), { applicationId: app.id, provider: 'QPAY', amount: 6000 })).status).toBe(201);
      expect((await create(actors.branchManager('bm', 'branch-2'), { applicationId: app.id, provider: 'QPAY', amount: 7000 })).status).toBe(403);
    });

    it('CUSTOMER: зөвхөн өөрийн хүсэлт (PRIMARY/CO_BORROWER); гуравдагч этгээд, батлан даагч → 403', async () => {
      const { app, customer } = await seedLoan(env);
      const other = await seedLoan(env);
      expect((await create(actors.customer(customer.id), { applicationId: app.id, provider: 'QPAY' })).status).toBe(201);
      expect((await create(actors.customer(other.customer.id), { applicationId: app.id, provider: 'QPAY' })).status).toBe(403);
    });

    it('validation: provider, дүн, 2-оос олон орон → 400 VALIDATION_FAILED', async () => {
      const { app } = await seedLoan(env);
      for (const bad of [{}, { applicationId: app.id }, { applicationId: app.id, provider: 'PAYPAL' }, { applicationId: app.id, provider: 'QPAY', amount: -5 }, { applicationId: app.id, provider: 'QPAY', amount: 0 }, { applicationId: app.id, provider: 'QPAY', amount: 1000.123 }, { applicationId: app.id, provider: 'QPAY', note: 'x'.repeat(201) }]) {
        const res = await create(actors.admin(), bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('урьдчилсан нөхцөл', () => {
    it('ACTIVE/MIGRATED биш төлөв → 409 LOAN_NOT_PAYABLE; MIGRATED → OK', async () => {
      for (const status of ['DRAFT', 'APPROVED', 'DISBURSING', 'CLOSED']) {
        const { app } = await seedLoan(env, { status });
        const res = await create(actors.admin(), { applicationId: app.id, provider: 'QPAY' });
        expect(res.status, status).toBe(409);
        expect(res.body.code).toBe('LOAN_NOT_PAYABLE');
      }
      const { app } = await seedLoan(env, { status: 'MIGRATED' });
      expect((await create(actors.admin(), { applicationId: app.id, provider: 'QPAY' })).status).toBe(201);
    });

    it('ЭТХ байхгүй эсвэл бүгд stale → 409 SCHEDULE_NOT_FOUND', async () => {
      const none = await seedLoan(env, { withSchedule: false });
      const stale = await seedLoan(env, { stale: true });
      for (const { app } of [none, stale]) {
        const res = await create(actors.admin(), { applicationId: app.id, provider: 'QPAY' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SCHEDULE_NOT_FOUND');
      }
    });

    it('QPay/SocialPay нь зөвхөн MNT; банкны шилжүүлэг ямар ч валютад', async () => {
      const { app } = await seedLoan(env, { currency: 'USD' });
      const qpay = await create(actors.admin(), { applicationId: app.id, provider: 'QPAY' });
      expect(qpay.status).toBe(422);
      expect(qpay.body.code).toBe('CURRENCY_NOT_SUPPORTED');
      const bank = await create(actors.admin(), { applicationId: app.id, provider: 'BANK_TRANSFER' });
      expect(bank.status).toBe(201);
      expect(bank.body.currency).toBe('USD');
    });
  });

  describe('дүн (бизнес дүрэм 1)', () => {
    it('юу ч өгөөгүй: payNowAmount = хэтэрсэн + өнөөдөр төлөх мөрүүд', async () => {
      const { app, rows } = await seedLoan(env);
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(sumRows(rows, 0, 2));
      expect(res.body.scheduleRowId).toBeNull();
    });

    it('scheduleRowId: тэр мөрийн дүн; amount өгвөл түүгээр (≤ үлдэгдэл)', async () => {
      const { app, rows } = await seedLoan(env);
      const a = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', scheduleRowId: rows[2].id });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ amount: row(rows, 2), scheduleRowId: rows[2].id });
      const b = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', scheduleRowId: rows[2].id, amount: 30_000 });
      expect(b.status).toBe(201);
      expect(b.body.amount).toBe(30_000);
      const c = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', scheduleRowId: rows[2].id, amount: row(rows, 2) + 1 });
      expect(c.status).toBe(422);
      expect(c.body.code).toBe('AMOUNT_OUT_OF_RANGE');
      const d = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', scheduleRowId: 'no-such-row' });
      expect(d.status).toBe(404);
      expect(d.body.code).toBe('SCHEDULE_ROW_NOT_FOUND');
    });

    it('өөр хуваарийн мөр (өөр хүсэлтийнх) → 404 SCHEDULE_ROW_NOT_FOUND', async () => {
      const { app } = await seedLoan(env);
      const other = await seedLoan(env);
      const res = await create(actors.admin(), { applicationId: app.id, provider: 'QPAY', scheduleRowId: other.rows[0].id });
      expect(res.status).toBe(404);
    });

    it('хязгаар: payment.min_amount-аас бага / нийт үлдэгдлээс их → 422 AMOUNT_OUT_OF_RANGE', async () => {
      const { app, rows } = await seedLoan(env);
      const total = sumRows(rows, 0, rows.length);
      const low = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 999 });
      expect(low.status).toBe(422);
      expect(low.body.code).toBe('AMOUNT_OUT_OF_RANGE');
      expect(low.body.message).toContain('1,000');
      expect((await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: total + 0.01 })).status).toBe(422);
      const full = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: total });
      expect(full.status).toBe(201);
      expect(full.body.amount).toBe(total);
    });

    it('min_amount setting-ийг хүндэтгэнэ', async () => {
      const { app } = await seedLoan(env);
      await setSetting(env, 'payment.min_amount', 50_000);
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 49_999 });
      expect(res.status).toBe(422);
    });

    it('"Одоо төлөх" 300₮ (< min_amount 1000): repayment-status-тай ижил дүнгээр 201; өөрийн заасан 300₮ мөргүй бол 422 хэвээр', async () => {
      const { app, rows } = await seedLoan(env, { firstDue: '2026-10-28' }); // мөр 1 өнөөдөр төлөх ёстой, бусад хараахан биш
      await recordDirect(env, app.id, row(rows, 0) - 300);
      const status = await env.http().get(`/api/applications/${app.id}/repayment-status`).set(actors.officer());
      expect(status.body.payNowAmount).toBe(300);

      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ amount: 300, scheduleRowId: null });
      const row0 = await create(actors.officer(), { applicationId: app.id, provider: 'SOCIALPAY', scheduleRowId: rows[0].id });
      expect(row0.status).toBe(201);
      expect(row0.body.amount).toBe(300);

      const custom = await create(actors.officer(), { applicationId: app.id, provider: 'BANK_TRANSFER', amount: 300 });
      expect(custom.status).toBe(422);
      expect(custom.body.code).toBe('AMOUNT_OUT_OF_RANGE');
    });

    it('зээл бүрэн төлөгдсөн (үлдэгдэл 0) → 409 LOAN_FULLY_PAID; төлөгдсөн мөр → 409 INSTALLMENT_PAID', async () => {
      const { app, rows } = await seedLoan(env, { months: 2 });
      for (const r of rows) await env.t.prisma.payment.create({ data: { orgId: ORG, applicationId: app.id, provider: 'BANK_TRANSFER', providerPaymentId: `P-${r.id}`, amount: r.total, paidAt: new Date(), allocations: { create: [{ scheduleRowId: r.id, interestPaid: r.interest, principalPaid: r.principal, totalPaid: r.total }] } } });
      const all = await create(actors.admin(), { applicationId: app.id, provider: 'QPAY' });
      expect(all.status).toBe(409);
      expect(all.body.code).toBe('LOAN_FULLY_PAID');
      const one = await create(actors.admin(), { applicationId: app.id, provider: 'QPAY', scheduleRowId: rows[0].id });
      expect(one.status).toBe(409);
      expect(one.body.code).toBe('INSTALLMENT_PAID');
    });
  });

  describe('QPay invoice', () => {
    it('201: DTO-д нийцсэн, senderInvoiceNo, QR PNG, deeplink, TTL, DB-д нууцгүй', async () => {
      const { app, rows } = await seedLoan(env);
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', note: 'Сарын төлбөр' });
      expect(res.status).toBe(201);
      const view = PaymentInvoiceView.parse(res.body);
      expect(view).toMatchObject({ applicationId: app.id, provider: 'QPAY', status: 'PENDING', amount: sumRows(rows, 0, 2), currency: 'MNT', paidAt: null, bankTransfer: null });
      expect(view.senderInvoiceNo).toBe(`LOS-${app.appNo}-1`);
      expect(new Date(view.expiresAt).getTime()).toBe(new Date('2026-10-28T02:00:00Z').getTime() + 60 * 60_000);
      expect(view.qrText).toContain('qpay.mock');
      expect(Buffer.from(view.qrImage as string, 'base64').subarray(1, 4).toString()).toBe('PNG');
      expect(view.deeplinks.length).toBeGreaterThan(0);
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: view.id } });
      expect(db.providerInvoiceId).toMatch(/^qpaymock_/);
      expect(db.createdBy).toBe('officer-1');
      expect(JSON.stringify(db.providerResponseJson)).not.toMatch(/token|secret|password/i);
    });

    it('senderInvoiceNo дараалсан, давтагдашгүй (өөр дүнтэй 2-р invoice)', async () => {
      const { app } = await seedLoan(env);
      const a = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 5000 });
      const b = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 6000 });
      expect([a.body.senderInvoiceNo, b.body.senderInvoiceNo]).toEqual([`LOS-${app.appNo}-1`, `LOS-${app.appNo}-2`]);
    });

    it('payment.invoice_ttl_minutes setting-ийг хүндэтгэнэ', async () => {
      const { app } = await seedLoan(env);
      await setSetting(env, 'payment.invoice_ttl_minutes', 15);
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(new Date(res.body.expiresAt).getTime()).toBe(new Date('2026-10-28T02:00:00Z').getTime() + 15 * 60_000);
    });

    it('провайдер талд invoice бүртгэгдсэн', async () => {
      const { app } = await seedLoan(env);
      const before = env.qpay.invoiceCount();
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(env.qpay.invoiceCount()).toBe(before + 1);
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(env.qpay.statusOf(db.providerInvoiceId as string)).toBe('OPEN');
    });
  });

  describe('SocialPay invoice', () => {
    it('201: mock-оор бүрэн урсгал', async () => {
      const { app } = await seedLoan(env);
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'SOCIALPAY', amount: 25_000 });
      expect(res.status).toBe(201);
      expect(PaymentInvoiceView.parse(res.body)).toMatchObject({ provider: 'SOCIALPAY', amount: 25_000, status: 'PENDING' });
      expect(res.body.deeplinks[0].link).toContain('socialpay-payment://');
    });
  });

  describe('банкны шилжүүлгийн заавар', () => {
    it('payment.collection_account setting-ээс; reference = senderInvoiceNo; провайдер дуудахгүй', async () => {
      const { app } = await seedLoan(env);
      await setSetting(env, 'payment.collection_account', { bankCode: 'GOLOMT', accountNo: '1105123456', accountName: 'Радикс ББСБ' });
      const before = env.qpay.invoiceCount();
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'BANK_TRANSFER', amount: 20_000 });
      expect(res.status).toBe(201);
      const view = PaymentInvoiceView.parse(res.body);
      expect(view.bankTransfer).toEqual({ bankCode: 'GOLOMT', accountNo: '1105123456', accountName: 'Радикс ББСБ', reference: view.senderInvoiceNo });
      expect(view.qrImage).toBeNull();
      expect(view.deeplinks).toEqual([]);
      expect(env.qpay.invoiceCount()).toBe(before);
    });

    it('setting байхгүй: mock горимд mock хүлээн авах данс', async () => {
      const { app } = await seedLoan(env);
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'BANK_TRANSFER' });
      expect(res.body.bankTransfer).toMatchObject({ bankCode: 'KHAN', accountNo: '5000000001' });
    });
  });

  describe('давхар дарах (бизнес дүрэм 2: idempotent UX)', () => {
    it('адил хүсэлт → байгаа invoice (200), шинэ үүсэхгүй', async () => {
      const { app, rows } = await seedLoan(env);
      const body = { applicationId: app.id, provider: 'QPAY', scheduleRowId: rows[2].id };
      const a = await create(actors.officer(), body);
      const b = await create(actors.officer(), body);
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body.id).toBe(a.body.id);
      expect(await env.t.prisma.paymentInvoice.count()).toBe(1);
    });

    it('өөр дүн / провайдер / мөр бол шинэ invoice', async () => {
      const { app, rows } = await seedLoan(env);
      const base = { applicationId: app.id, provider: 'QPAY', scheduleRowId: rows[2].id };
      const ids = new Set<string>();
      for (const body of [base, { ...base, amount: 10_000 }, { ...base, provider: 'SOCIALPAY' }, { ...base, scheduleRowId: rows[3].id }, { applicationId: app.id, provider: 'QPAY' }]) {
        const res = await create(actors.officer(), body);
        expect(res.status, JSON.stringify(body)).toBe(201);
        ids.add(res.body.id);
      }
      expect(ids.size).toBe(5);
    });

    it('хугацаа дууссан / цуцалсан / төлөгдсөн бол шинээр үүсгэнэ', async () => {
      const { app } = await seedLoan(env);
      const body = { applicationId: app.id, provider: 'QPAY', amount: 10_000 };
      const first = await create(actors.officer(), body);
      env.t.clock.advanceMs(61 * 60_000);
      const second = await create(actors.officer(), body);
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
      expect((await env.http().post(`/api/payments/invoices/${second.body.id}/cancel`).set(actors.officer())).status).toBe(200);
      const third = await create(actors.officer(), body);
      expect(third.status).toBe(201);
      expect(third.body.id).not.toBe(second.body.id);
    });

    it('зэрэг (Promise.all) 6 адил хүсэлт → нэг invoice, провайдерт нэг', async () => {
      const { app } = await seedLoan(env);
      const before = env.qpay.invoiceCount();
      const body = { applicationId: app.id, provider: 'QPAY', amount: 15_000 };
      const results = await Promise.all(Array.from({ length: 6 }, () => create(actors.officer(), body)));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await env.t.prisma.paymentInvoice.count()).toBe(1);
      expect(env.qpay.invoiceCount()).toBe(before + 1);
    });

    it('зэрэг, ӨӨР дүнтэй хүсэлтүүд → senderInvoiceNo давхцахгүй', async () => {
      const { app } = await seedLoan(env);
      const results = await Promise.all([5000, 6000, 7000, 8000, 9000].map((amount) => create(actors.officer(), { applicationId: app.id, provider: 'BANK_TRANSFER', amount })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.senderInvoiceNo)).size).toBe(5);
    });
  });

  describe('провайдерын алдаа (бизнес дүрэм 7)', () => {
    it('create амжилтгүй → 502 PROVIDER_UNAVAILABLE (монгол мессеж), DB-д хагас invoice үлдэхгүй', async () => {
      const { app } = await seedLoan(env);
      env.qpay.failNext({ method: 'createInvoice' });
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
      expect(res.body.message).toContain('түр хүрэлцэхгүй');
      expect(res.body.message).not.toMatch(/mock|stack|Error/i);
      expect(await env.t.prisma.paymentInvoice.count()).toBe(0);
      // дахин оролдоход амжилттай, дугаар 1-ээс эхэлнэ
      const retry = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(retry.status).toBe(201);
      expect(retry.body.senderInvoiceNo).toBe(`LOS-${app.appNo}-1`);
    });

    it('провайдер татгалзсан (4xx) → 502 PROVIDER_REJECTED, DB цэвэр', async () => {
      const { app } = await seedLoan(env);
      env.qpay.failNext({ error: new ProviderRejectedError('QPay', 'INVOICE_CODE_INVALID') });
      const res = await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PROVIDER_REJECTED');
      expect(JSON.stringify(res.body)).not.toContain('INVOICE_CODE_INVALID');
      expect(await env.t.prisma.paymentInvoice.count()).toBe(0);
    });
  });

  describe('GET payments/invoices/:id', () => {
    it('PENDING invoice-ийг буцаана; эрх: өөр ЗЭЗ 403, батлагч (read) OK, CUSTOMER өөрийн OK, нэвтрээгүй 401, үл мэдэгдэх 404', async () => {
      const { app, customer } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const get = (headers: Record<string, string>, id = inv.id) => env.http().get(`/api/payments/invoices/${id}`).set(headers);
      const ok = await get(actors.officer());
      expect(ok.status).toBe(200);
      expect(PaymentInvoiceView.parse(ok.body).status).toBe('PENDING');
      expect((await get(actors.approver())).status).toBe(200);
      expect((await get(actors.customer(customer.id))).status).toBe(200);
      expect((await get(actors.officer('officer-2'))).status).toBe(403);
      expect((await get(actors.anonymous())).status).toBe(401);
      const missing = await get(actors.admin(), 'missing');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('INVOICE_NOT_FOUND');
    });

    it('callback алдагдсан үед: провайдерт төлөгдсөн бол GET нь шалгаж PAID болгож төлбөр бүртгэнэ', async () => {
      const { app, rows } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      env.qpay.simulatePayment(db.providerInvoiceId as string); // callback ирээгүй
      const res = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(res.body.status).toBe('PAID');
      expect(res.body.paidAt).toBe('2026-10-28T02:00:00.000Z');
      const payments = await env.t.prisma.payment.findMany({ include: { allocations: true } });
      expect(payments).toHaveLength(1);
      expect(Number(payments[0].amount)).toBe(sumRows(rows, 0, 2));
      expect(payments[0].invoiceId).toBe(inv.id);
      // дахин унших = дахин бүртгэхгүй
      await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(await env.t.prisma.payment.count()).toBe(1);
    });

    it('хугацаа дуусвал EXPIRED болгож, провайдерт цуцална', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      env.t.clock.advanceMs(61 * 60_000);
      const res = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(res.body.status).toBe('EXPIRED');
      expect(env.qpay.statusOf(db.providerInvoiceId as string)).toBe('CANCELLED');
    });

    it('хугацаа дуусах мөчид төлсөн бол (provider paid) EXPIRED биш PAID', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      env.qpay.simulatePayment(db.providerInvoiceId as string);
      env.t.clock.advanceMs(61 * 60_000);
      const res = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(res.body.status).toBe('PAID');
    });

    it('провайдер унтарсан үед GET унахгүй — одоогийн төлвийг буцаана', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      env.qpay.failNext({ method: 'checkInvoice' });
      const res = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PENDING');
    });

    it('хугацаа дуусах үед провайдерын шалгалт унавал EXPIRED болгохгүй (төлөгдсөн байж болно): PENDING хэвээр, дараагийн GET дээр PAID', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      env.qpay.simulatePayment(db.providerInvoiceId as string); // callback алдагдсан
      env.t.clock.advanceMs(2 * 3_600_000);
      env.qpay.failNext({ method: 'checkInvoice', times: 1 });

      const down = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(down.status).toBe(200);
      expect(down.body.status).toBe('PENDING');
      expect(env.qpay.statusOf(db.providerInvoiceId as string)).toBe('PAID'); // провайдерт цуцлаагүй
      expect(await env.t.prisma.payment.count()).toBe(0);

      const again = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
      expect(again.body.status).toBe('PAID');
      expect(await env.t.prisma.payment.count()).toBe(1);
    });

    it('провайдер удаан унтарсан: хугацаа дууссанаас 24 цагийн дараа л хүчээр EXPIRED болно', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      env.qpay.failNext({ method: 'checkInvoice', times: 100 });
      const get = async () => (await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer())).body.status;
      env.t.clock.advanceMs(23 * 3_600_000); // TTL 1 цаг + 22 цаг
      expect(await get()).toBe('PENDING');
      env.t.clock.advanceMs(2 * 3_600_000); // TTL + 24 цагаас хэтэрсэн
      expect(await get()).toBe('EXPIRED');
    });

    it('хугацаа дуусгах үед цуцлалтыг провайдер "төлөгдсөн" гэж татгалзвал дахин шалгаж PAID болгоно (шалгалт ба цуцлалтын завсар төлсөн)', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      const original = env.qpay.checkInvoice.bind(env.qpay);
      const spy = vi.spyOn(env.qpay, 'checkInvoice').mockImplementationOnce(async (ref) => {
        const unpaid = await original(ref); // шалгалт: төлөгдөөгүй
        env.qpay.simulatePayment(db.providerInvoiceId as string); // шалгалтын дараа, цуцлахын өмнө төлөгдөв
        return unpaid;
      });
      try {
        env.t.clock.advanceMs(61 * 60_000);
        const res = await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer());
        expect(res.body.status).toBe('PAID');
        expect(await env.t.prisma.payment.count()).toBe(1);
      } finally { spy.mockRestore(); }
    });

    it('банкны шилжүүлгийн invoice: хугацаа дуусвал EXPIRED (провайдерт дуудахгүй)', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'BANK_TRANSFER' })).body;
      env.t.clock.advanceMs(61 * 60_000);
      expect((await env.http().get(`/api/payments/invoices/${inv.id}`).set(actors.officer())).body.status).toBe('EXPIRED');
    });

    it('өөр байгууллагын invoice → 404', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const res = await env.http().get(`/api/payments/invoices/${inv.id}`).set({ ...actors.admin(), 'x-org-id': 'other-org' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST payments/invoices/:id/cancel', () => {
    const cancel = (headers: Record<string, string>, id: string) => env.http().post(`/api/payments/invoices/${id}/cancel`).set(headers);

    it('PENDING → CANCELLED, провайдерт цуцлагдсан; дахин цуцлах idempotent', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      const res = await cancel(actors.officer(), inv.id);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(env.qpay.statusOf(db.providerInvoiceId as string)).toBe('CANCELLED');
      expect((await cancel(actors.officer(), inv.id)).body.status).toBe('CANCELLED');
    });

    it('банкны invoice-ийг цуцална (провайдергүй)', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'BANK_TRANSFER' })).body;
      expect((await cancel(actors.officer(), inv.id)).body.status).toBe('CANCELLED');
    });

    it('эрх: өөр ЗЭЗ 403, батлагч 403, нэвтрээгүй 401, үл мэдэгдэх 404, CUSTOMER өөрийн OK', async () => {
      const { app, customer } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      expect((await cancel(actors.officer('officer-2'), inv.id)).status).toBe(403);
      expect((await cancel(actors.approver(), inv.id)).status).toBe(403);
      expect((await cancel(actors.anonymous(), inv.id)).status).toBe(401);
      expect((await cancel(actors.admin(), 'missing')).status).toBe(404);
      expect((await cancel(actors.customer(customer.id), inv.id)).status).toBe(200);
    });

    it('төлөгдсөн → 409 INVOICE_ALREADY_PAID; хугацаа дууссан → 409 INVOICE_NOT_PENDING', async () => {
      const { app } = await seedLoan(env);
      const paid = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 5000 })).body;
      const dbPaid = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: paid.id } });
      env.qpay.simulatePayment(dbPaid.providerInvoiceId as string);
      await env.http().get(`/api/payments/invoices/${paid.id}`).set(actors.officer());
      const r1 = await cancel(actors.officer(), paid.id);
      expect(r1.status).toBe(409);
      expect(r1.body.code).toBe('INVOICE_ALREADY_PAID');

      const expired = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 6000 })).body;
      env.t.clock.advanceMs(61 * 60_000);
      await env.http().get(`/api/payments/invoices/${expired.id}`).set(actors.officer());
      const r2 = await cancel(actors.officer(), expired.id);
      expect(r2.status).toBe(409);
      expect(r2.body.code).toBe('INVOICE_NOT_PENDING');
    });

    it('callback хараахан ирээгүй ч провайдерт төлөгдсөн бол цуцлахгүй, төлбөрийг бүртгэж 409', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY', amount: 7000 })).body;
      const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } });
      env.qpay.simulatePayment(db.providerInvoiceId as string);
      const res = await cancel(actors.officer(), inv.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVOICE_ALREADY_PAID');
      expect(await env.t.prisma.payment.count()).toBe(1);
      expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID');
    });

    it('провайдер унтарсан үед → 502, invoice PENDING хэвээр', async () => {
      const { app } = await seedLoan(env);
      const inv = (await create(actors.officer(), { applicationId: app.id, provider: 'QPAY' })).body;
      env.qpay.failNext({ method: 'cancelInvoice' });
      const res = await cancel(actors.officer(), inv.id);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
      expect((await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PENDING');
    });
  });

  describe('GET payments/providers', () => {
    it('нэвтэрсэн бүх хэрэглэгчид; mock горимд 3-уулаа идэвхтэй', async () => {
      const res = await env.http().get('/api/payments/providers').set(actors.officer());
      expect(res.status).toBe(200);
      const infos = (res.body as unknown[]).map((i) => PaymentProviderInfo.parse(i));
      expect(infos.map((i) => i.provider)).toEqual(['QPAY', 'SOCIALPAY', 'BANK_TRANSFER']);
      expect(infos.every((i) => i.enabled && i.mode === 'mock' && i.reason === null)).toBe(true);
      expect((await env.http().get('/api/payments/providers').set(actors.anonymous())).status).toBe(401);
      expect((await env.http().get('/api/payments/providers').set(actors.customer('c1'))).status).toBe(200);
    });
  });
});
