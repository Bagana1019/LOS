import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  BankNameCheckRequest, BankReconcileRequest, CreatePaymentInvoiceRequest, PaymentSimulateRequest,
  type BankNameCheckResponse, type BankReconcileResponse, type PaymentInvoiceView, type PaymentProviderInfo, type PaymentView, type RepaymentStatusView,
} from '@los/contracts';
import { Ctx } from '@los/nest-common';
import type { RequestContext } from '@los/contracts';
import { Roles } from '@los/nest-common';
import { ZodValidationPipe } from '@los/nest-common';
import { BankAccountService } from './bank-account.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { DevSimulationService } from './dev-simulation.service';
import { InvoiceService } from './invoice.service';
import { PaymentService, actorOf } from './payment.service';
import { ProviderRegistry } from './provider-registry';
import { RepaymentStatusService } from './repayment-status.service';

/** express нь шууд dependency биш тул зөвхөн хэрэгтэй хэсгийг бүтцээр тодорхойлно. */
interface StatusSetter { status(code: number): unknown }

const ReconcileBody = z.preprocess((v) => v ?? {}, BankReconcileRequest);

@Controller()
export class PaymentController {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly repayment: RepaymentStatusService,
    private readonly payments: PaymentService,
    private readonly invoices: InvoiceService,
    private readonly reconciliation: BankReconciliationService,
    private readonly bankAccounts: BankAccountService,
    private readonly simulation: DevSimulationService,
  ) {}

  /** Аль төлбөрийн хэлбэр идэвхтэй, mock/real. Нэвтэрсэн бүх хэрэглэгч. */
  @Get('payments/providers')
  providers(@Ctx() ctx: RequestContext): Promise<PaymentProviderInfo[]> { return this.registry.info(ctx.orgId); }

  @Get('applications/:applicationId/repayment-status')
  repaymentStatus(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string): Promise<RepaymentStatusView> { return this.repayment.get(ctx, applicationId); }

  @Get('applications/:applicationId/payments')
  list(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string): Promise<PaymentView[]> { return this.payments.list(ctx, applicationId); }

  /** 201 — шинэ invoice; 200 — адил хүсэлтийн байгаа (PENDING) invoice-ийг буцаав (idempotent). */
  @Post('payments/invoices')
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePaymentInvoiceRequest)) dto: CreatePaymentInvoiceRequest, @Res({ passthrough: true }) res: StatusSetter): Promise<PaymentInvoiceView> {
    const { view, created } = await this.invoices.create(ctx, dto);
    if (!created) res.status(200);
    return view;
  }

  @Get('payments/invoices/:id')
  getInvoice(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<PaymentInvoiceView> { return this.invoices.get(ctx, id); }

  @Post('payments/invoices/:id/cancel')
  @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<PaymentInvoiceView> { return this.invoices.cancel(ctx, id); }

  @Post('payments/bank-transfers/reconcile')
  @Roles('ADMIN')
  @HttpCode(200)
  reconcile(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ReconcileBody)) body: BankReconcileRequest): Promise<BankReconcileResponse> {
    return this.reconciliation.reconcile(actorOf(ctx), { since: body.since ? new Date(body.since) : undefined });
  }

  @Post('payments/bank-accounts/name-check')
  @Roles('OFFICER', 'ADMIN')
  @HttpCode(200)
  nameCheck(@Body(new ZodValidationPipe(BankNameCheckRequest)) body: BankNameCheckRequest): Promise<BankNameCheckResponse> { return this.bankAccounts.nameCheck(body); }

  /** Зөвхөн mock горим ба NODE_ENV≠production; үгүй бол 404. */
  @Post('payments/dev/simulate')
  @Roles('ADMIN')
  @HttpCode(200)
  simulate(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PaymentSimulateRequest)) body: PaymentSimulateRequest): Promise<PaymentInvoiceView> { return this.simulation.simulate(ctx, body); }
}
