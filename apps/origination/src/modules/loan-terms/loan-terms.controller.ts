import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { SaveLoanTermsRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { LoanTermsService } from './loan-terms.service';

/**
 * FR-5 · Gateway: `/api/origination/…`. Унших = `application:read`, хадгалах = `application:write` (хүрээг ApplicationAccessService шалгана).
 * Зээлдэгчийн портал (CUSTOMER) эрхгүй.
 */
@Controller()
export class LoanTermsController {
  constructor(private readonly terms: LoanTermsService) {}

  @Permissions('application:read') @Get('loan-terms/products')
  products(@Ctx() ctx: RequestContext) { return this.terms.products(ctx); }

  @Permissions('application:read') @Get('loan-terms/cib-purposes')
  cibPurposes() { return this.terms.cibPurposes(); }

  @Permissions('application:read') @Get('applications/:applicationId/loan-terms')
  get(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) { return this.terms.get(ctx, applicationId); }

  @Permissions('application:write') @Put('applications/:applicationId/loan-terms') @HttpCode(200)
  save(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(SaveLoanTermsRequest)) body: SaveLoanTermsRequest) {
    return this.terms.save(ctx, applicationId, body);
  }
}
