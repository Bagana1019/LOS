// BSA-FR-1 / FR-4.1 / FR-6.1: шинжилгээ (bsa_analysis) үүсгэх, харах, параметр өөрчлөх, устгах + импорт ажил/гүйлгээ/түүхийг унших туслахууд.
//  - INT-1 / INT-7: (байгууллага, хүсэлт, зээлдэгч) тутамд create() бүр ШИНЭ хувилбар; хамгийн өндөр нь идэвхтэй.
//  - Хандалт: тенант + салбар + үүрэг (access.ts). Өөр байгууллагын шинжилгээ «олдсонгүй» шиг харагдана.
//  - Устгал: зөвхөн DRAFT; DB-ийн commit-ийн ДАРАА object store-оос файлуудыг устгана (commit өмнө устгавал DB буцсан үед файл алдагдана).
import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { BsaCreateAnalysisRequest, BsaUpdateAnalysisParamsRequest, ImportStatus, type BsaAnalysisDetails, type BsaSummary } from '@los/contracts';
import type { z } from 'zod';
import { BSA_SETTINGS, OBJECT_STORE, type BsaSettingsProvider, type ObjectStore, type RequestContext } from '../common/infra.ports';
import {
  BSA_REPOSITORY, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, mergeAccounts, normalizeAccount,
  type BsaAnalysisEventRecord, type BsaAnalysisFilter, type BsaAnalysisPatch, type BsaCustomerSnapshot,
  type BsaDeclaredAccount, type BsaImportJobFilter, type BsaImportJobRecord, type BsaRepository, type BsaTransactionCounts,
  type BsaTransactionFilter, type ImportJobStatus, type Page, type PageRequest,
} from '../common/persistence';
import { analysisListScope, decideAnalysisAccess, REQUEST_CONTEXT_MESSAGES } from '../common/request-context';
import { describeError } from '../common/import-queue';
import { assertRole, loadAnalysis, WRITE_ROLES } from './access';
import { BSA_EVENT } from './import.events';
import { badRequest, conflict, notFound } from './import.errors';
import { parseInput } from './parse-input';
import { defaultPeriodMonths, isAllowedMonths, validExplicitPeriod } from './period';
import { RecalculationService } from './recalculation.service';
import { toAnalysisView, toJobView, toTransactionView, type AnalysisView, type ImportJobView, type TransactionView } from './views';

export interface AnalysisListQuery {
  status?: BsaAnalysisFilter['status'];
  applicationId?: string;
  customerId?: string;
  /** BSA-FR-1.2: регистрээр хайх (hash-аар тулгана) */
  registerNo?: string;
  createdFrom?: Date;
  createdTo?: Date;
  /** ADMIN/APPROVER-д салбараар нарийвчлах (бусдад өөрийн салбар албадан тавигдана) */
  branchId?: string;
}

/** BSA-FR-2.6: бүх шинжилгээний импорт ажлын жагсаалтын шүүлт */
export interface JobListQuery {
  status?: ImportJobStatus[];
  /** BankCode */
  bankCode?: string;
  analysisId?: string;
  /** ADMIN/APPROVER-д салбараар нарийвчлах (бусдад өөрийн салбар албадан тавигдана) */
  branchId?: string;
}

export interface JobListResult {
  page: Page<ImportJobView>;
  /** Төлвөөр шүүхээс ӨМНӨХ тоолуур (нийт / боловсруулж буй / дууссан / алдаатай), банк/шинжилгээний шүүлт хэвээр */
  counts: Record<ImportJobStatus, number>;
}

const emptyCounts = (): Record<ImportJobStatus, number> => Object.fromEntries(ImportStatus.map((s) => [s, 0])) as Record<ImportJobStatus, number>;

/** Нэг дор зэрэг ачаалах шинжилгээний тоо (ЗЭЗ-ийн өөрийн шинжилгээний ажлууд) */
const OFFICER_JOB_FANOUT = 25;

export interface ParamsUpdateResult {
  analysis: AnalysisView;
  /** Тооцоолол хийгдсэн эсэх (хуулга байхгүй бол false) */
  recalculated: boolean;
  summary: BsaSummary | null;
  /** Шинэчлэгдсэн дэлгэрэнгүй тайлан (анхааруулгатай); тооцоолоогүй бол null */
  details: BsaAnalysisDetails | null;
  /** ANALYZED шинжилгээ өөрчлөгдсөн: LOS-д дахин «Системрүү татах» шаардлагатай */
  repushRequired: boolean;
}

