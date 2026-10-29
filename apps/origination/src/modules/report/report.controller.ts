import { Controller, Get, Param, Query, StreamableFile } from '@nestjs/common';
import { DashboardQuery, ReportExportQuery, ReportQuery, type DashboardSummary, type ReportDefinitionView, type ReportResult } from '@los/contracts';
import { Ctx } from '@los/nest-common';
import type { RequestContext } from '@los/contracts';
import { Roles } from '@los/nest-common';
import { ZodValidationPipe } from '@los/nest-common';
import { DashboardService } from './dashboard.service';
import { XLSX_MIME } from './excel.exporter';
import { ReportService } from './report.service';

/**
 * FR-13.3 / NFR-3: ADMIN, APPROVER (бүгд), BRANCH_MANAGER (салбар), OFFICER (өөрийн хариуцсан). CUSTOMER → 403.
 * `reports/dashboard/summary` нь `reports/:key`-ээс өмнө зарлагдсан (зам мөргөлдөхгүй).
 */
@Controller()
@Roles('ADMIN', 'OFFICER', 'BRANCH_MANAGER', 'APPROVER')
export class ReportController {
  constructor(private readonly reports: ReportService, private readonly dashboard: DashboardService) {}

  @Get('reports')
  list(@Ctx() ctx: RequestContext): Promise<ReportDefinitionView[]> { return this.reports.list(ctx); }

  @Get('reports/dashboard/summary')
  summary(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DashboardQuery)) query: DashboardQuery): Promise<DashboardSummary> { return this.dashboard.summary(ctx, query); }

  @Get('reports/:key')
  run(@Ctx() ctx: RequestContext, @Param('key') key: string, @Query(new ZodValidationPipe(ReportQuery)) query: ReportQuery): Promise<ReportResult> { return this.reports.run(ctx, key, query); }

  @Get('reports/:key/export')
  async export(@Ctx() ctx: RequestContext, @Param('key') key: string, @Query(new ZodValidationPipe(ReportExportQuery)) query: ReportExportQuery): Promise<StreamableFile> {
    const file = await this.reports.export(ctx, key, query);
    return new StreamableFile(file.buffer, { type: XLSX_MIME, disposition: `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`, length: file.buffer.length });
  }
}
