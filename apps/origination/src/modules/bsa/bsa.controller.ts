import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { BsaLosCreateAnalysisBody, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { BsaService } from './bsa.service';

/**
 * M12c · Gateway: `/api/origination/applications/:applicationId/bsa…`. Унших = `application:read`; шинжилгээ үүсгэх / «Системрүү татах» / төлбөр шинэчлэх = `application:write`
 * (ЗЭЗ өөрийн хүсэлт, ADMIN). Хүрээ (NFR-3) `ApplicationAccessService`-ээр сервис дотор. Шинжилгээний дэлгэцүүд (хуулга, ангилал, сэжигтэй) `/api/scoring/bsa/**`.
 */
@Controller('applications/:applicationId/bsa')
export class BsaController {
  constructor(private readonly bsa: BsaService) {}

  @Permissions('application:read') @Get()
  overview(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) { return this.bsa.overview(ctx, applicationId); }

  @Permissions('application:write') @Post('analyses') @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(BsaLosCreateAnalysisBody)) body: BsaLosCreateAnalysisBody) {
    return this.bsa.createAnalysis(ctx, applicationId, body);
  }

  @Permissions('application:write') @Post('analyses/:analysisId/push') @HttpCode(200)
  push(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('analysisId') analysisId: string) { return this.bsa.push(ctx, applicationId, analysisId); }

  @Permissions('application:write') @Post('sync-payment') @HttpCode(200)
  syncPayment(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) { return this.bsa.syncPayment(ctx, applicationId); }
}
