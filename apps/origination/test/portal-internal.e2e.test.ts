import 'reflect-metadata';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  PortalContractInfo, PortalCustomerLookup, PortalLoanBalance, PortalLoanDetail, PortalLoanSummary, PortalPayment, PortalPaymentList,
  PortalPaymentMethodLimit, PortalProfile, PortalSchedule, type RequestContext,
} from '@los/contracts';
import { MockSmsGateway } from '../src/integrations/sms/sms.mock';
import { SMS_GATEWAY } from '../src/integrations/sms/sms.provider';
import { Clock } from '@los/nest-common';
import { InvoiceService } from '../src/modules/payment/invoice.service';
import { PaymentService } from '../src/modules/payment/payment.service';
import { ProviderRegistry } from '../src/modules/payment/provider-registry';
import { PortalLoansService } from '../src/modules/portal/portal-loans.service';
import { PortalPaymentsService } from '../src/modules/portal/portal-payments.service';
import { PortalHttpError } from '../src/modules/portal/portal-errors';
import { PrismaService } from '../src/prisma.service';
import { ApplicationAccessService } from '../src/shared/application-access.service';
import { OrgSettings } from '../src/shared/org-settings';
import { PORTAL_CONTRACT_FILES, type PortalContractFilesPort } from '../src/modules/portal/portal-contract.service';
import { PortalModule } from '../src/modules/portal/portal.module';
import { ORG, actors, createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, resetDb } from '../src/test-utils/factories';
import { createTestApp, type TestApp } from '../src/test-utils/test-app';

/**
 * H8: origination `/api/internal/portal/*` — portal-bff-ийн real adapter-уудын (apps/portal-bff/src/integrations/*\/real-*.ts) гэрээ.
 * Хариу бүрийг portal-bff-ийн ашигладаг ЯГ ТЭР `@los/contracts` zod схемээр parse хийнэ (гэрээний тест), алдааны бие `{error:{code}}`.
 * Тест цаг 2026-10-28 (UB 10:00); анхдагч ЭТХ firstDue 2026-09-28 → мөр 1 хугацаа хэтэрсэн 30 хоног, мөр 2 өнөөдөр.
 */
const P = '/api/internal/portal';
const REGISTER = 'УБ90010112';
const PHONE = '99112233';
const PDF = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

const cust = (id: string) => ({ 'x-actor-type': 'CUSTOMER', 'x-customer-id': id, 'x-roles': 'CUSTOMER', 'x-correlation-id': 'corr-portal-test' });
const anon = { 'x-actor-type': 'PORTAL_ANONYMOUS', 'x-correlation-id': 'corr-portal-anon' };

class FakeContractFiles implements PortalContractFilesPort {
  calls: Array<{ ctx: RequestContext; fileId: string }> = [];
  body: Buffer = PDF;
  async fetchPdf(ctx: RequestContext, fileId: string): Promise<Buffer> {
    this.calls.push({ ctx, fileId });
    return this.body;
  }
}

