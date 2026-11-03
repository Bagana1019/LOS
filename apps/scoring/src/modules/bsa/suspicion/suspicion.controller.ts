// M12c REST: сэжигтэй дохио (BSA-FR-5), тайлан (PDF/Excel, BSA-FR-4.7), хүсэлтийн нэгтгэл (BSA-BR-9). Үүрэг, эрх — analyses.controller-тэй ижил.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { BsaCombinedSummary, BsaSuspicionListResponse } from '@los/contracts';
import type { Response } from 'express';
import { Ctx, RequestContextGuard } from '../common/request-context';
import type { RequestContext } from '../common/infra.ports';
import { Roles, RolesGuard, READ_ROLES, WRITE_ONLY_ROLES } from '../import/http/roles';
import { idPipe } from '../import/http/schemas';
import { CombinedService } from '../combined/combined.service';
import { ReportService } from '../report/report.service';
import { SuspicionReviewService, type ResolveResult } from './suspicion-review.service';

@Controller('bsa')
@UseGuards(RequestContextGuard, RolesGuard)
export class BsaSuspicionController {
  constructor(
    @Inject(SuspicionReviewService) private readonly review: SuspicionReviewService,
    @Inject(ReportService) private readonly reports: ReportService,
    @Inject(CombinedService) private readonly combined: CombinedService,
  ) {}

  /** BSA-FR-5.1: 8 дохионы тоолуур + бүлэглэсэн жагсаалт */
  @Get('analyses/:id/suspicions')
  @Roles(...READ_ROLES)
  list(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string, @Query() query: unknown): Promise<BsaSuspicionListResponse> {
    return this.review.list(ctx, id, query as never);
  }

  /** BSA-FR-5.2: нэг/бөөнөөр шийдвэрлэх (APPROVE | RECLASSIFY | EXCLUDE) */
  @Post('analyses/:id/suspicions/resolve')
  @HttpCode(200)
  @Roles(...WRITE_ONLY_ROLES)
  resolve(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string, @Body() body: unknown): Promise<ResolveResult> {
    return this.review.resolve(ctx, id, body as never);
  }

  /** INT-9 / BSA-FR-4.7: PDF тайлан */
  @Get('analyses/:id/report.pdf')
  @Roles(...READ_ROLES)
  async pdf(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string, @Res() res: Response): Promise<void> {
    const f = await this.reports.pdf(ctx, id);
    send(res, f);
  }

  /** BSA-FR-4.7: Орлогын түүвэр (Excel) */
  @Get('analyses/:id/income-sample.xlsx')
  @Roles(...READ_ROLES)
  async xlsx(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string, @Res() res: Response): Promise<void> {
    const f = await this.reports.incomeSample(ctx, id);
    send(res, f);
  }

  /** BSA-BR-9: хүсэлтийн түвшний нэгтгэл */
  @Get('applications/:applicationId/combined')
  @Roles(...READ_ROLES)
  combinedSummary(@Ctx() ctx: RequestContext, @Param('applicationId', idPipe()) applicationId: string): Promise<BsaCombinedSummary> {
    return this.combined.forApplication(ctx, applicationId);
  }
}

function send(res: Response, f: { fileName: string; contentType: string; bytes: Buffer }): void {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Length', String(f.bytes.length));
  res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(f.bytes);
}
