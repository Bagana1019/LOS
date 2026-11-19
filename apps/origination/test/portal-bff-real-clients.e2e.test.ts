import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '@los/contracts';
// portal-bff-ийн ЖИНХЭНЭ real adapter-ууд (INTEGRATION_MODE=real) — гэрээний тест: тэдгээрийн header, zod шалгалт, алдааны map нь origination-тай таарна.
import { PortalError } from '../../portal-bff/src/common/portal-error';
import { RealContractFiles } from '../../portal-bff/src/integrations/contract-files/real-contract-files';
import { RealCustomerDirectory } from '../../portal-bff/src/integrations/customer-directory/real-customer-directory';
import { InternalHttpClient } from '../../portal-bff/src/integrations/internal-http.client';
import { RealLoanServicing } from '../../portal-bff/src/integrations/loan-servicing/real-loan-servicing';
import { RealOtpSender } from '../../portal-bff/src/integrations/otp-sender/real-otp-sender';
import { RealPaymentCollection } from '../../portal-bff/src/integrations/payment-collection/real-payment-collection';
import { MockSmsGateway } from '../src/integrations/sms/sms.mock';
import { SMS_GATEWAY } from '../src/integrations/sms/sms.provider';
import { PORTAL_CONTRACT_FILES, type PortalContractFilesPort } from '../src/modules/portal/portal-contract.service';
import { PortalModule } from '../src/modules/portal/portal.module';
import { ORG, createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, resetDb } from '../src/test-utils/factories';
import { createTestApp, type TestApp } from '../src/test-utils/test-app';

const SECRET = 'portal-contract-test-secret-0123456789';
const PDF = Buffer.from('%PDF-1.7\n%contract\n%%EOF');

class Files implements PortalContractFilesPort {
  async fetchPdf(_ctx: RequestContext, _fileId: string): Promise<Buffer> { return PDF; }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PortalError) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}

