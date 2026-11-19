import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import type {
  PortalContractInfo, PortalCustomerLookup, PortalLoanBalance, PortalLoanDetail, PortalLoanSummary, PortalPayment, PortalPaymentList,
  PortalPaymentMethodLimit, PortalProfile, PortalSchedule, RequestContext,
} from '@los/contracts';
import { Ctx, Public } from '@los/nest-common';
import { PortalContractService } from './portal-contract.service';
import { PortalCustomersService } from './portal-customers.service';
import { PortalExceptionFilter } from './portal-errors';
import { PortalLoansService } from './portal-loans.service';
import { PortalPaymentsService } from './portal-payments.service';
import { PortalAnonymous, PortalInternalGuard } from './portal.guard';

interface PdfResponse { setHeader(k: string, v: string): void; status(n: number): PdfResponse; end(b: Buffer): void }

/**
 * H8 · docs/05-portal-bff.md §6: portal-bff (INTEGRATION_MODE=real) → origination дотоод API. Клиент: apps/portal-bff/src/integrations/*\/real-*.ts.
 * `@Public()` = глобал ажилтны ContextAuthGuard-ыг алгасна; оронд нь PortalInternalGuard (дотоод токен + CUSTOMER/PORTAL_ANONYMOUS, ажилтан 403).
 * Gateway энэ замыг ажилтны proxy-гоор гаргахгүй (`/api/origination/internal` — gateway route-policy INTERNAL_ONLY_PREFIXES).
 */
@Public()
@UseGuards(PortalInternalGuard)
@UseFilters(PortalExceptionFilter)
@Controller('internal/portal')
export class PortalController {
  constructor(
    private readonly customers: PortalCustomersService,
    private readonly loans: PortalLoansService,
    private readonly contracts: PortalContractService,
    private readonly payments: PortalPaymentsService,
  ) {}

  // PRT-FR-1.1, 1.4 — нэвтрэхээс өмнө (X-Actor-Type: PORTAL_ANONYMOUS)
  @PortalAnonymous()
  @Post('customers/lookup')
  @HttpCode(200)
  lookup(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<PortalCustomerLookup> { return this.customers.lookup(ctx, body); }

  @Get('customers/me')
  me(@Ctx() ctx: RequestContext): Promise<PortalProfile> { return this.customers.profile(ctx); }

  @Post('otp')
  @HttpCode(202)
  otp(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<Record<string, never>> { return this.customers.sendOtp(ctx, body); }

  // PRT-FR-2, 3
  @Get('loans')
  list(@Ctx() ctx: RequestContext): Promise<PortalLoanSummary[]> { return this.loans.list(ctx); }

  @Get('loans/:loanId')
  detail(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string): Promise<PortalLoanDetail> { return this.loans.detail(ctx, loanId); }

  @Get('loans/:loanId/balance')
  balance(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string): Promise<PortalLoanBalance> { return this.loans.balance(ctx, loanId); }

  @Get('loans/:loanId/schedule')
  schedule(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string): Promise<PortalSchedule> { return this.loans.schedule(ctx, loanId); }

  // PRT-FR-4.1
  @Get('loans/:loanId/contract')
  contract(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string): Promise<PortalContractInfo> { return this.contracts.info(ctx, loanId); }

  @Get('loans/:loanId/contract/content')
  async contractContent(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string, @Res() res: PdfResponse): Promise<void> {
    const { info, pdf } = await this.contracts.content(ctx, loanId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${info.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).end(pdf);
  }

  // PRT-FR-5
  @Get('loans/:loanId/payment-methods')
  methods(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string): Promise<PortalPaymentMethodLimit[]> { return this.payments.methods(ctx, loanId); }

  @Post('loans/:loanId/payments')
  @HttpCode(201)
  createPayment(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined): Promise<PortalPayment> {
    return this.payments.create(ctx, loanId, body, key);
  }

  @Get('loans/:loanId/payments')
  history(@Ctx() ctx: RequestContext, @Param('loanId') loanId: string, @Query() query: Record<string, unknown>): Promise<PortalPaymentList> {
    return this.payments.list(ctx, loanId, query);
  }

  @Get('payments/:paymentId')
  payment(@Ctx() ctx: RequestContext, @Param('paymentId') paymentId: string): Promise<PortalPayment> { return this.payments.get(ctx, paymentId); }
}
