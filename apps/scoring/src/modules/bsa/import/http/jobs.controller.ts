// BSA-FR-2.6 «Импорт ажлууд» (docs/02 §2 `/los/bsa/jobs`): бүх шинжилгээний ажил, төлвийн тоолуур, банкаар шүүлт, алдаатайг дахин оруулах.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { BsaJobListQuery, BsaRetryJobRequest } from '@los/contracts';
import { Ctx, RequestContextGuard } from '../../common/request-context';
import type { RequestContext } from '../../common/infra.ports';
import type { ImportJobStatus } from '../../common/persistence';
import { AnalysisService } from '../analysis.service';
import { UploadService } from '../upload.service';
import type { ImportJobView } from '../views';
import { pageRequestOf, toEnvelope, type PageEnvelope } from './page';
import { READ_ROLES, Roles, RolesGuard, WRITE_ONLY_ROLES } from './roles';
import { idPipe, orEmpty } from './schemas';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller('bsa/jobs')
@UseGuards(RequestContextGuard, RolesGuard)
export class BsaJobsController {
  constructor(
    @Inject(AnalysisService) private readonly analysis: AnalysisService,
    @Inject(UploadService) private readonly upload: UploadService,
  ) {}

  /** Эрхийн хүрээн дэх бүх ажил (ЗЭЗ — өөрийн шинжилгээнийх). `counts` нь төлвөөр шүүхээс өмнөх тоолуур */
  @Get()
  @Roles(...READ_ROLES)
  async list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(BsaJobListQuery)) q: BsaJobListQuery,
  ): Promise<PageEnvelope<ImportJobView> & { counts: Record<ImportJobStatus, number> }> {
    const { page, counts } = await this.analysis.listAllJobs(
      ctx,
      { status: q.status, bankCode: q.bank, analysisId: q.analysisId, branchId: q.branchId },
      pageRequestOf(q),
    );
    return { ...toEnvelope(page), counts };
  }

  @Get(':id')
  @Roles(...READ_ROLES)
  get(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string): Promise<ImportJobView> {
    return this.analysis.getJobById(ctx, id);
  }

  /**
   * BSA-FR-2.6 «дахин оруулах»: зөвхөн FAILED ажил (эх файл хадгалагдсан). Банкийг гараар солж болно (`bankCode`; `null` = автоматаар таниулах).
   * 202: дахин дараалалд орсон. DRAFT биш шинжилгээнд 409.
   */
  @Post(':id/retry')
  @HttpCode(202)
  @Roles(...WRITE_ONLY_ROLES)
  async retry(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Body(new ZodValidationPipe(orEmpty(BsaRetryJobRequest))) body: BsaRetryJobRequest,
  ): Promise<ImportJobView> {
    const job = await this.analysis.getJobById(ctx, id); // байгууллага/хандалт: 404 / 403
    return this.upload.retryJob(ctx, job.analysisId, id, body.bankCode === undefined ? {} : { bankCode: body.bankCode });
  }
}
