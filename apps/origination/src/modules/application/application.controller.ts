import { Body, Controller, Get, HttpCode, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { ApplicationExportQuery, ApplicationListQuery, CreateApplicationRequest, TransitionRequest, type RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { ApplicationService } from './application.service';
import { DraftArchiveService } from './draft-archive.service';

// docs/01 §3: ЗЭЗ үүсгэж/илгээнэ; салбарын захирал, батлагч унших. Хүрээг ApplicationAccessService / resolveApplicationScope шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const WRITERS = ['OFFICER', 'ADMIN'];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Controller()
export class ApplicationController {
  constructor(private readonly applications: ApplicationService, private readonly archive: DraftArchiveService) {}

  /** FR-1.6: хуучирсан ноорогийг гараар архивлах (sweeper-тэй адил). */
  @Post('applications/archive-stale')
  @Roles('ADMIN')
  @HttpCode(200)
  archiveStale(@Ctx() ctx: RequestContext) {
    return this.archive.archiveStale(ctx.orgId, ctx.userId ?? null);
  }

  @Post('applications')
  @Roles(...WRITERS)
  @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateApplicationRequest)) body: CreateApplicationRequest) {
    return this.applications.create(ctx, body);
  }

  @Get('applications')
  @Roles(...READERS)
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ApplicationListQuery)) query: ApplicationListQuery) {
    return this.applications.list(ctx, query);
  }

  @Get('applications/export')
  @Roles(...READERS)
  async export(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ApplicationExportQuery)) query: ApplicationExportQuery): Promise<StreamableFile> {
    const file = await this.applications.exportXlsx(ctx, query);
    return new StreamableFile(file.buffer, { type: XLSX_MIME, disposition: `attachment; filename="${file.filename}"`, length: file.buffer.length });
  }

  @Get('applications/:applicationId')
  @Roles(...READERS)
  detail(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.applications.detail(ctx, applicationId);
  }

  @Get('applications/:applicationId/history')
  @Roles(...READERS)
  history(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.applications.history(ctx, applicationId);
  }

  @Post('applications/:applicationId/transition')
  @Roles(...WRITERS)
  @HttpCode(200)
  transition(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(TransitionRequest)) body: TransitionRequest) {
    return this.applications.transition(ctx, applicationId, body);
  }
}