describe.skipIf(!hasTestDb)('portal-bff real adapters ↔ origination portal API (H8 contract)', () => {
  let t: TestApp;
  const sms = new MockSmsGateway();
  let baseUrl = '';
  let http: InternalHttpClient;
  const prev = { org: process.env.DEFAULT_ORG_ID, secret: process.env.INTERNAL_AUTH_SECRET };

  beforeAll(async () => {
    process.env.DEFAULT_ORG_ID = ORG;
    process.env.INTERNAL_AUTH_SECRET = SECRET;
    process.env.PAYMENT_MAINTENANCE = 'off';
    t = await createTestApp([PortalModule], (b) => b.overrideProvider(SMS_GATEWAY).useValue(sms).overrideProvider(PORTAL_CONTRACT_FILES).useValue(new Files()));
    await t.app.listen(0, '127.0.0.1');
    const { port } = t.app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    http = new InternalHttpClient({ baseUrl, timeoutMs: 3000, maxStreamBytes: 1024 * 1024, retryDelayMs: 1, internalToken: SECRET });
  });
  afterAll(async () => {
    await t?.close();
    process.env.DEFAULT_ORG_ID = prev.org;
    process.env.INTERNAL_AUTH_SECRET = prev.secret ?? '';
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    t.clock.set('2026-10-28T02:00:00Z');
    sms.reset();
  });

  async function seed() {
    const customer = await createCustomer(t.prisma, { registerNo: 'УБ90010112', phone: '99112233', lastName: 'Батболд', firstName: 'Болд' });
    const app = await createApplication(t.prisma, { status: 'ACTIVE', amount: 1_200_000, contractNo: 'C-PORTAL-1', disbursedAt: new Date('2026-08-29T03:00:00Z') });
    await createBorrower(t.prisma, app.id, customer.id, 'PRIMARY');
    await createSchedule(t.prisma, app.id, { firstDue: '2026-09-28', principal: 1_200_000, months: 12 });
    await t.prisma.contract.create({ data: { orgId: ORG, applicationId: app.id, contractNo: 'C-PORTAL-1', generatedFileId: '00000000-0000-4000-8000-0000000000aa' } });
    return { customer, app, ctx: { customerId: customer.id, correlationId: 'corr-contract-1' } };
  }

  it('customer directory + OTP sender', async () => {
    const { customer } = await seed();
    const dir = new RealCustomerDirectory(http);
    expect(await dir.lookupForLogin({ registerNo: 'УБ90010112', phone: '99112233' }, { correlationId: 'c1' })).toEqual({ customerId: customer.id, displayName: 'Б. Болд' });
    expect(await dir.lookupForLogin({ registerNo: 'УБ90010112', phone: '88112233' }, { correlationId: 'c2' })).toBeNull();
    expect(await dir.getProfile({ customerId: customer.id, correlationId: 'c3' })).toEqual({ displayName: 'Б. Болд', phoneMasked: '99****33' });
    await new RealOtpSender(http).send({ customerId: customer.id, code: '654321', ttlSec: 300 }, { correlationId: 'c4' });
    expect(sms.outbox.map((m) => m.to)).toEqual(['+97699112233']);
  });

  it('loan servicing: list, detail, balance, schedule', async () => {
    const { app, ctx } = await seed();
    const loans = new RealLoanServicing(http);
    expect((await loans.listLoans(ctx)).map((l) => l.loanId)).toEqual([app.id]);
    expect((await loans.getLoan(ctx, app.id)).contractAvailable).toBe(true);
    expect((await loans.getBalance(ctx, app.id)).overdue.days).toBe(30);
    expect((await loans.getSchedule(ctx, app.id)).rows).toHaveLength(12);
  });

  it('IDOR through the real client: another customer → LOAN_NOT_FOUND / CONTRACT_NOT_AVAILABLE / PAYMENT_NOT_FOUND', async () => {
    const { app, ctx } = await seed();
    const intruder = { customerId: (await createCustomer(t.prisma)).id, correlationId: 'corr-x' };
    const loans = new RealLoanServicing(http);
    const pay = new RealPaymentCollection(http);
    expect(await code(loans.getLoan(intruder, app.id))).toBe('LOAN_NOT_FOUND');
    expect(await code(loans.getBalance(intruder, app.id))).toBe('LOAN_NOT_FOUND');
    expect(await code(loans.getSchedule(intruder, app.id))).toBe('LOAN_NOT_FOUND');
    expect(await code(new RealContractFiles(http).getInfo(intruder, app.id))).toBe('CONTRACT_NOT_AVAILABLE');
    expect(await code(pay.listMethods(intruder, app.id))).toBe('LOAN_NOT_FOUND');
    const own = await pay.create(ctx, { loanId: app.id, method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'MNT' }, 'contract-key-1');
    expect(await code(pay.get(intruder, own.paymentId))).toBe('PAYMENT_NOT_FOUND');
    expect(await code(pay.create(intruder, { loanId: app.id, method: 'QPAY', amountType: 'CUSTOM', amount: 5000, currency: 'MNT' }, 'contract-key-2'))).toBe('LOAN_NOT_FOUND');
    expect(await loans.listLoans(intruder)).toEqual([]);
  });

  it('contract files: info + PDF stream', async () => {
    const { app, ctx } = await seed();
    const dl = await new RealContractFiles(http).open(ctx, app.id);
    const chunks: Buffer[] = [];
    for await (const c of dl.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(PDF)).toBe(true);
    expect(dl.info).toMatchObject({ loanId: app.id, signed: false, mime: 'application/pdf' });
  });

  it('payments: methods, create + replay, business errors pass through, status, history cursor', async () => {
    const { app, ctx } = await seed();
    const pay = new RealPaymentCollection(http);
    expect((await pay.listMethods(ctx, app.id)).map((m) => m.method).sort()).toEqual(['BANK_ACCOUNT', 'QPAY', 'SOCIALPAY']);
    const balance = await new RealLoanServicing(http).getBalance(ctx, app.id);
    const cmd = { loanId: app.id, method: 'QPAY' as const, amountType: 'OVERDUE' as const, amount: balance.overdue.total, currency: 'MNT' as const };
    const created = await pay.create(ctx, cmd, 'contract-key-3');
    expect(created).toMatchObject({ status: 'PENDING', amountType: 'OVERDUE', amount: balance.overdue.total });
    expect((await pay.create(ctx, cmd, 'contract-key-3')).paymentId).toBe(created.paymentId);
    expect(await code(pay.create(ctx, { ...cmd, amount: cmd.amount + 1 }, 'contract-key-3'))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await code(pay.create(ctx, { ...cmd, amount: cmd.amount + 1 }, 'contract-key-4'))).toBe('AMOUNT_OUT_OF_RANGE');
    expect((await pay.get(ctx, created.paymentId)).paymentId).toBe(created.paymentId);
    const page = await pay.list(ctx, app.id, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(await code(pay.list(ctx, app.id, { limit: 1, cursor: 'bm9wZQ' }))).toBe('INVALID_REQUEST');
  });

  it('a wrong internal token is DOWNSTREAM_UNAVAILABLE for the client (401 never leaks data)', async () => {
    const { ctx } = await seed();
    const bad = new InternalHttpClient({ baseUrl, timeoutMs: 3000, maxStreamBytes: 1024, retryDelayMs: 1, internalToken: 'wrong-token-wrong-token' });
    expect(await code(new RealLoanServicing(bad).listLoans(ctx))).toBe('DOWNSTREAM_UNAVAILABLE');
  });
});
