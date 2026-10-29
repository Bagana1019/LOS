// BSA шинжилгээний REST (docs/02 §2 дэлгэцүүд, §7 INT-1/4/5/6). Угтвар `/api` (main.ts / configureBsaApp). Авторизаци gateway-д; энд толгой
// (X-User-Id, X-Roles, X-Branch-Id, X-Org-Id, X-Correlation-Id) → RequestContext (RequestContextGuard), маршрутын үүрэг (RolesGuard), харин
// тенант / салбар / эзэмшигчийн хүрээг service шийднэ (өөр байгууллага ⇒ 404, өөр салбар / өөр ЗЭЗ ⇒ 403).
// Маршрут бүрийн үүрэг: README.md «Маршрут ба үүргийн хүснэгт».
import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {
  BsaAnalysisImportsQuery, BsaAnalysisListQuery, BsaBreakdownQuery, BsaCreateAnalysisRequest, BsaHistoryQuery, BsaReclassifyRequest,
  BsaRecalculateRequest, BsaTransactionListQuery, BsaUploadFields,
  type BsaReclassifyResponse, type BsaSummary,
} from '@los/contracts';
import type { Response } from 'express';
import { Ctx, RequestContextGuard } from '../../common/request-context';
import type { RequestContext } from '../../common/infra.ports';
import type { BsaAnalysisEventRecord, BsaTransactionFilter, ImportJobStatus } from '../../common/persistence';
import { AnalysisService, type ParamsUpdateResult } from '../analysis.service';
import { FinalizeService, type FinalizeResult, type ScoringPreview } from '../finalize.service';
import { notFound, unprocessable } from '../import.errors';
import { RecalculationService } from '../recalculation.service';
import { ReclassifyService } from '../reclassify.service';
import { UploadService, type UploadResult } from '../upload.service';
import { toAnalysisView, type AnalysisView, type ImportJobView, type TransactionView } from '../views';
import { buildBreakdown, buildOverview, type AnalysisOverview, type Breakdown } from './overview';
import { endExclusiveUtc, pageRequestOf, startOfDayUtc, toEnvelope, type PageEnvelope } from './page';
import { READ_ROLES, Roles, RolesGuard, WRITE_ONLY_ROLES } from './roles';
import { idPipe, orEmpty } from './schemas';
import { toUploadInputs, assertSomethingHandled, type UploadedPart } from './upload-request';
import { BsaUploadInterceptor } from './upload.interceptor';
import { ZodValidationPipe } from './zod-validation.pipe';

/** Тойм дэлгэцэд харуулах импорт ажил / түүхийн дээд тоо (бүтэн жагсаалт: /imports, /history) */
const OVERVIEW_JOBS_LIMIT = 200;
const OVERVIEW_HISTORY_LIMIT = 50;

type RecalculateResponse = Omit<ParamsUpdateResult, 'analysis'> & { analysis: Omit<AnalysisView, 'summary'>; reclassified: number | null };

@Controller('bsa/analyses')
@UseGuards(RequestContextGuard, RolesGuard)
export class BsaAnalysesController {
  constructor(
    @Inject(AnalysisService) private readonly analysis: AnalysisService,
    @Inject(UploadService) private readonly upload: UploadService,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
    @Inject(ReclassifyService) private readonly reclassify: ReclassifyService,
    @Inject(FinalizeService) private readonly finalizer: FinalizeService,
  ) {}

  // ───────────────────────── Шинжилгээ: үүсгэх / жагсаалт / тойм / устгах ─────────────────────────

