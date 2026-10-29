import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { allocatePayment } from '@los/calc';
import type { PaymentProvider, PaymentView } from '@los/contracts';
import { maskAccountNo } from '@los/database';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { DomainEvents } from '../../shared/domain-events';
import { Prisma } from '.prisma/client-origination';
import { PrismaService, Tx } from '../../prisma.service';
import type { RequestContext } from '@los/contracts';
import { sanitizeRaw } from '../../integrations/payment-provider/sanitize';
import { PAYMENT_INCLUDE, PaymentWithAllocations, toPaymentView } from './payment.mapper';
import { loadCurrentSchedule } from './schedule-state';

const Decimal = Prisma.Decimal;

/** Бизнес үйлдэл хийгч. Callback / poll / тулгалт нь хэрэглэгчгүй тул userId=null, orgId нь invoice/application-аас. */
export interface Actor { orgId: string; userId: string | null; correlationId: string }
export const actorOf = (ctx: Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'>): Actor => ({ orgId: ctx.orgId, userId: ctx.userId, correlationId: ctx.correlationId });
export const systemActor = (orgId: string): Actor => ({ orgId, userId: null, correlationId: randomUUID() });

export interface RecordPaymentInput {
  applicationId: string;
  invoiceId?: string | null;
  provider: PaymentProvider;
  providerPaymentId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  payerName?: string | null;
  /** Бүтэн дансны дугаар байж болно — зөвхөн нуугдмал хэлбэрээр хадгална. */
  payerAccount?: string | null;
  raw?: unknown;
}
export interface RecordResult { payment: PaymentWithAllocations; created: boolean }
/** Төлбөртэй НЭГ транзакцид ажиллах нэмэлт үйлдэл (жишээ нь BankTransferEntry-г MATCHED болгох). */
export type RecordHook = (tx: Tx, result: RecordResult) => Promise<void>;

@Injectable()
export class PaymentService {
  private readonly logger = new Logger('PaymentService');
  constructor(private readonly prisma: PrismaService, private readonly events: DomainEvents, private readonly access: ApplicationAccessService) {}

  /**
   * Төлбөр бүртгэх ЦОРЫН ГАНЦ зам (callback / poll / банкны тулгалт) — брифийн бизнес дүрэм 4.
   * Нэг $transaction: (a) application мөрийг FOR UPDATE-оор түгжинэ, (b) (provider, providerPaymentId)-ээр idempotent,
   * (c) одоогийн ЭТХ-ийн төлөгдсөн дүнг allocation-аас тооцоолж allocatePayment-ээр хуваарилна, (d) unallocatedAmount,
   * (e) invoice → PAID, (f) PaymentReceived event (outbox).
   * ЭТХ байхгүй / stale / валют зөрүүтэй бол бүх дүн unallocated — мөнгө алдахгүй.
   */
  async recordPayment(actor: Actor, input: RecordPaymentInput, hook?: RecordHook): Promise<RecordResult> {
    // 2 оронд бөөрөнхийлөхөд 0 болох дүн (жишээ нь 0.004) хуваарилах боломжгүй тул эхлээд татгалзана (500 биш 400).
    if (!Number.isFinite(input.amount) || new Decimal(input.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).lte(0)) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Төлбөрийн дүн эерэг байх ёстой' });
    try {
      return await this.prisma.$transaction((tx) => this.recordInTx(tx, actor, input, hook), { timeout: 20_000 });
    } catch (e) {
      // Өөр application-ийн түгжээгээр зэрэг орсон ховор тохиолдол: unique зөрчил → байгааг буцаана.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.payment.findUnique({ where: { provider_providerPaymentId: { provider: input.provider, providerPaymentId: input.providerPaymentId } }, include: PAYMENT_INCLUDE });
        if (existing) {
          const result: RecordResult = { payment: existing, created: false };
          if (hook) await this.prisma.$transaction((tx) => hook(tx, result));
          return result;
        }
      }
      throw e;
    }
  }

  private async recordInTx(tx: Tx, actor: Actor, input: RecordPaymentInput, hook?: RecordHook): Promise<RecordResult> {
    await tx.$queryRaw`SELECT id FROM "origination"."loan_application" WHERE id = ${input.applicationId} FOR UPDATE`;
    const existing = await tx.payment.findUnique({ where: { provider_providerPaymentId: { provider: input.provider, providerPaymentId: input.providerPaymentId } }, include: PAYMENT_INCLUDE });
    if (existing) {
      const result: RecordResult = { payment: existing, created: false };
      if (hook) await hook(tx, result);
      return result;
    }
    const app = await tx.loanApplication.findFirst({ where: { id: input.applicationId, orgId: actor.orgId }, select: { id: true, orgId: true, currency: true } });
    if (!app) throw new BadRequestException({ code: 'APPLICATION_NOT_FOUND', message: 'Хүсэлт олдсонгүй' });

    const amount = new Decimal(input.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const schedule = input.currency === app.currency ? await loadCurrentSchedule(tx, app.id) : null;
    const allocation = schedule && schedule.installments.length ? allocatePayment(schedule.installments, amount.toNumber()) : null;
    const lines = allocation?.lines ?? [];
    const unallocated = allocation ? new Decimal(allocation.unallocated) : amount;
    if (!allocation) this.logger.warn(`Төлбөр ${input.provider}: хуваарилах ЭТХ байхгүй/валют зөрүүтэй — бүх дүн unallocated (app=${app.id})`);

    const raw = input.raw === undefined ? undefined : (sanitizeRaw(input.raw) as Prisma.InputJsonValue);
    const payment = await tx.payment.create({
      data: {
        orgId: app.orgId, applicationId: app.id, invoiceId: input.invoiceId ?? null, provider: input.provider, providerPaymentId: input.providerPaymentId,
        amount, currency: input.currency, paidAt: input.paidAt, payerName: input.payerName ?? null,
        payerAccountMasked: input.payerAccount ? maskAccountNo(input.payerAccount) : null, unallocatedAmount: unallocated, rawJson: raw, createdBy: actor.userId,
        allocations: { create: lines.map((l) => ({ scheduleRowId: l.installmentId, interestPaid: l.interestPaid, principalPaid: l.principalPaid, totalPaid: l.totalPaid })) },
      },
      include: PAYMENT_INCLUDE,
    });

    if (input.invoiceId) {
      const invoice = await tx.paymentInvoice.findUnique({ where: { id: input.invoiceId }, select: { amount: true, status: true } });
      if (invoice && !new Decimal(invoice.amount).equals(amount)) this.logger.warn(`Invoice ${input.invoiceId}: төлсөн дүн (${amount.toString()}) invoice-ийн дүнтэй (${invoice.amount.toString()}) зөрүүтэй — төлсөн дүнгээр бүртгэв`);
      await tx.paymentInvoice.updateMany({ where: { id: input.invoiceId, status: { not: 'PAID' } }, data: { status: 'PAID', paidAt: input.paidAt, updatedBy: actor.userId } });
    }

    await this.events.publish(tx, {
      type: 'PaymentReceived', paymentId: payment.id, applicationId: app.id, provider: input.provider, amount: amount.toNumber(), currency: input.currency,
      paidAt: input.paidAt.toISOString(), unallocatedAmount: unallocated.toNumber(), scheduleRowIds: lines.map((l) => l.installmentId),
    }, actor);

    const result: RecordResult = { payment, created: true };
    if (hook) await hook(tx, result);
    return result;
  }

  /** GET applications/:applicationId/payments — шинэ нь эхэнд, allocation-тай. */
  async list(ctx: RequestContext, applicationId: string): Promise<PaymentView[]> {
    await this.access.load(ctx, applicationId, 'read');
    const rows = await this.prisma.payment.findMany({ where: { applicationId, orgId: ctx.orgId }, orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }], take: 500, include: PAYMENT_INCLUDE });
    return rows.map(toPaymentView);
  }
}