const trimOrNull = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

@Injectable()
export class AnalysisService {
  private readonly log = new Logger(AnalysisService.name);

  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
  ) {}

  // ───────────────────────── Үүсгэх ─────────────────────────

  /** INT-1: LOS хүсэлт + зээлдэгчээс шинэ шинжилгээ (хувилбар). OFFICER / BRANCH_MANAGER / ADMIN */
  async create(ctx: RequestContext, raw: z.input<typeof BsaCreateAnalysisRequest>): Promise<AnalysisView> {
    assertRole(ctx, WRITE_ROLES);
    const input = parseInput(BsaCreateAnalysisRequest, raw);
    const isAdmin = ctx.roles.includes('ADMIN');
    // Салбарын захирал/ЗЭЗ зөвхөн өөрийн салбарт үүсгэнэ; салбаргүй ADMIN-аас бусад нь шинжилгээгээ хэзээ ч харж чадахгүй болно
    const branchId = isAdmin ? (input.branchId ?? ctx.branchId) : ctx.branchId;
    if (branchId === null && !isAdmin) throw new ForbiddenException(REQUEST_CONTEXT_MESSAGES.forbidden);

    const settings = await this.settingsProvider.get(ctx.orgId);
    const months = input.periodMonths ?? null;
    const hasRange = input.periodFrom != null && input.periodTo != null;
    if (months !== null && !isAllowedMonths(months, settings)) {
      throw badRequest('PERIOD_NOT_ALLOWED', { allowed: settings.allowedPeriodMonths });
    }
    if (hasRange && !validExplicitPeriod(input.periodFrom ?? null, input.periodTo ?? null)) throw badRequest('INVALID_PERIOD');
    // BSA-BR-3: хугацаа өгөөгүй бол анхдагч сар (тохиргооноос) — хадгалалт «сар» горимд тогтвортой байхын тулд
    const periodMonths = hasRange ? null : (months ?? defaultPeriodMonths(settings));

    const declared: BsaDeclaredAccount[] = input.customer.declaredAccounts.map((d) => ({
      bankCode: d.bankCode ?? null,
      accountNo: normalizeAccount(d.accountNo),
      iban: trimOrNull(d.iban) === null ? null : normalizeAccount(d.iban as string),
      holderName: trimOrNull(d.holderName),
      source: 'MANUAL',
    }));
    const customer: BsaCustomerSnapshot = {
      registerNo: input.customer.registerNo,
      lastName: trimOrNull(input.customer.lastName),
      firstName: trimOrNull(input.customer.firstName),
      phone: trimOrNull(input.customer.phone),
      gender: trimOrNull(input.customer.gender),
      note: trimOrNull(input.customer.note),
      declaredAccounts: declared,
    };
    const ownAccounts = mergeAccounts([], declared.flatMap((d) => [d.accountNo, d.iban ?? '']));

    const created = await this.repo.runInTransaction(async (r) => {
      const record = await r.analyses.create({
        orgId: ctx.orgId,
        branchId,
        applicationId: input.loanApplicationId,
        customerId: input.customerId,
        borrowerId: input.borrowerId ?? null,
        periodFrom: hasRange ? (input.periodFrom as string) : null,
        periodTo: hasRange ? (input.periodTo as string) : null,
        periodMonths,
        proposedMonthlyPayment: input.proposedMonthlyPayment ?? null,
        costOfGoodsRate: input.costOfGoodsRate ?? null,
        customer,
        ownAccounts,
        createdBy: ctx.userId,
      });
      await r.events.append({
        analysisId: record.id,
        action: BSA_EVENT.ANALYSIS_CREATED,
        actorId: ctx.userId,
        detail: { version: record.version, periodMode: hasRange ? 'EXPLICIT' : 'MONTHS', periodMonths, declaredAccounts: declared.length },
      });
      return record;
    });
    return toAnalysisView(created);
  }

  // ───────────────────────── Унших ─────────────────────────

  async get(ctx: RequestContext, analysisId: string): Promise<AnalysisView> {
    return toAnalysisView(await loadAnalysis(this.repo, ctx, analysisId, 'read'));
  }

  /** BSA-FR-6.1: эрхийн хүрээнд жагсаалт (ADMIN/APPROVER — байгууллага, BRANCH_MANAGER — салбар, OFFICER — өөрийн үүсгэсэн) */
  async list(ctx: RequestContext, query: AnalysisListQuery = {}, page?: PageRequest): Promise<Page<AnalysisView>> {
    const scope = analysisListScope(ctx);
    if (scope === null) return { items: [], total: 0, limit: page?.limit ?? DEFAULT_PAGE_SIZE, offset: page?.offset ?? 0 };
    const filter: BsaAnalysisFilter = {
      orgId: scope.orgId,
      branchId: scope.branchId ?? query.branchId,
      createdBy: scope.createdBy,
      status: query.status,
      applicationId: query.applicationId,
      customerId: query.customerId,
      registerNo: query.registerNo,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
    };
    const result = await this.repo.analyses.list(filter, page);
    return { ...result, items: result.items.map(toAnalysisView) };
  }

  /** INT-6 / BSA-BR-9: хүсэлтийн зээлдэгч бүрийн хамгийн сүүлийн хувилбар (зөвхөн хандах эрхтэй нь) */
  async latestForApplication(ctx: RequestContext, applicationId: string): Promise<AnalysisView[]> {
    const all = await this.repo.analyses.listLatestByApplication(ctx.orgId, applicationId);
    return all.filter((a) => decideAnalysisAccess(ctx, a) === 'ALLOW').map(toAnalysisView);
  }

  // ───────────────────────── Параметр ─────────────────────────

  /**
   * INT-6 / BSA-FR-4.1: санал болгосон төлбөр, хугацаа, ББӨ өөрчилнө ⇒ DTI дахин тооцоно (ангилал өөрчлөгдөхгүй тул дахин ангилахгүй).
   * `undefined` = өөрчлөхгүй; `null` = хоослох (төлбөр → тодорхойгүй, ББӨ → тохиргооны анхдагч, хугацаа → анхдагч сар).
   */
  async updateParams(ctx: RequestContext, analysisId: string, raw: z.input<typeof BsaUpdateAnalysisParamsRequest>): Promise<ParamsUpdateResult> {
    const input = parseInput(BsaUpdateAnalysisParamsRequest, raw);
    const existing = await loadAnalysis(this.repo, ctx, analysisId, 'write');
    const settings = await this.settingsProvider.get(existing.orgId);

    const patch: BsaAnalysisPatch = {};
    if (input.proposedMonthlyPayment !== undefined) patch.proposedMonthlyPayment = input.proposedMonthlyPayment;
    if (input.costOfGoodsRate !== undefined) patch.costOfGoodsRate = input.costOfGoodsRate;
    const touchesPeriod = input.periodMonths !== undefined || input.periodFrom !== undefined || input.periodTo !== undefined;
    if (touchesPeriod) {
      const hasRange = input.periodFrom != null && input.periodTo != null;
      if (hasRange) {
        if (!validExplicitPeriod(input.periodFrom ?? null, input.periodTo ?? null)) throw badRequest('INVALID_PERIOD');
        Object.assign(patch, { periodMonths: null, periodFrom: input.periodFrom, periodTo: input.periodTo });
      } else {
        const months = input.periodMonths ?? defaultPeriodMonths(settings);
        if (!isAllowedMonths(months, settings)) throw badRequest('PERIOD_NOT_ALLOWED', { allowed: settings.allowedPeriodMonths });
        // Эдгээр нь тооцооллын үед шинэчлэгдэнэ (resolved хугацаа)
        Object.assign(patch, { periodMonths: months, periodFrom: null, periodTo: null });
      }
    }
    const changed = Object.keys(patch);

    const outcome = await this.repo.runInTransaction(async (r) => {
      const fresh = await loadAnalysis(r, ctx, analysisId, 'write');
      if (changed.length > 0) await r.analyses.update(analysisId, patch, ctx.userId);
      await r.events.append({
        analysisId,
        action: BSA_EVENT.PARAMS_UPDATED,
        actorId: ctx.userId,
        detail: { changed },
      });
      const result = await this.recalc.run(r, { analysisId, actorId: ctx.userId, reason: 'PARAMS_UPDATED', refreshClassification: false });
      return { result, status: fresh.status };
    });
    const after = await loadAnalysis(this.repo, ctx, analysisId, 'read');
    return {
      analysis: toAnalysisView(after),
      recalculated: outcome.result.summary !== null,
      summary: outcome.result.summary,
      details: outcome.result.details,
      repushRequired: outcome.status === 'ANALYZED' && outcome.result.summary !== null,
    };
  }

  // ───────────────────────── Устгах ─────────────────────────

  /** Зөвхөн DRAFT; файл боловсруулагдаж байхад үгүй. Object store-ийн файлууд DB commit-ийн ДАРАА устгагдана */
  async delete(ctx: RequestContext, analysisId: string): Promise<{ deletedObjects: number; failedObjects: number }> {
    const purged = await this.repo.runInTransaction(async (r) => {
      const record = await loadAnalysis(r, ctx, analysisId, 'write');
      if (record.status !== 'DRAFT') throw conflict('ANALYSIS_NOT_DRAFT');
      const busy = await r.importJobs.countByStatus({ analysisId });
      if (busy.PENDING + busy.PROCESSING > 0) throw conflict('JOBS_IN_PROGRESS', { pending: busy.PENDING, processing: busy.PROCESSING });
      return r.retention.purge(analysisId);
    });
    // DB commit хийгдсэн. Устгал амжилтгүй бол объект «өнчин» үлдэнэ (PII-тэй файл): лог дээр тоо л бичигдэнэ, түлхүүр бичихгүй
    let failed = 0;
    for (const key of purged.objectKeys) {
      try {
        await this.store.delete(key);
      } catch (e) {
        failed++;
        this.log.warn(`object delete failed after analysis purge (${describeError(e)})`);
      }
    }
    return { deletedObjects: purged.objectKeys.length - failed, failedObjects: failed };
  }

  // ───────────────────────── Унших туслахууд (импорт ажил, гүйлгээ, түүх) ─────────────────────────

  /** BSA-FR-2.6 «Импорт ажлууд» */
  async listJobs(ctx: RequestContext, analysisId: string, status?: ImportJobStatus | ImportJobStatus[], page?: PageRequest): Promise<Page<ImportJobView>> {
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const filter: BsaImportJobFilter = { orgId: ctx.orgId, analysisId, status };
    const result = await this.repo.importJobs.list(filter, page);
    return { ...result, items: result.items.map(toJobView) };
  }

  async getJob(ctx: RequestContext, analysisId: string, jobId: string): Promise<ImportJobView> {
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const job = await this.repo.importJobs.getById(jobId, { orgId: ctx.orgId });
    // Өөр шинжилгээний ажлыг харуулахгүй (analysisId таарахгүй ⇒ олдсонгүй)
    if (!job || job.analysisId !== analysisId) throw notFound('JOB_NOT_FOUND');
    return toJobView(job);
  }

  /** Ажлыг id-аар (шинжилгээ мэдэхгүйгээр): `GET /bsa/jobs/:id`, `POST /bsa/jobs/:id/retry`. Хандалтыг шинжилгээгээр шалгана */
  async getJobById(ctx: RequestContext, jobId: string): Promise<ImportJobView> {
    const job = await this.repo.importJobs.getById(jobId, { orgId: ctx.orgId });
    if (!job) throw notFound('JOB_NOT_FOUND');
    await loadAnalysis(this.repo, ctx, job.analysisId, 'read');
    return toJobView(job);
  }

  /**
   * BSA-FR-2.6 «Импорт ажлууд» дэлгэц: эрхийн хүрээн дэх БҮХ шинжилгээний ажил + төлвийн тоолуур.
   *  - ADMIN/APPROVER — байгууллага, BRANCH_MANAGER — өөрийн салбар (repo-гийн шүүлтээр).
   *  - OFFICER — өөрийн салбар БА өөрийн үүсгэсэн шинжилгээнүүд. Ажлын шүүлтэд «шинжилгээний үүсгэгч» байхгүй тул өөрийн шинжилгээ бүрийн
   *    ажлыг ачаалж нэгтгэнэ (ЗЭЗ-ийн шинжилгээний тоо бага); хуудаслалт, тоолуурыг санах ойд тооцно.
   */
  async listAllJobs(ctx: RequestContext, query: JobListQuery = {}, page?: PageRequest): Promise<JobListResult> {
    const limit = Math.min(Math.max(page?.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(page?.offset ?? 0, 0);
    const empty = (): JobListResult => ({ page: { items: [], total: 0, limit, offset }, counts: emptyCounts() });

    if (query.analysisId !== undefined) {
      await loadAnalysis(this.repo, ctx, query.analysisId, 'read'); // өөр байгууллага ⇒ NotFound, эрхгүй ⇒ Forbidden
      return this.queryJobs({ orgId: ctx.orgId, analysisId: query.analysisId, bankCode: query.bankCode }, query.status, { limit, offset });
    }
    const scope = analysisListScope(ctx);
    if (scope === null) return empty();
    if (scope.createdBy === undefined) {
      const branchId = scope.branchId ?? query.branchId;
      return this.queryJobs({ orgId: scope.orgId, branchId, bankCode: query.bankCode }, query.status, { limit, offset });
    }
    return this.officerJobs({ orgId: scope.orgId, branchId: scope.branchId, createdBy: scope.createdBy }, query, { limit, offset });
  }

  private async queryJobs(
    base: Omit<BsaImportJobFilter, 'status'>,
    status: ImportJobStatus[] | undefined,
    page: Required<PageRequest>,
  ): Promise<JobListResult> {
    const [result, counts] = await Promise.all([
      this.repo.importJobs.list({ ...base, ...(status && status.length > 0 ? { status } : {}) }, page),
      this.repo.importJobs.countByStatus(base),
    ]);
    return { page: { ...result, items: result.items.map(toJobView) }, counts };
  }

  private async officerJobs(
    scope: { orgId: string; branchId?: string; createdBy: string },
    query: JobListQuery,
    page: Required<PageRequest>,
  ): Promise<JobListResult> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const batch = await this.repo.analyses.list({ orgId: scope.orgId, branchId: scope.branchId, createdBy: scope.createdBy }, { limit: MAX_PAGE_SIZE, offset });
      ids.push(...batch.items.map((a) => a.id));
      if (batch.items.length === 0 || offset + batch.items.length >= batch.total) break;
    }
    const jobs: BsaImportJobRecord[] = [];
    for (let i = 0; i < ids.length; i += OFFICER_JOB_FANOUT) {
      const parts = await Promise.all(
        ids.slice(i, i + OFFICER_JOB_FANOUT).map((analysisId) =>
          this.repo.importJobs.list({ orgId: scope.orgId, analysisId, bankCode: query.bankCode }, { limit: MAX_PAGE_SIZE, offset: 0 }),
        ),
      );
      for (const part of parts) jobs.push(...part.items);
    }
    const counts = emptyCounts();
    for (const j of jobs) counts[j.status] += 1;
    const wanted = query.status && query.status.length > 0 ? new Set<ImportJobStatus>(query.status) : null;
    const matching = jobs
      .filter((j) => wanted === null || wanted.has(j.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return {
      page: { items: matching.slice(page.offset, page.offset + page.limit).map(toJobView), total: matching.length, limit: page.limit, offset: page.offset },
      counts,
    };
  }

  async jobCounts(ctx: RequestContext, analysisId: string): Promise<Record<ImportJobStatus, number>> {
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    return this.repo.importJobs.countByStatus({ orgId: ctx.orgId, analysisId });
  }

  /** BSA-FR-4.6: шүүлттэй гүйлгээний жагсаалт. Дотоод hash түлхүүрүүдийг гаргахгүй */
  async listTransactions(ctx: RequestContext, analysisId: string, filter: Omit<BsaTransactionFilter, 'analysisId'> = {}, page?: PageRequest): Promise<Page<TransactionView>> {
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const result = await this.repo.transactions.list({ ...filter, analysisId }, page);
    return { ...result, items: result.items.map(toTransactionView) };
  }

  async transactionCounts(ctx: RequestContext, analysisId: string): Promise<BsaTransactionCounts> {
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    return this.repo.transactions.counts(analysisId);
  }

  /** NFR-4: өөрчлөлтийн түүх (шинэ нь түрүүлж) */
  async listEvents(ctx: RequestContext, analysisId: string, page?: PageRequest): Promise<Page<BsaAnalysisEventRecord>> {
    await loadAnalysis(this.repo, ctx, analysisId, 'read');
    return this.repo.events.list(analysisId, page);
  }
}
