import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  RecordExternalValuationRequest,
  SaveCollateralValuationRequest,
  SuggestValuationRequest,
  type RequestContext,
} from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { CollateralSuggestionService } from './collateral-suggestion.service';
import { CollateralValuationService } from './collateral-valuation.service';

// FR-14.1–14.3, FR-14.6 — collateral valuation (origination → valuation, sync REST, CLAUDE.md §3.1).
// Staff reach these through origination only (the gateway keeps `/api/valuation/valuate/collateral` internal): the application scope, the
// application status and the write rights are checked there. ADMIN has no application:write, and origination forwards the caller's own
// identity, so every route here asks for application:read only (docs/05 §4).
@Controller('valuate/collateral')
export class CollateralValuationController {
  constructor(
    @Inject(CollateralSuggestionService) private readonly suggestions: CollateralSuggestionService,
    @Inject(CollateralValuationService) private readonly valuations: CollateralValuationService,
  ) {}

  /** The system's suggestion and haircut; nothing is stored. POST: the description holds the plate number, which must stay out of URLs and access logs. */
  @Permissions('application:read')
  @Post('suggest')
  @HttpCode(200)
  suggest(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(SuggestValuationRequest)) body: SuggestValuationRequest) {
    return this.suggestions.suggest(ctx, body);
  }

  @Permissions('application:read')
  @Post()
  @HttpCode(201)
  save(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(SaveCollateralValuationRequest)) body: SaveCollateralValuationRequest) {
    return this.valuations.save(ctx, body);
  }

  @Permissions('application:read')
  @Post('external')
  @HttpCode(201)
  external(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(RecordExternalValuationRequest)) body: RecordExternalValuationRequest) {
    return this.valuations.recordExternal(ctx, body);
  }

  @Permissions('application:read')
  @Get(':collateralId/history')
  history(@Ctx() ctx: RequestContext, @Param('collateralId', new ZodValidationPipe(z.string().uuid())) collateralId: string) {
    return this.valuations.history(ctx, collateralId);
  }
}
