import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ScorePreviewRequest, SelectMethodRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { ScoreService } from './score.service';

/**
 * FR-8 · Gateway: `/api/origination/applications/:applicationId/score…`.
 * Унших/preview = `application:read` (ЗЭЗ өөрийн, салбарын захирал салбарын, батлагч/админ бүгд); тооцоолох/сонгох = `application:write` (зөвхөн өөрийн хүсэлтийн ЗЭЗ).
 * Хүрээ (NFR-3) `ApplicationAccessService`-ээр сервис дотор шалгагдана. Зээлдэгчийн портал (CUSTOMER) эрхгүй.
 */
@Controller('applications/:applicationId/score')
export class ScoreController {
  constructor(private readonly score: ScoreService) {}

  @Permissions('application:read') @Get()
  overview(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) { return this.score.overview(ctx, applicationId); }

  @Permissions('application:read') @Post('preview') @HttpCode(200)
  preview(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(ScorePreviewRequest)) body: ScorePreviewRequest) {
    return this.score.preview(ctx, applicationId, body);
  }

  @Permissions('application:write') @Post('calculate') @HttpCode(200)
  calculate(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) { return this.score.calculate(ctx, applicationId); }

  @Permissions('application:write') @Put('selection')
  select(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(SelectMethodRequest)) body: SelectMethodRequest) {
    return this.score.select(ctx, applicationId, body);
  }
}
