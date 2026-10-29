import request from 'supertest';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { PaymentReceived } from '@los/contracts';
import { MockBankGateway } from '../../integrations/bank-transfer/bank-transfer.mock';
import { BANK_GATEWAY } from '../../integrations/bank-transfer/bank-transfer.provider';
import { MockQPayClient } from '../../integrations/qpay/qpay.mock';
import { QPAY_CLIENT } from '../../integrations/qpay/qpay.provider';
import { MockSocialPayClient } from '../../integrations/socialpay/socialpay.mock';
import { SOCIALPAY_CLIENT } from '../../integrations/socialpay/socialpay.provider';
import { ORG, createApplication, createBorrower, createCustomer, createSchedule, resetDb } from '../../test-utils/factories';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { PaymentModule } from './payment.module';
import { PaymentService } from './payment.service';

export interface PaymentEnv { t: TestApp; qpay: MockQPayClient; socialpay: MockSocialPayClient; bank: MockBankGateway; http: () => ReturnType<typeof request> }

/** PaymentModule-ийг mock интеграцитай босгоно. Maintenance-ийн timer унтраалттай (тестэд гараар дуудна). */
export async function bootPayment(customize?: (b: TestingModuleBuilder) => TestingModuleBuilder): Promise<PaymentEnv> {
  process.env.PAYMENT_MAINTENANCE = 'off';
  const t = await createTestApp([PaymentModule], customize);
  return {
    t, qpay: t.app.get(QPAY_CLIENT), socialpay: t.app.get(SOCIALPAY_CLIENT), bank: t.app.get(BANK_GATEWAY),
    http: () => request(t.app.getHttpServer()),
  };
}

export async function resetPayment(env: PaymentEnv): Promise<void> {
  await resetDb(env.t.prisma);
  env.t.clock.set('2026-10-28T02:00:00Z');
  for (const mock of [env.qpay, env.socialpay, env.bank]) if (mock instanceof MockQPayClient || mock instanceof MockSocialPayClient || mock instanceof MockBankGateway) mock.reset(); // real горимтой тестэд mock биш
}

export interface SeedOptions { status?: string; firstDue?: string; stale?: boolean; withSchedule?: boolean; currency?: string; principal?: number; months?: number; contractNo?: string; officerId?: string; branchId?: string }

/**
 * ACTIVE зээл + ЭТХ (annuity, 30 хоногийн алхам). Анхдагч firstDue='2026-09-28', тест цаг 2026-10-28:
 * мөр 1 (09-28) хугацаа хэтэрсэн 30 хоног, мөр 2 (10-28) өнөөдөр, мөр 3+ хараахан болоогүй.
 */
export async function seedLoan(env: PaymentEnv, o: SeedOptions = {}) {
  const prisma = env.t.prisma;
  const principal = o.principal ?? 1_200_000;
  const customer = await createCustomer(prisma);
  const app = await createApplication(prisma, { status: o.status ?? 'ACTIVE', currency: o.currency ?? 'MNT', amount: principal, contractNo: o.contractNo, officerId: o.officerId ?? 'officer-1', branchId: o.branchId ?? 'branch-1' });
  await createBorrower(prisma, app.id, customer.id, 'PRIMARY');
  const schedule = o.withSchedule === false ? null : await createSchedule(prisma, app.id, { firstDue: o.firstDue ?? '2026-09-28', principal, months: o.months ?? 12, stale: o.stale });
  return { app, customer, schedule, rows: schedule?.rows ?? [] };
}

export const row = (rows: Array<{ total: unknown }>, i: number) => Number(rows[i].total);
export const sumRows = (rows: Array<{ total: unknown }>, from: number, to: number) => Math.round(rows.slice(from, to).reduce((s, r) => s + Number(r.total), 0) * 100) / 100;

export async function paymentEvents(env: PaymentEnv) {
  const rows = await env.t.prisma.outbox.findMany({ where: { type: 'PaymentReceived' }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => PaymentReceived.parse(r.payload));
}

export async function setSetting(env: PaymentEnv, key: string, valueJson: unknown): Promise<void> {
  await env.t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key } }, create: { orgId: ORG, key, valueJson: valueJson as never }, update: { valueJson: valueJson as never } });
}

/** Invoice үүсгээд DB-н мөрийг (providerInvoiceId-тай) буцаана. */
export async function makeInvoice(env: PaymentEnv, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await env.http().post('/api/payments/invoices').set(headers).send(body);
  if (res.status !== 200 && res.status !== 201) throw new Error(`invoice үүссэнгүй: ${res.status} ${JSON.stringify(res.body)}`);
  const db = await env.t.prisma.paymentInvoice.findUniqueOrThrow({ where: { id: res.body.id } });
  return { view: res.body as { id: string; senderInvoiceNo: string; amount: number; status: string }, db };
}

/** PaymentService.recordPayment-ийг шууд дуудаж (HTTP-гүй) төлбөр бүртгэнэ. */
export async function recordDirect(env: PaymentEnv, applicationId: string, amount: number, o: { id?: string; paidAt?: Date; provider?: 'QPAY' | 'SOCIALPAY' | 'BANK_TRANSFER'; invoiceId?: string | null; currency?: string } = {}) {
  const app = await env.t.prisma.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
  return env.t.app.get(PaymentService).recordPayment({ orgId: app.orgId, userId: 'tester', correlationId: 'test-corr' }, {
    applicationId, invoiceId: o.invoiceId ?? null, provider: o.provider ?? 'BANK_TRANSFER', providerPaymentId: o.id ?? `DIRECT-${Math.random().toString(36).slice(2)}`,
    amount, currency: o.currency ?? 'MNT', paidAt: o.paidAt ?? env.t.clock.now(),
  });
}