describe.skipIf(!hasTestDb)('origination portal internal API (H8)', () => {
  let t: TestApp;
  const sms = new MockSmsGateway();
  const files = new FakeContractFiles();
  const http = () => request(t.app.getHttpServer());
  const prevOrg = process.env.DEFAULT_ORG_ID;

  beforeAll(async () => {
    process.env.DEFAULT_ORG_ID = ORG;
    process.env.PAYMENT_MAINTENANCE = 'off';
    t = await createTestApp([PortalModule], (b) => b.overrideProvider(SMS_GATEWAY).useValue(sms).overrideProvider(PORTAL_CONTRACT_FILES).useValue(files));
  });
  afterAll(async () => {
    await t?.close();
    process.env.DEFAULT_ORG_ID = prevOrg;
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    t.clock.set('2026-10-28T02:00:00Z');
    sms.reset();
    files.calls = [];
    files.body = PDF;
  });

  async function seedLoan(o: { customerId?: string; status?: string; role?: 'PRIMARY' | 'CO_BORROWER' | 'GUARANTOR'; firstDue?: string; contractNo?: string; currency?: string } = {}) {
    const customer = o.customerId ? await t.prisma.customer.findUniqueOrThrow({ where: { id: o.customerId } }) : await createCustomer(t.prisma);
    const app = await createApplication(t.prisma, {
      status: o.status ?? 'ACTIVE', currency: o.currency ?? 'MNT', amount: 1_200_000, interestRate: 24, termMonths: 12, contractNo: o.contractNo ?? `C-${Math.random().toString(36).slice(2, 10)}`,
      disbursedAt: new Date('2026-08-29T03:00:00Z'),
    });
    await createBorrower(t.prisma, app.id, customer.id, o.role ?? 'PRIMARY');
    const schedule = await createSchedule(t.prisma, app.id, { firstDue: o.firstDue ?? '2026-09-28', principal: 1_200_000, months: 12 });
    return { customer, app, rows: schedule.rows };
  }

  const pay = (customerId: string, loanId: string, body: Record<string, unknown>, key = 'idem-key-0001') =>
    http().post(`${P}/loans/${loanId}/payments`).set(cust(customerId)).set('Idempotency-Key', key).send({ loanId, currency: 'MNT', ...body });

  async function balanceOf(customerId: string, loanId: string) {
    const res = await http().get(`${P}/loans/${loanId}/balance`).set(cust(customerId));
    return PortalLoanBalance.parse(res.body);
  }

  // ───────────── Нэвтрэлт / эрх ─────────────
  describe('authorization', () => {
    it('rejects requests without a portal actor (401, portal error body)', async () => {
      const res = await http().get(`${P}/loans`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
    });

    it('refuses staff context — even ADMIN — on every route', async () => {
      const { customer, app } = await seedLoan();
      for (const [method, path] of [['get', `${P}/loans`], ['get', `${P}/loans/${app.id}`], ['post', `${P}/customers/lookup`], ['get', `${P}/customers/me`]] as const) {
        const res = await http()[method](path).set({ ...actors.admin(), 'x-actor-type': 'CUSTOMER', 'x-customer-id': customer.id });
        expect(res.status, path).toBe(403);
        expect(res.body.error.code).toBe('STAFF_CONTEXT_REFUSED');
      }
    });

    it('requires X-Internal-Token when INTERNAL_AUTH_SECRET is configured', async () => {
      const { customer } = await seedLoan();
      const secret = 'portal-test-secret-0123456789';
      process.env.INTERNAL_AUTH_SECRET = secret;
      try {
        expect((await http().get(`${P}/loans`).set(cust(customer.id))).status).toBe(401);
        expect((await http().get(`${P}/loans`).set(cust(customer.id)).set('x-internal-token', 'nope')).status).toBe(401);
        expect((await http().get(`${P}/loans`).set(cust(customer.id)).set('x-internal-token', secret)).status).toBe(200);
      } finally {
        process.env.INTERNAL_AUTH_SECRET = '';
      }
    });
  });

  // ───────────── PRT-FR-1: lookup, me, otp ─────────────
  describe('customers', () => {
    it('lookup: register + registered phone → {customerId, displayName}, no PII', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE, lastName: 'Батболд', firstName: 'Болд' });
      await seedLoan({ customerId: c.id });
      const res = await http().post(`${P}/customers/lookup`).set(anon).send({ registerNo: REGISTER, phone: PHONE });
      expect(res.status).toBe(200);
      expect(PortalCustomerLookup.parse(res.body)).toEqual({ customerId: c.id, displayName: 'Б. Болд' });
      expect(JSON.stringify(res.body)).not.toContain(REGISTER);
      expect(JSON.stringify(res.body)).not.toContain('Батболд');
    });

    it('lookup normalises register case and phone format (+976, spaces)', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: '9911-2233' });
      await seedLoan({ customerId: c.id });
      const res = await http().post(`${P}/customers/lookup`).set(anon).send({ registerNo: 'уб90010112', phone: '+976 9911 2233' });
      expect(res.status).toBe(200);
      expect(res.body.customerId).toBe(c.id);
    });

    it('lookup is enumeration-safe: wrong phone, unknown register, no eligible loan → identical 404', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE });
      await seedLoan({ customerId: c.id });
      const noLoan = await createCustomer(t.prisma, { registerNo: 'УА85050505', phone: '88112233' });
      await seedLoan({ customerId: noLoan.id, status: 'DRAFT' });
      const guarantor = await createCustomer(t.prisma, { registerNo: 'ЧД77010101', phone: '95112233' });
      await seedLoan({ customerId: guarantor.id, role: 'GUARANTOR' });
      const bodies = [];
      for (const body of [
        { registerNo: REGISTER, phone: '88112233' },
        { registerNo: 'ЖЖ00000000', phone: PHONE },
        { registerNo: 'УА85050505', phone: '88112233' },
        { registerNo: 'ЧД77010101', phone: '95112233' },
      ]) {
        const res = await http().post(`${P}/customers/lookup`).set(anon).send(body);
        expect(res.status).toBe(404);
        bodies.push(res.body);
      }
      expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
      expect(bodies[0]).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    });

    it('lookup accepts CLOSED and MIGRATED loans', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE });
      await seedLoan({ customerId: c.id, status: 'CLOSED' });
      expect((await http().post(`${P}/customers/lookup`).set(anon).send({ registerNo: REGISTER, phone: PHONE })).status).toBe(200);
    });

    it('lookup rejects a malformed body (400) and a CUSTOMER actor (401)', async () => {
      expect((await http().post(`${P}/customers/lookup`).set(anon).send({ registerNo: REGISTER })).status).toBe(400);
      expect((await http().post(`${P}/customers/lookup`).set(anon).send({ registerNo: REGISTER, phone: PHONE, extra: 1 })).status).toBe(400);
      expect((await http().post(`${P}/customers/lookup`).set(cust('cust-1')).send({ registerNo: REGISTER, phone: PHONE })).status).toBe(401);
    });

    it('me: shortened name + masked phone', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE, lastName: 'Сүх', firstName: 'Сараа' });
      const res = await http().get(`${P}/customers/me`).set(cust(c.id));
      expect(res.status).toBe(200);
      expect(PortalProfile.parse(res.body)).toEqual({ displayName: 'С. Сараа', phoneMasked: '99****33' });
      expect(JSON.stringify(res.body)).not.toContain(PHONE);
    });

    it('me: unknown customer → 404', async () => {
      expect((await http().get(`${P}/customers/me`).set(cust('11111111-1111-1111-1111-111111111111'))).status).toBe(404);
    });

    it('otp: sends the code to the REGISTERED phone only, 202 {}', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE });
      await seedLoan({ customerId: c.id });
      const res = await http().post(`${P}/otp`).set(cust(c.id)).send({ code: '482913', ttlSec: 300 });
      expect(res.status).toBe(202);
      expect(z.object({}).passthrough().parse(res.body)).toEqual({});
      expect(sms.outbox).toHaveLength(1);
      expect(sms.outbox[0].to).toBe('+97699112233');
      expect(sms.outbox[0].text).toContain('482913');
    });

    it('otp: invalid body → 400; anonymous actor → 401; unknown customer / no eligible loan → 404; nothing sent', async () => {
      const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE });
      expect((await http().post(`${P}/otp`).set(cust(c.id)).send({ code: '123456', ttlSec: 300 })).status).toBe(404); // зээлгүй
      await seedLoan({ customerId: c.id });
      expect((await http().post(`${P}/otp`).set(cust(c.id)).send({ code: '12', ttlSec: 300 })).status).toBe(400);
      expect((await http().post(`${P}/otp`).set(anon).send({ code: '123456', ttlSec: 300 })).status).toBe(401);
      expect((await http().post(`${P}/otp`).set(cust('11111111-1111-1111-1111-111111111111')).send({ code: '123456', ttlSec: 300 })).status).toBe(404);
      expect(sms.outbox).toHaveLength(0);
    });
  });

  // ───────────── PRT-FR-2, 3: зээл, үлдэгдэл, ЭТХ ─────────────
  describe('loans', () => {
    it('lists only own PRIMARY loans in ACTIVE/CLOSED/MIGRATED (MIGRATED → ACTIVE)', async () => {
      const { customer, app: active } = await seedLoan();
      const { app: closed } = await seedLoan({ customerId: customer.id, status: 'CLOSED' });
      const { app: migrated } = await seedLoan({ customerId: customer.id, status: 'MIGRATED' });
      await seedLoan({ customerId: customer.id, status: 'DRAFT' });
      await seedLoan({ customerId: customer.id, status: 'APPROVED' });
      await seedLoan({ customerId: customer.id, role: 'CO_BORROWER' });
      await seedLoan(); // өөр харилцагч
      const res = await http().get(`${P}/loans`).set(cust(customer.id));
      expect(res.status).toBe(200);
      const loans = z.array(PortalLoanSummary).parse(res.body);
      expect(new Map(loans.map((l) => [l.loanId, l.status]))).toEqual(new Map([[active.id, 'ACTIVE'], [closed.id, 'CLOSED'], [migrated.id, 'ACTIVE']]));
    });

    it('summary/detail values come from the schedule + allocations', async () => {
      const { customer, app, rows } = await seedLoan();
      const res = await http().get(`${P}/loans/${app.id}`).set(cust(customer.id));
      expect(res.status).toBe(200);
      const d = PortalLoanDetail.parse(res.body);
      expect(d).toMatchObject({
        loanId: app.id, contractNo: app.contractNo, currency: 'MNT', status: 'ACTIVE', principalAmount: 1_200_000, annualInterestRatePercent: 24, termMonths: 12,
        disbursedAt: '2026-08-29', maturityDate: rows[11].dueDate.toISOString().slice(0, 10), outstandingPrincipal: 1_200_000,
        overdueAmount: Number(rows[0].total), overdueDays: 30, firstPaymentDate: '2026-09-28', contractAvailable: false,
      });
      expect(d.nextInstallment).toMatchObject({ seq: 1, dueDate: '2026-09-28', amountDue: Number(rows[0].total) });
    });

    it('balance and schedule parse and reflect a recorded payment', async () => {
      const { customer, app, rows } = await seedLoan();
      await t.app.get(PaymentService).recordPayment({ orgId: ORG, userId: 'tester', correlationId: 'c' }, {
        applicationId: app.id, invoiceId: null, provider: 'BANK_TRANSFER', providerPaymentId: 'DIRECT-1', amount: Number(rows[0].total), currency: 'MNT', paidAt: t.clock.now(),
      });
      const b = await balanceOf(customer.id, app.id);
      expect(b.overdue).toEqual({ principal: 0, interest: 0, penalty: 0, total: 0, days: 0 });
      expect(b.nextInstallment?.seq).toBe(2);
      expect(b.payoff.validUntil).toBe('2026-10-28');
      const s = await http().get(`${P}/loans/${app.id}/schedule`).set(cust(customer.id));
      expect(s.status).toBe(200);
      const sched = PortalSchedule.parse(s.body);
      expect(sched.rows).toHaveLength(12);
      expect(sched.rows[0]).toMatchObject({ status: 'PAID', paidAmount: Number(rows[0].total), paidAt: '2026-10-28' });
      expect(sched.rows[1].status).toBe('DUE');
      expect(sched.rows[2].status).toBe('UPCOMING');
    });

    it('IDOR: another customer gets 404 LOAN_NOT_FOUND on every loan route', async () => {
      const { app } = await seedLoan();
      const intruder = await createCustomer(t.prisma);
      for (const suffix of ['', '/balance', '/schedule', '/payment-methods', '/payments?limit=5']) {
        const res = await http().get(`${P}/loans/${app.id}${suffix}`).set(cust(intruder.id));
        expect(res.status, suffix).toBe(404);
        expect(res.body.error.code, suffix).toBe('LOAN_NOT_FOUND');
      }
      for (const suffix of ['/contract', '/contract/content']) {
        const res = await http().get(`${P}/loans/${app.id}${suffix}`).set(cust(intruder.id));
        expect(res.status, suffix).toBe(404);
      }
      const p = await pay(intruder.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 });
      expect(p.status).toBe(404);
      expect(await t.prisma.paymentInvoice.count()).toBe(0);
      expect(files.calls).toHaveLength(0);
    });

    it('IDOR: co-borrower / guarantor cannot open the loan; own DRAFT and unknown ids are 404', async () => {
      const { app } = await seedLoan();
      const co = await createCustomer(t.prisma);
      await createBorrower(t.prisma, app.id, co.id, 'GUARANTOR');
      expect((await http().get(`${P}/loans/${app.id}`).set(cust(co.id))).status).toBe(404);
      const { customer, app: draft } = await seedLoan({ status: 'DRAFT' });
      expect((await http().get(`${P}/loans/${draft.id}`).set(cust(customer.id))).status).toBe(404);
      expect((await http().get(`${P}/loans/does-not-exist`).set(cust(customer.id))).status).toBe(404);
    });

    it('IDOR: same customer id in another org sees nothing', async () => {
      const { customer, app } = await seedLoan();
      const res = await http().get(`${P}/loans/${app.id}`).set({ ...cust(customer.id), 'x-org-id': 'other-org' });
      expect(res.status).toBe(404);
    });

    it('rejects malformed loan ids (400) before touching the DB', async () => {
      const { customer } = await seedLoan();
      expect((await http().get(`${P}/loans/${'x'.repeat(65)}`).set(cust(customer.id))).status).toBe(400);
    });
  });

  // ───────────── PRT-FR-4: гэрээ ─────────────
  describe('contract', () => {
    it('no contract / no file → 404 CONTRACT_NOT_AVAILABLE', async () => {
      const { customer, app } = await seedLoan();
      const res = await http().get(`${P}/loans/${app.id}/contract`).set(cust(customer.id));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('CONTRACT_NOT_AVAILABLE');
      await t.prisma.contract.create({ data: { orgId: ORG, applicationId: app.id, contractNo: app.contractNo! } });
      expect((await http().get(`${P}/loans/${app.id}/contract/content`).set(cust(customer.id))).status).toBe(404);
    });

    it('generated contract → signed=false; signed file is preferred and streamed as application/pdf', async () => {
      const { customer, app } = await seedLoan();
      const generated = '00000000-0000-4000-8000-000000000001';
      const signed = '00000000-0000-4000-8000-000000000002';
      await t.prisma.contract.create({ data: { orgId: ORG, applicationId: app.id, contractNo: app.contractNo!, generatedFileId: generated } });
      const info = PortalContractInfo.parse((await http().get(`${P}/loans/${app.id}/contract`).set(cust(customer.id))).body);
      expect(info).toMatchObject({ loanId: app.id, contractNo: app.contractNo, signed: false, signedAt: null, mime: 'application/pdf' });
      expect((await http().get(`${P}/loans/${app.id}`).set(cust(customer.id))).body.contractAvailable).toBe(true);

      await t.prisma.contract.update({ where: { applicationId: app.id }, data: { signedFileId: signed, signedAt: new Date('2026-09-01T04:00:00Z') } });
      const info2 = PortalContractInfo.parse((await http().get(`${P}/loans/${app.id}/contract`).set(cust(customer.id))).body);
      expect(info2).toMatchObject({ signed: true, signedAt: '2026-09-01T04:00:00.000Z' });

      const res = await http().get(`${P}/loans/${app.id}/contract/content`).set(cust(customer.id)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(Number(res.headers['content-length'])).toBe(PDF.length);
      expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
      expect(files.calls).toEqual([{ fileId: signed, ctx: expect.objectContaining({ customerId: customer.id, userId: null }) }]);
    });

    it('dms returns something that is not a PDF → 502 JSON (never forwarded)', async () => {
      const { customer, app } = await seedLoan();
      await t.prisma.contract.create({ data: { orgId: ORG, applicationId: app.id, contractNo: app.contractNo!, generatedFileId: '00000000-0000-4000-8000-000000000003' } });
      files.body = Buffer.from('<html>login</html>');
      const res = await http().get(`${P}/loans/${app.id}/contract/content`).set(cust(customer.id));
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('DOWNSTREAM_INVALID_RESPONSE');
    });
  });

  // ───────────── PRT-FR-5: төлбөр ─────────────
  describe('payments', () => {
    it('payment-methods: enabled providers (mock: all) with min/max from settings; QPay/SocialPay only for MNT loans', async () => {
      const { customer, app } = await seedLoan();
      const res = await http().get(`${P}/loans/${app.id}/payment-methods`).set(cust(customer.id));
      expect(res.status).toBe(200);
      const methods = z.array(PortalPaymentMethodLimit).parse(res.body);
      expect(methods.map((m) => m.method).sort()).toEqual(['BANK_ACCOUNT', 'QPAY', 'SOCIALPAY']);
      const usd = await seedLoan({ customerId: customer.id, currency: 'USD' });
      const usdMethods = z.array(PortalPaymentMethodLimit).parse((await http().get(`${P}/loans/${usd.app.id}/payment-methods`).set(cust(customer.id))).body);
      expect(usdMethods.map((m) => m.method)).toEqual(['BANK_ACCOUNT']);
      for (const m of methods) expect(m.minAmount).toBe(1000);
      for (const m of methods) expect(m.maxAmount).toBeGreaterThan(m.minAmount);
    });

    it('INSTALLMENT: server-determined amount → 201 PENDING with checkout; replay returns the same payment', async () => {
      const { customer, app, rows } = await seedLoan();
      const amount = (await balanceOf(customer.id, app.id)).nextInstallment!.amountDue;
      expect(amount).toBe(Number(rows[0].total));
      const res = await pay(customer.id, app.id, { method: 'QPAY', amountType: 'INSTALLMENT', amount });
      expect(res.status).toBe(201);
      const p = PortalPayment.parse(res.body);
      expect(p).toMatchObject({ loanId: app.id, method: 'QPAY', amountType: 'INSTALLMENT', amount, currency: 'MNT', status: 'PENDING', paidAt: null, postedAt: null });
      expect(p.checkout?.qrText).toBeTruthy();

      const replay = await pay(customer.id, app.id, { method: 'QPAY', amountType: 'INSTALLMENT', amount });
      expect(replay.status).toBe(201);
      expect(replay.body.paymentId).toBe(p.paymentId);
      expect(await t.prisma.paymentInvoice.count()).toBe(1);
    });

    it('same Idempotency-Key with a different body → 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const { customer, app } = await seedLoan();
      expect((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 })).status).toBe(201);
      const res = await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 6000 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('Idempotency-Key is customer-scoped: another customer reusing the key gets their own payment', async () => {
      const a = await seedLoan();
      const b = await seedLoan();
      const pa = await pay(a.customer.id, a.app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 }, 'shared-key-123');
      const pb = await pay(b.customer.id, b.app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 }, 'shared-key-123');
      expect(pa.status).toBe(201);
      expect(pb.status).toBe(201);
      expect(pb.body.paymentId).not.toBe(pa.body.paymentId);
    });

    it('validation: missing key, loanId mismatch, wrong currency, bad body → 400', async () => {
      const { customer, app } = await seedLoan();
      const noKey = await http().post(`${P}/loans/${app.id}/payments`).set(cust(customer.id)).send({ loanId: app.id, method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'MNT' });
      expect(noKey.status).toBe(400);
      expect((await pay(customer.id, app.id, { loanId: 'other-loan', method: 'QPAY', amountType: 'CUSTOM', amount: 5000 })).status).toBe(400);
      expect((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'USD' })).status).toBe(400);
      expect((await pay(customer.id, app.id, { method: 'CASH', amountType: 'CUSTOM', amount: 5000 })).status).toBe(400);
      expect((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 50.001 })).status).toBe(400);
      expect(await t.prisma.paymentInvoice.count()).toBe(0);
    });

    it('server-determined types reject a client amount that differs (422 AMOUNT_OUT_OF_RANGE)', async () => {
      const { customer, app } = await seedLoan();
      const b = await balanceOf(customer.id, app.id);
      for (const [amountType, amount] of [['INSTALLMENT', b.nextInstallment!.amountDue - 1], ['OVERDUE', b.overdue.total + 1], ['PAYOFF', b.payoff.amount - 1]] as const) {
        const res = await pay(customer.id, app.id, { method: 'QPAY', amountType, amount }, `key-${amountType}`);
        expect(res.status, amountType).toBe(422);
        expect(res.body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
      }
    });

    it('CUSTOM above payoff or above the method max → 422; OVERDUE with nothing overdue → 409 NO_OVERDUE', async () => {
      const { customer, app } = await seedLoan({ firstDue: '2026-11-15' });
      const b = await balanceOf(customer.id, app.id);
      expect((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: b.payoff.amount + 1 }, 'k1')).body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
      await t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key: 'portal.payment_max_amount' } }, create: { orgId: ORG, key: 'portal.payment_max_amount', valueJson: 10_000 }, update: { valueJson: 10_000 } });
      expect((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 10_001 }, 'k2')).body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
      const od = await pay(customer.id, app.id, { method: 'QPAY', amountType: 'OVERDUE', amount: 1 }, 'k3');
      expect(od.status).toBe(409);
      expect(od.body.error.code).toBe('NO_OVERDUE');
    });

    it('PAYOFF ignores the method minimum (PRT-FR-5.2) while CUSTOM below it is rejected', async () => {
      const { customer, app } = await seedLoan();
      await t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key: 'payment.min_amount' } }, create: { orgId: ORG, key: 'payment.min_amount', valueJson: 5_000_000 }, update: { valueJson: 5_000_000 } });
      const b = await balanceOf(customer.id, app.id);
      expect((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 4000 }, 'k1')).status).toBe(422);
      const res = await pay(customer.id, app.id, { method: 'QPAY', amountType: 'PAYOFF', amount: b.payoff.amount }, 'k2');
      expect(res.status).toBe(201);
      expect(res.body.amount).toBe(b.payoff.amount);
    });

    it('CLOSED loan → 409 LOAN_NOT_PAYABLE; method unavailable for the loan currency → 422 METHOD_NOT_AVAILABLE', async () => {
      const { customer, app } = await seedLoan({ status: 'CLOSED' });
      const res = await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LOAN_NOT_PAYABLE');
      const usd = await seedLoan({ customerId: customer.id, currency: 'USD' });
      const qpayUsd = await pay(customer.id, usd.app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'USD' }, 'k-usd');
      expect(qpayUsd.status).toBe(422);
      expect(qpayUsd.body.error.code).toBe('METHOD_NOT_AVAILABLE');
      expect(await t.prisma.paymentInvoice.count()).toBe(0);
    });

    it('GET /payments/:id: own payment (PAID after recording, postedAt set); other customer → 404 PAYMENT_NOT_FOUND', async () => {
      const { customer, app } = await seedLoan();
      const created = PortalPayment.parse((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 })).body);
      await t.app.get(PaymentService).recordPayment({ orgId: ORG, userId: null, correlationId: 'c' }, {
        applicationId: app.id, invoiceId: created.paymentId, provider: 'QPAY', providerPaymentId: 'QP-1', amount: 5000, currency: 'MNT', paidAt: t.clock.now(),
      });
      const res = await http().get(`${P}/payments/${created.paymentId}`).set(cust(customer.id));
      expect(res.status).toBe(200);
      const p = PortalPayment.parse(res.body);
      expect(p).toMatchObject({ paymentId: created.paymentId, status: 'PAID', checkout: null });
      expect(p.paidAt).not.toBeNull();
      expect(p.postedAt).not.toBeNull();

      const intruder = await createCustomer(t.prisma);
      const other = await http().get(`${P}/payments/${created.paymentId}`).set(cust(intruder.id));
      expect(other.status).toBe(404);
      expect(other.body.error.code).toBe('PAYMENT_NOT_FOUND');
      expect((await http().get(`${P}/payments/nope`).set(cust(customer.id))).status).toBe(404);
    });

    describe('idempotency across origination instances (DB unique key, not in-process single-flight)', () => {
      /** Тусдаа pod-ыг дуурайна: өөрийн inflight map-тай InvoiceService + PortalPaymentsService, нэг DB ба провайдер. */
      const pod = () => {
        const g = <T>(c: abstract new (...a: never[]) => T) => t.app.get(c as never) as T;
        const invoices = new InvoiceService(g(PrismaService), g(ApplicationAccessService), g(OrgSettings), g(Clock), g(ProviderRegistry), g(PaymentService));
        return new PortalPaymentsService(g(PrismaService), g(PortalLoansService), invoices, g(ProviderRegistry), g(OrgSettings));
      };
      const ctxOf = (customerId: string): RequestContext => ({ userId: null, roles: ['CUSTOMER'], branchId: null, orgId: ORG, customerId, correlationId: 'corr-pods' });
      const codeOf = (e: unknown) => (e instanceof PortalHttpError ? (e.getResponse() as { error: { code: string } }).error.code : String(e));
      afterEach(() => vi.restoreAllMocks());

      it('N parallel same-key requests on different pods → exactly one invoice and one provider call', async () => {
        const { customer, app } = await seedLoan();
        const spy = vi.spyOn(t.app.get(ProviderRegistry).port('QPAY'), 'createInvoice');
        const body = { loanId: app.id, method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'MNT' };
        const results = await Promise.allSettled(Array.from({ length: 6 }, () => pod().create(ctxOf(customer.id), app.id, body, 'pod-key-0001')));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await t.prisma.paymentInvoice.count()).toBe(1);
        const ok = results.filter((r): r is PromiseFulfilledResult<PortalPayment> => r.status === 'fulfilled');
        expect(ok.length).toBeGreaterThan(0);
        expect(new Set(ok.map((r) => r.value.paymentId)).size).toBe(1);
        for (const r of results) if (r.status === 'rejected') expect(codeOf(r.reason)).toBe('REQUEST_IN_PROGRESS');
        // replay after settling: the winner from any pod
        expect((await pod().create(ctxOf(customer.id), app.id, body, 'pod-key-0001')).paymentId).toBe(ok[0]!.value.paymentId);
        await expect(pod().create(ctxOf(customer.id), app.id, { ...body, amount: 6000 }, 'pod-key-0001')).rejects.toSatisfy((e) => codeOf(e) === 'IDEMPOTENCY_KEY_REUSED');
      });

      it('while the winner waits on the provider, another pod gets 409 REQUEST_IN_PROGRESS (no second provider call)', async () => {
        const { customer, app } = await seedLoan();
        const port = t.app.get(ProviderRegistry).port('QPAY');
        const real = port.createInvoice.bind(port);
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const spy = vi.spyOn(port, 'createInvoice').mockImplementation(async (req) => { await gate; return real(req); });
        const body = { loanId: app.id, method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'MNT' };
        const first = pod().create(ctxOf(customer.id), app.id, body, 'slow-key-01');
        await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
        await expect(pod().create(ctxOf(customer.id), app.id, body, 'slow-key-01')).rejects.toSatisfy((e) => codeOf(e) === 'REQUEST_IN_PROGRESS');
        release();
        const won = await first;
        expect((await pod().create(ctxOf(customer.id), app.id, body, 'slow-key-01')).paymentId).toBe(won.paymentId);
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('provider failure releases the key: a retry with the same key creates the payment', async () => {
        const { customer, app } = await seedLoan();
        const port = t.app.get(ProviderRegistry).port('QPAY');
        vi.spyOn(port, 'createInvoice').mockRejectedValueOnce(new Error('qpay down'));
        const body = { loanId: app.id, method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'MNT' };
        await expect(pod().create(ctxOf(customer.id), app.id, body, 'fail-key-01')).rejects.toBeDefined();
        expect(await t.prisma.paymentInvoice.count()).toBe(0);
        const p = await pod().create(ctxOf(customer.id), app.id, body, 'fail-key-01');
        expect(p.status).toBe('PENDING');
        expect(await t.prisma.paymentInvoice.count()).toBe(1);
      });

      it('a different key for the same amount is a new payment (no silent reuse of another key\'s invoice); the free-text note is not the key', async () => {
        const { customer, app } = await seedLoan();
        const body = { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 };
        const a = (await pay(customer.id, app.id, body, 'key-aaaa-01')).body.paymentId;
        await t.prisma.paymentInvoice.updateMany({ data: { note: null } });
        expect((await pay(customer.id, app.id, body, 'key-aaaa-01')).body.paymentId).toBe(a);
        const b = await pay(customer.id, app.id, body, 'key-bbbb-01');
        expect(b.status).toBe(201);
        expect(b.body.paymentId).not.toBe(a);
        const rows = await t.prisma.paymentInvoice.findMany({ select: { portalIdempotencyKey: true } });
        expect(rows.every((r) => /^[0-9a-f]{32}$/.test(r.portalIdempotencyKey ?? ''))).toBe(true);
      });
    });

    it('portal max amount is per currency: MNT setting does not cap USD loans; portal.payment_max_amount_usd does', async () => {
      const { customer } = await seedLoan();
      const usd = await seedLoan({ customerId: customer.id, currency: 'USD' });
      const setSetting = (key: string, valueJson: number) => t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key } }, create: { orgId: ORG, key, valueJson }, update: { valueJson } });
      await setSetting('portal.payment_max_amount', 10_000);
      const ok = await pay(customer.id, usd.app.id, { method: 'BANK_ACCOUNT', amountType: 'CUSTOM', amount: 20_000, currency: 'USD' }, 'usd-k1');
      expect(ok.status).toBe(201);
      expect(ok.body.currency).toBe('USD');
      await setSetting('portal.payment_max_amount_usd', 15_000);
      const over = await pay(customer.id, usd.app.id, { method: 'BANK_ACCOUNT', amountType: 'CUSTOM', amount: 20_001, currency: 'USD' }, 'usd-k2');
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe('AMOUNT_OUT_OF_RANGE');
      const methods = z.array(PortalPaymentMethodLimit).parse((await http().get(`${P}/loans/${usd.app.id}/payment-methods`).set(cust(customer.id))).body);
      expect(methods.map((m) => m.maxAmount)).toEqual([15_000]);
    });

    it('history: newest first, cursor pagination, unknown cursor → 400 INVALID_REQUEST', async () => {
      const { customer, app } = await seedLoan();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        t.clock.advanceMs(60_000);
        ids.push((await pay(customer.id, app.id, { method: 'QPAY', amountType: 'CUSTOM', amount: 5000 + i }, `hist-key-${i}`)).body.paymentId);
      }
      const page1 = PortalPaymentList.parse((await http().get(`${P}/loans/${app.id}/payments?limit=2`).set(cust(customer.id))).body);
      expect(page1.items.map((p) => p.paymentId)).toEqual([ids[2], ids[1]]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = PortalPaymentList.parse((await http().get(`${P}/loans/${app.id}/payments?limit=2&cursor=${page1.nextCursor}`).set(cust(customer.id))).body);
      expect(page2.items.map((p) => p.paymentId)).toEqual([ids[0]]);
      expect(page2.nextCursor).toBeNull();

      const bad = await http().get(`${P}/loans/${app.id}/payments?limit=2&cursor=bm90LWEtY3Vyc29y`).set(cust(customer.id));
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_REQUEST');
      expect((await http().get(`${P}/loans/${app.id}/payments?limit=51`).set(cust(customer.id))).status).toBe(400);
    });
  });

  it('PII: no loan/payment response contains the register number or full phone', async () => {
    const c = await createCustomer(t.prisma, { registerNo: REGISTER, phone: PHONE });
    const { app } = await seedLoan({ customerId: c.id });
    for (const path of [`${P}/loans`, `${P}/loans/${app.id}`, `${P}/loans/${app.id}/balance`, `${P}/loans/${app.id}/schedule`, `${P}/customers/me`]) {
      const text = JSON.stringify((await http().get(path).set(cust(c.id))).body);
      expect(text, path).not.toContain(REGISTER);
      expect(text, path).not.toContain(PHONE);
    }
  });
});
