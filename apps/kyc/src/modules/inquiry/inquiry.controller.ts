import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  InquiryFetchRequest, InquiryListQuery, KycUnregisteredLoanRequest,
  type CreditHistorySummary, type InquiryFetchResponse, type InquiryListResponse, type RequestContext, type UnregisteredLoan,
} from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { InquiryService } from './inquiry.service';

const IdParam = z.string().trim().min(1).max(64);

/**
 * FR-3 · лавлагаа. Дуудагч: origination (sync REST, CLAUDE.md §3.2.2). Татах/засах — `customer:write`, унших — `customer:read`.
 * Регистр зөвхөн POST body-д; хариу/лог-д орохгүй.
 */
@Controller('inquiry')
export class InquiryController {
  constructor(private readonly inquiries: InquiryService) {}

  @Permissions('customer:write')
  @HttpCode(200)
  @Post('fetch')
  fetch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(InquiryFetchRequest)) body: InquiryFetchRequest): Promise<InquiryFetchResponse> {
    return this.inquiries.fetch(ctx, body);
  }

  @Permissions('customer:read')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(InquiryListQuery)) q: z.infer<typeof InquiryListQuery>): Promise<InquiryListResponse> {
    return this.inquiries.list(ctx, q.applicationId, q.customerId);
  }

  /** Тооцоолол (origination score) хэрэглэнэ — ЗМС/FICO хураангуй. */
  @Permissions('customer:read')
  @Get('credit-history')
  creditHistory(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(InquiryListQuery.required())) q: Required<z.infer<typeof InquiryListQuery>>): Promise<CreditHistorySummary> {
    return this.inquiries.creditHistory(ctx, q.applicationId, q.customerId);
  }

  @Permissions('customer:write')
  @Post('unregistered-loans')
  addLoan(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(KycUnregisteredLoanRequest)) body: KycUnregisteredLoanRequest): Promise<UnregisteredLoan> {
    return this.inquiries.addUnregisteredLoan(ctx, body);
  }

  @Permissions('customer:write')
  @HttpCode(204)
  @Delete('unregistered-loans/:id')
  async removeLoan(@Ctx() ctx: RequestContext, @Param('id', new ZodValidationPipe(IdParam)) id: string, @Query('applicationId', new ZodValidationPipe(IdParam)) applicationId: string): Promise<void> {
    await this.inquiries.removeUnregisteredLoan(ctx, applicationId, id);
  }
}
