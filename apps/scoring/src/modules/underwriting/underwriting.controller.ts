import { Body, Controller, Get, HttpCode, Param, Post, Put, UseFilters } from '@nestjs/common';
import { z } from 'zod';
import {
  MarkCalculationStaleRequest, ScoreRequest, SelectMethodRequest, UnderwritePersistRequest,
  type CalculationRecord, type RequestContext, type UnderwriteResult,
} from '@los/contracts';
import { AllExceptionsFilter, Ctx, Permissions } from '@los/nest-common';
import { ScoringZodPipe } from './scoring-http';
import { UnderwritingService } from './underwriting.service';

const ApplicationIdParam = z.string().min(1).max(128);
const appId = () => new ScoringZodPipe(ApplicationIdParam);

/**
 * Модуль 8 · `/api/underwrite` (дотоод; gateway-ээс ГАРГАХГҮЙ — `INTERNAL_ONLY_PREFIXES`). origination дууддаг тул хүсэлтийн хүрээ (NFR-3) тэнд шалгагдана;
 * scoring зөвхөн байгууллага (`X-Org-Id`) ба эрх (`application:read|write`)-ийг шалгана. Алдаа: foundation хэлбэр (`@UseFilters`).
 */
@Controller('underwrite')
@UseFilters(AllExceptionsFilter)
export class UnderwritingController {
  constructor(private readonly service: UnderwritingService) {}

  /** FR-8.3 slider: хадгалахгүй, event-гүй */
  @Permissions('application:read') @Post('preview') @HttpCode(200)
  preview(@Body(new ScoringZodPipe(ScoreRequest)) body: ScoreRequest): UnderwriteResult {
    return this.service.preview(body);
  }

  @Permissions('application:write') @Post()
  persist(@Ctx() ctx: RequestContext, @Body(new ScoringZodPipe(UnderwritePersistRequest)) body: UnderwritePersistRequest): Promise<CalculationRecord> {
    return this.service.persist(ctx, body);
  }

  @Permissions('application:read') @Get('applications/:applicationId/latest')
  latest(@Ctx() ctx: RequestContext, @Param('applicationId', appId()) applicationId: string): Promise<CalculationRecord> {
    return this.service.latest(ctx, applicationId);
  }

  @Permissions('application:write') @Put('applications/:applicationId/selection')
  select(
    @Ctx() ctx: RequestContext, @Param('applicationId', appId()) applicationId: string, @Body(new ScoringZodPipe(SelectMethodRequest)) body: SelectMethodRequest,
  ): Promise<CalculationRecord> {
    return this.service.select(ctx, applicationId, body);
  }

  @Permissions('application:write') @Post('applications/:applicationId/stale') @HttpCode(200)
  stale(
    @Ctx() ctx: RequestContext, @Param('applicationId', appId()) applicationId: string, @Body(new ScoringZodPipe(MarkCalculationStaleRequest)) body: MarkCalculationStaleRequest,
  ): Promise<CalculationRecord> {
    return this.service.markStale(ctx, applicationId, body);
  }
}