  /** INT-1, BSA-FR-1: LOS хүсэлт + зээлдэгчээс шинэ шинжилгээ (хувилбар) */
  @Post()
  @HttpCode(201)
  @Roles(...WRITE_ONLY_ROLES)
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(BsaCreateAnalysisRequest)) body: BsaCreateAnalysisRequest): Promise<AnalysisView> {
    return this.analysis.create(ctx, body);
  }

  /** BSA-FR-6.1: жагсаалт. Хүрээ нь үүргээр (ADMIN/APPROVER — байгууллага; BRANCH_MANAGER — салбар; OFFICER — өөрийн) */
  @Get()
  @Roles(...READ_ROLES)
  async list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(BsaAnalysisListQuery)) q: BsaAnalysisListQuery,
  ): Promise<PageEnvelope<AnalysisView>> {
    const page = await this.analysis.list(
      ctx,
      {
        status: q.status,
        applicationId: q.applicationId,
        customerId: q.customerId,
        registerNo: q.registerNo,
        branchId: q.branchId,
        createdFrom: q.createdFrom ? startOfDayUtc(q.createdFrom) : undefined,
        createdTo: q.createdTo ? endExclusiveUtc(q.createdTo) : undefined,
      },
      pageRequestOf(q),
    );
    return toEnvelope(page);
  }

  /** docs/02 §2 «Шинжилгээ — тойм»: мета + хураангуй + дэлгэрэнгүй + импорт ажлууд + түүх + анхааруулга */
  @Get(':id')
  @Roles(...READ_ROLES)
  async overview(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string): Promise<AnalysisOverview> {
    const analysis = await this.analysis.get(ctx, id); // хандалтыг эхлээд шалгана (дараагийн дуудлагууд ижил шийдвэр гаргана)
    const [report, jobs, jobCounts, history, transactions] = await Promise.all([
      this.recalc.report(ctx, id),
      this.analysis.listJobs(ctx, id, undefined, { limit: OVERVIEW_JOBS_LIMIT, offset: 0 }),
      this.analysis.jobCounts(ctx, id),
      this.analysis.listEvents(ctx, id, { limit: OVERVIEW_HISTORY_LIMIT, offset: 0 }),
      this.analysis.transactionCounts(ctx, id),
    ]);
    return buildOverview({
      analysis,
      report,
      jobs: { items: jobs.items, total: jobs.total, counts: jobCounts },
      history: { items: history.items, total: history.total },
      transactions,
    });
  }

  /** Зөвхөн DRAFT. Файлууд DB-ийн commit-ийн дараа object store-оос устна */
  @Delete(':id')
  @Roles(...WRITE_ONLY_ROLES)
  remove(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string): Promise<{ deletedObjects: number; failedObjects: number }> {
    return this.analysis.delete(ctx, id);
  }

  /** NFR-4: өөрчлөлтийн түүх (шинэ нь түрүүлж) */
  @Get(':id/history')
  @Roles(...READ_ROLES)
  async history(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Query(new ZodValidationPipe(BsaHistoryQuery)) q: BsaHistoryQuery,
  ): Promise<PageEnvelope<BsaAnalysisEventRecord>> {
    return toEnvelope(await this.analysis.listEvents(ctx, id, { limit: q.limit, offset: q.offset }));
  }

  // ───────────────────────── Импорт ─────────────────────────

  /**
   * BSA-FR-2.1: multipart `files` (олон файл) + заавал биш `banks` (JSON: файл бүрийн банк). Файл бүр бие даан шийдэгдэнэ (outcomes).
   * 202: нэг ч файл дараалалд орсон · 200: бүгд давхардсан · бүгд татгалзагдсан бол 415 / 413 / 400 / 503 (details.outcomes-той).
   */
  @Post(':id/imports')
  @Roles(...WRITE_ONLY_ROLES)
  @UseInterceptors(BsaUploadInterceptor)
  async uploadFiles(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @UploadedFiles() files: UploadedPart[] | undefined,
    @Body(new ZodValidationPipe(BsaUploadFields)) fields: BsaUploadFields,
    @Res() res: Response,
  ): Promise<void> {
    const parts = files ?? [];
    const result: UploadResult = await this.upload.upload(ctx, id, toUploadInputs(parts, fields.banks));
    assertSomethingHandled(result);
    res.status(result.accepted > 0 ? 202 : 200).json(result);
  }

  /** BSA-FR-2.6: тухайн шинжилгээний импорт ажлууд + төлвийн тоолуур */
  @Get(':id/imports')
  @Roles(...READ_ROLES)
  async imports(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Query(new ZodValidationPipe(BsaAnalysisImportsQuery)) q: BsaAnalysisImportsQuery,
  ): Promise<PageEnvelope<ImportJobView> & { counts: Record<ImportJobStatus, number> }> {
    const [page, counts] = await Promise.all([this.analysis.listJobs(ctx, id, q.status, pageRequestOf(q)), this.analysis.jobCounts(ctx, id)]);
    return { ...toEnvelope(page), counts };
  }

  // ───────────────────────── Тооцоолол ─────────────────────────

  /**
   * INT-6, BSA-FR-4.1: параметр (санал болгосон төлбөр, хугацаа, ББӨ) өгвөл өөрчлөөд DTI-г дахин бодно (`null` = анхдагч руу).
   * Бие хоосон бол ангиллыг ч дахин хийж БҮГДИЙГ дахин тооцно («Дахин тооцоолох» товч). ANALYZED шинжилгээнд `repushRequired`.
   */
  @Post(':id/recalculate')
  @HttpCode(200)
  @Roles(...WRITE_ONLY_ROLES)
  async recalculate(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Body(new ZodValidationPipe(orEmpty(BsaRecalculateRequest))) body: BsaRecalculateRequest,
  ): Promise<RecalculateResponse> {
    const hasParams = Object.values(body).some((v) => v !== undefined);
    if (hasParams) {
      const { analysis, ...rest } = await this.analysis.updateParams(ctx, id, body);
      const { summary: _stored, ...meta } = analysis;
      return { ...rest, analysis: meta, reclassified: null };
    }
    const result = await this.recalc.recalculate(ctx, id);
    const { summary: _stored, ...meta } = toAnalysisView(result.analysis);
    return {
      analysis: meta,
      recalculated: result.summary !== null,
      summary: result.summary,
      details: result.details,
      repushRequired: result.analysis.status === 'ANALYZED' && result.summary !== null,
      reclassified: result.reclassified,
    };
  }

  /** BSA-FR-4.6: шүүлттэй гүйлгээний жагсаалт (эрэмбэ, хуудаслалт) */
  @Get(':id/transactions')
  @Roles(...READ_ROLES)
  async transactions(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Query(new ZodValidationPipe(BsaTransactionListQuery)) q: BsaTransactionListQuery,
  ): Promise<PageEnvelope<TransactionView>> {
    const filter: Omit<BsaTransactionFilter, 'analysisId'> = {
      importJobId: q.importJobId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      direction: q.direction,
      categoryCodes: q.category,
      channel: q.channel,
      ownTransfer: q.ownTransfer,
      manualOverride: q.manualOverride,
      amountMin: q.amountMin,
      amountMax: q.amountMax,
      text: q.text,
      sort: q.sort,
    };
    return toEnvelope(await this.analysis.listTransactions(ctx, id, filter, { limit: q.limit, offset: q.offset }));
  }

  /** BSA-FR-4.3 / 4.4: орлого / зарлагын ангиллын задаргаа + тооцооллын аргачлал (алхам бүр) */
  @Get(':id/breakdown')
  @Roles(...READ_ROLES)
  async breakdown(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Query(new ZodValidationPipe(BsaBreakdownQuery)) q: BsaBreakdownQuery,
  ): Promise<Breakdown> {
    const report = await this.recalc.report(ctx, id);
    if (report.details === null) throw unprocessable('NO_TRANSACTIONS');
    return buildBreakdown(report.details, report.summaryStale, q.includeEmpty);
  }

  /**
   * BSA-FR-3.3: гараар ангилал солих (+ «ижил утгатай бүгдэд»). Хадгалаад дахин тооцоолно. `suggestedRule` (BSA-FR-3.4) ХАДГАЛАГДААГҮЙ:
   * админ хянаад POST /bsa/rules-оор баталгаажуулна.
   */
  @Post(':id/reclassify')
  @HttpCode(200)
  @Roles(...WRITE_ONLY_ROLES)
  reclassifyTransactions(
    @Ctx() ctx: RequestContext,
    @Param('id', idPipe()) id: string,
    @Body(new ZodValidationPipe(BsaReclassifyRequest.strict())) body: BsaReclassifyRequest,
  ): Promise<BsaReclassifyResponse> {
    return this.reclassify.reclassify(ctx, id, body);
  }

  // ───────────────────────── LOS руу дамжуулах (INT-4 / INT-5) ─────────────────────────

  /** «Системрүү татах»: ANALYZED болгож INT-4 хураангуйг буцаана. Дахин татаж болно (`firstTime: false`) */
  @Post(':id/finalize')
  @HttpCode(200)
  @Roles(...WRITE_ONLY_ROLES)
  finalize(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string): Promise<FinalizeResult> {
    return this.finalizer.finalize(ctx, id);
  }

  /** Хадгалагдсан INT-4 хураангуй (хоосон бол 404 SUMMARY_NOT_AVAILABLE) */
  @Get(':id/summary')
  @Roles(...READ_ROLES)
  async summary(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string): Promise<BsaSummary> {
    const { summary } = await this.analysis.get(ctx, id);
    if (summary === null) throw notFound('SUMMARY_NOT_AVAILABLE');
    return summary;
  }

  /** INT-5: Тооцоолол / Sosco Score-д өгөх `BsaScoringInput` + `toScoringPatch` урьдчилан харах. Зөвхөн ANALYZED (эс бол 409 NOT_ANALYZED) */
  @Get(':id/scoring-input')
  @Roles(...READ_ROLES)
  scoringInput(@Ctx() ctx: RequestContext, @Param('id', idPipe()) id: string): Promise<ScoringPreview> {
    return this.finalizer.scoringPreview(ctx, id);
  }
}
