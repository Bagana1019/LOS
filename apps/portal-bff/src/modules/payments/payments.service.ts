import { Inject, Injectable } from '@nestjs/common';
import type { PortalCreatePayment, PortalPayment, PortalPaymentList, PortalPaymentListQuery, PortalPaymentOptions } from '@los/contracts';
import { AuditService } from '../../audit/audit.service';
import { PortalError } from '../../common/portal-error';
import type { CallContext } from '../../common/request-context';
import { LOAN_SERVICING, type LoanServicingPort } from '../../integrations/loan-servicing/loan-servicing.port';
import { PAYMENT_COLLECTION, type PaymentCollectionPort } from '../../integrations/payment-collection/payment-collection.port';
import { IdempotencyService } from '../../security/idempotency.service';
import { LoanOwnershipService, ensureSameLoan } from '../loans/loan-ownership.service';
import { checkMethodLimit, resolveAmount } from './amount';

export interface CreatedPayment {
  payment: PortalPayment;
  replayed: boolean;
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(LOAN_SERVICING) private readonly loans: LoanServicingPort,
    @Inject(PAYMENT_COLLECTION) private readonly payments: PaymentCollectionPort,
    private readonly ownership: LoanOwnershipService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  /** Төлөх боломжит дүн (дараагийн төлөлт, хугацаа хэтэрсэн, бүрэн хаах) ба хэрэгсэл тус бүрийн хязгаар. */
  async options(ctx: CallContext, loanId: string): Promise<PortalPaymentOptions> {
    await this.ownership.assertOwned(ctx, loanId);
    const [balance, methods] = await Promise.all([this.loans.getBalance(ctx, loanId), this.payments.listMethods(ctx, loanId)]);
    ensureSameLoan(loanId, balance.loanId);
    const next = balance.nextInstallment;
    return {
      loanId,
      currency: balance.currency,
      installment: next && next.amountDue > 0 ? { seq: next.seq, dueDate: next.dueDate, amount: next.amountDue } : null,
      overdue: balance.overdue.total > 0 ? { amount: balance.overdue.total, days: balance.overdue.days } : null,
      payoff: balance.payoff,
      methods,
    };
  }

  /**
   * Төлбөр эхлүүлэх. `Idempotency-Key` заавал: ижил түлхүүр + ижил агуулга → анхны хариуг дахин өгнө
   * (дахин төлбөр үүсэхгүй); ижил түлхүүр + өөр агуулга → 422.
   */
  async create(ctx: CallContext, loanId: string, body: PortalCreatePayment, idempotencyKey: string | undefined): Promise<CreatedPayment> {
    const key = IdempotencyService.validateKey(idempotencyKey);
    await this.ownership.assertOwned(ctx, loanId);
    const fingerprint = IdempotencyService.fingerprint({ loanId, ...body });

    const result = await this.idempotency.run(ctx.customerId, key, fingerprint, async () => {
      try {
        const [balance, methods] = await Promise.all([this.loans.getBalance(ctx, loanId), this.payments.listMethods(ctx, loanId)]);
        ensureSameLoan(loanId, balance.loanId);
        const amount = resolveAmount(body, balance);
        checkMethodLimit(body.method, amount, methods);

        const payment = await this.payments.create(
          ctx,
          { loanId, method: body.method, amountType: body.amountType, amount, currency: balance.currency },
          key,
        );
        ensureSameLoan(loanId, payment.loanId);
        return payment;
      } catch (err) {
        if (err instanceof PortalError && BUSINESS_REJECTIONS.has(err.code)) {
          await this.audit.record({
            action: 'PAYMENT_REJECTED',
            correlationId: ctx.correlationId,
            outcome: 'FAILURE',
            customerId: ctx.customerId,
            target: { type: 'LOAN', id: loanId },
            meta: { code: err.code, amountType: body.amountType, method: body.method },
          });
        }
        throw err;
      }
    });

    await this.audit.record({
      action: result.replayed ? 'PAYMENT_REPLAYED' : 'PAYMENT_CREATED',
      correlationId: ctx.correlationId,
      outcome: 'SUCCESS',
      customerId: ctx.customerId,
      target: { type: 'PAYMENT', id: result.value.paymentId },
      meta: { loanId, amount: result.value.amount, currency: result.value.currency, method: result.value.method, amountType: result.value.amountType },
    });
    return { payment: result.value, replayed: result.replayed };
  }

  /** Төлбөрийн төлөв (polling). Зээл нь нэвтэрсэн харилцагчийнх биш бол 404 — төлбөрийн ID оршин буйг задруулахгүй. */
  async get(ctx: CallContext, paymentId: string): Promise<PortalPayment> {
    const payment = await this.payments.get(ctx, paymentId);
    await this.assertLoanOwnedAsPayment(ctx, payment.loanId);
    return payment;
  }

  async list(ctx: CallContext, loanId: string, query: PortalPaymentListQuery): Promise<PortalPaymentList> {
    await this.ownership.assertOwned(ctx, loanId);
    const page = await this.payments.list(ctx, loanId, query);
    for (const item of page.items) ensureSameLoan(loanId, item.loanId);
    return page;
  }

  private async assertLoanOwnedAsPayment(ctx: CallContext, loanId: string): Promise<void> {
    try {
      await this.ownership.assertOwned(ctx, loanId);
    } catch (err) {
      if (err instanceof PortalError && err.code === 'LOAN_NOT_FOUND') throw new PortalError('PAYMENT_NOT_FOUND');
      throw err;
    }
  }
}

const BUSINESS_REJECTIONS = new Set(['LOAN_NOT_PAYABLE', 'NO_OVERDUE', 'AMOUNT_OUT_OF_RANGE', 'METHOD_NOT_AVAILABLE']);
