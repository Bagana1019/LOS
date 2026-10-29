import { Body, Controller, Get, HttpCode, Put, Post, Query, UseFilters } from '@nestjs/common';
import { z } from 'zod';
import { SoscoScoreRequest, type RequestContext, type SaveSoscoModelRequest, type SoscoModelView, type SoscoScoreResponse, type SoscoSummary } from '@los/contracts';
import { AllExceptionsFilter, Ctx, Permissions } from '@los/nest-common';
import { ScoringZodPipe } from '../underwriting/scoring-http';
import { SaveSoscoModelPipe } from './save-model.pipe';
import { SoscoModelService } from './sosco-model.service';
import { SoscoService } from './sosco.service';

const LatestQuery = z.object({ applicationId: z.string().min(1).max(128), customerId: z.string().min(1).max(128) });
type LatestQuery = z.infer<typeof LatestQuery>;

/**
 * Модуль 8 · `/api/sosco`. `score`, `results` — дотоод (gateway гаргахгүй; хүрээг origination шалгана). `models` — gateway-ээр нээлттэй
 * (унших `application:read`, бичих `settings:manage` — gateway route-policy + энд дахин шалгана). Алдаа: foundation хэлбэр.
 */
@Controller('sosco')
@UseFilters(AllExceptionsFilter)
export class SoscoController {
  constructor(private readonly sosco: SoscoService, private readonly models: SoscoModelService) {}

  @Permissions('application:write') @Post('score') @HttpCode(200)
  score(@Ctx() ctx: RequestContext, @Body(new ScoringZodPipe(SoscoScoreRequest)) body: SoscoScoreRequest): Promise<SoscoScoreResponse> {
    return this.sosco.score(ctx, body);
  }

  @Permissions('application:read') @Get('results/latest')
  latest(@Ctx() ctx: RequestContext, @Query(new ScoringZodPipe(LatestQuery)) query: LatestQuery): Promise<SoscoSummary> {
    return this.sosco.latest(ctx, query.applicationId, query.customerId);
  }

  @Permissions('application:read') @Get('models')
  list(@Ctx() ctx: RequestContext): Promise<SoscoModelView[]> {
    return this.models.list(ctx);
  }

  @Permissions('application:read') @Get('models/active')
  active(@Ctx() ctx: RequestContext): Promise<SoscoModelView> {
    return this.models.getActive(ctx);
  }

  @Permissions('settings:manage') @Put('models')
  save(@Ctx() ctx: RequestContext, @Body(new SaveSoscoModelPipe()) body: SaveSoscoModelRequest): Promise<SoscoModelView> {
    return this.models.save(ctx, body);
  }
}
