import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import {
  MerchantDashboardQuery, PosLeaseAccept, PosLeaseCancel, PosLeaseCreate, PosLeaseDeliver, PosLeaseListQuery, PosLeaseSubmit, PosQuoteRequest,
  type MerchantDashboard, type MerchantProfile, type OtpSent, type PosLeaseListItem, type PosLeaseView, type PosLeaseWithOtp, type PosQuote,
} from '@los/contracts';
import { ContextGuard, Ctx } from '../common/context.guard';
import { MerchantExceptionFilter } from '../common/exception.filter';
import type { HttpResponse } from '../common/http.types';
import type { Paged } from '../common/paged';
import type { RequestContext } from '../common/request-context';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ParseIdPipe, ZodPipe, validationFailed } from '../common/zod.pipe';
import { DashboardService } from '../services/dashboard.service';
import { LeaseService } from '../services/lease.service';
import { MerchantService } from '../services/merchant.service';
import { QuoteService } from '../services/quote.service';

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** POS-BR-12: `Idempotency-Key` толгой заавал (8-64 тэмдэгт [A-Za-z0-9_-]). */
export function parseIdempotencyKey(value: string | undefined): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw validationFailed([{ code: 'custom', path: ['Idempotency-Key'], message: 'Idempotency-Key header is required (8-64 characters: A-Z a-z 0-9 _ -)' }]);
  }
  return value;
}

/** Мерчант портал (docs/05 §8). Хүрээ (merchantId/storeId) service-д дахин шалгагдана. */
@Controller('merchant-portal')
@UseGuards(ContextGuard, RolesGuard)
@UseFilters(MerchantExceptionFilter)
@Roles('MERCHANT_ADMIN', 'MERCHANT_STAFF')
export class MerchantPortalController {
  constructor(
    @Inject(MerchantService) private readonly merchants: MerchantService,
    @Inject(DashboardService) private readonly dashboard: DashboardService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(LeaseService) private readonly leases: LeaseService,
  ) {}

  @Get('me')
  me(@Ctx() ctx: RequestContext): Promise<MerchantProfile> {
    return this.merchants.getProfile(ctx);
  }

  @Get('dashboard')
  getDashboard(@Ctx() ctx: RequestContext, @Query(new ZodPipe(MerchantDashboardQuery)) query: MerchantDashboardQuery): Promise<MerchantDashboard> {
    return this.dashboard.dashboard(ctx, query);
  }

  @Post('quotes') @HttpCode(200)
  quote(@Ctx() ctx: RequestContext, @Body(new ZodPipe(PosQuoteRequest)) body: PosQuoteRequest): Promise<PosQuote> {
    return this.quotes.quote(ctx, body);
  }

  @Post('leases')
  async create(
    @Ctx() ctx: RequestContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodPipe(PosLeaseCreate)) body: PosLeaseCreate,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<PosLeaseWithOtp> {
    const { result, replayed } = await this.leases.createLease(ctx, parseIdempotencyKey(key), body);
    res.status(replayed ? 200 : 201);
    return result;
  }

  @Get('leases')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(PosLeaseListQuery)) query: PosLeaseListQuery): Promise<Paged<PosLeaseListItem>> {
    return this.leases.listForMerchant(ctx, query);
  }

  @Get('leases/:id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string): Promise<PosLeaseView> {
    return this.leases.getForMerchant(ctx, id);
  }

  @Post('leases/:id/otp/consent') @HttpCode(200)
  resendConsent(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string): Promise<OtpSent> {
    return this.leases.resendConsentOtp(ctx, id);
  }

  @Post('leases/:id/submit') @HttpCode(200)
  submit(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PosLeaseSubmit)) body: PosLeaseSubmit): Promise<PosLeaseView> {
    return this.leases.submit(ctx, id, body);
  }

  @Post('leases/:id/otp/accept') @HttpCode(200)
  requestAcceptOtp(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string): Promise<OtpSent> {
    return this.leases.requestAcceptOtp(ctx, id);
  }

  @Post('leases/:id/accept') @HttpCode(200)
  accept(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PosLeaseAccept)) body: PosLeaseAccept): Promise<PosLeaseView> {
    return this.leases.accept(ctx, id, body);
  }

  @Post('leases/:id/deliver') @HttpCode(200)
  deliver(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PosLeaseDeliver)) body: PosLeaseDeliver): Promise<PosLeaseView> {
    return this.leases.deliver(ctx, id, body);
  }

  @Post('leases/:id/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PosLeaseCancel)) body: PosLeaseCancel): Promise<PosLeaseView> {
    return this.leases.cancel(ctx, id, body);
  }
}
