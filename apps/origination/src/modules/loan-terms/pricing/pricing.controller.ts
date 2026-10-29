import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { PricingQuoteRequest, PricingTiersQuery, SavePricingTiersRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { PricingService } from './pricing.service';

/**
 * FR-5.5 · Gateway: `/api/origination/loan-terms/pricing/*`. Шатлал засах = `settings:manage` (ADMIN, NFR-7);
 * харах, санал авах = `application:read` (ЗЭЗ, салбарын захирал, батлагч, админ — зээлдэгчийн портал биш).
 */
@Controller('loan-terms/pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Permissions('application:read') @Get('tiers')
  getTiers(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PricingTiersQuery)) query: PricingTiersQuery) { return this.pricing.getTierSet(ctx, query.productId ?? null); }

  @Permissions('settings:manage') @Put('tiers')
  saveTiers(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(SavePricingTiersRequest)) body: SavePricingTiersRequest) { return this.pricing.saveTierSet(ctx, body); }

  @Permissions('application:read') @Post('quote') @HttpCode(200)
  quote(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PricingQuoteRequest)) body: PricingQuoteRequest) { return this.pricing.quote(ctx, body); }
}
