// BSA-FR-4.1 / 4.2 / 4.3 / 2.4 / 3.6: шинжилгээний БҮХ гүйлгээг (хуулга бүрийн нэгдэл) дахин ангилж, хугацааг тодорхойлж, DTI-г тооцоод
// INT-4 `BsaSummary`-г хадгална. Импорт, reclassify, параметр өөрчлөлт, finalize бүгд энэ ЦӨМ дээр тулна.
//
// Дүрэм:
//  - `run(repo, …)` нь өгөгдсөн repo-оор ажиллана (дуудагчийн transaction-д нэгдэнэ). Transaction дотроос ЗААВАЛ `r`-ийг дамжуулна:
//    root repo-гийн runInTransaction-ийг дотроос нь дуудвал өөрөө өөрийгөө хүлээж гацна (in-memory), эсвэл тусдаа transaction нээнэ (Prisma).
//  - Гар засвартай (manualOverride) мөрийг автомат ангилал хэзээ ч өөрчлөхгүй (BSA-FR-3.3).
//  - Хугацаа: period.ts (BSA-BR-3). Хамрах хугацаа = COMPLETED хуулгуудын нэгдэл; хуулгаас хэтрэхгүй (богиносгож анхааруулна).
//  - `details` (дэлгэрэнгүй тайлан) хадгалагдахгүй: persistence summary_json нь INT-4 `BsaSummary` схемээр шалгагддаг тул нэмэлт түлхүүр
//    хасагдана. `report()` дуудах бүрт хадгалсан гүйлгээнээс шууд тооцоолно (тодорхой, deterministic).
import { Inject, Injectable } from '@nestjs/common';
import type { BsaDtiResult } from '@los/calc';
import type { BsaAnalysisDetails, BsaAnalysisWarning, BsaScoringInput, BsaSummary } from '@los/contracts';
import { analyzeCoverage, type StatementPeriod } from '../parsers';
import {
  ClassifierConfigError, ClassifierService, assertSystemCategories, SYSTEM_CATEGORY,
  type BsaCategoryDef, type ClassifiableTxn, type ClassificationResult, type ClassifiedTxn, type OtherShareReport,
} from '../classify';
import { BsaAggregationError, DtiAnalysisService, buildBsaSummary, buildScoringInput, toDtiParams, type DtiAnalysisResult } from '../dti';
import { BSA_SETTINGS, type BsaSettings, type BsaSettingsProvider, type RequestContext } from '../common/infra.ports';
import {
  BSA_REPOSITORY, MAX_PAGE_SIZE,
  type BsaAnalysisRecord, type BsaImportJobRecord, type BsaRepository, type BsaTransactionRecord, type ClassificationUpdate,
} from '../common/persistence';
import { loadAnalysis } from './access';
import { sameJson } from './canonical-json';
import { BSA_CLOCK, type Clock } from './import.defaults';
import { BSA_EVENT } from './import.events';
import { badRequest, unprocessable } from './import.errors';
import { defaultPeriodMonths, resolvePeriod, windowStart, type DateSpan, type ResolvedPeriod } from './period';
import { SUSPICION_COUNTER, type SuspicionCounter } from './suspicion.counter';
import { analysisNotFound } from '../common/request-context';

export interface RecalcOptions {
  analysisId: string;
  actorId: string | null;
  /** Түүхэнд бичигдэх шалтгаан (код) */
  reason: string;
  /** true: гар засваргүй БҮХ мөрийг дахин ангилна (импорт, дүрмийн өөрчлөлт). false: хадгалсан ангилалаар л тооцно */
  refreshClassification: boolean;
}

export interface RecalculationResult {
  analysis: BsaAnalysisRecord;
  /** null: тооцоолох өгөгдөл алга (COMPLETED импорт/гүйлгээ байхгүй) */
  summary: BsaSummary | null;
  details: BsaAnalysisDetails | null;
  /** Ангилал нь өөрчлөгдсөн мөрийн тоо */
  reclassified: number;
}

export interface ReportResult {
  /** Хадгалсан гүйлгээнээс одоо тооцсон INT-4 хураангуй */
  summary: BsaSummary | null;
  details: BsaAnalysisDetails | null;
  /** Хадгалагдсан summary-аас өөр (параметр/дүрэм өөрчлөгдсөн ч дахин тооцоогүй) */
  summaryStale: boolean;
}

interface Loaded {
  analysis: BsaAnalysisRecord;
  settings: BsaSettings;
  categories: BsaCategoryDef[];
  rules: Awaited<ReturnType<BsaRepository['config']['listRules']>>;
  txns: BsaTransactionRecord[];
  jobs: BsaImportJobRecord[];
}

interface Computed {
  dtiResult: BsaDtiResult;
  transactionCount: number;
  pending: number;
  summary: BsaSummary;
  details: BsaAnalysisDetails;
  period: ResolvedPeriod;
  analysisPatch: { periodFrom?: string; periodTo?: string; periodMonths?: number };
  counts: { inPeriod: number; outOfPeriod: number; ownTransfers: number };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (share: number): string => `${Math.round(share * 1000) / 10}%`;

/** classifier-т өгөх нэрсийн хувилбарууд (Голомт: утганд нэр). PII — лог/event-д бичихгүй */
export function customerNameVariants(analysis: BsaAnalysisRecord, jobs: readonly BsaImportJobRecord[]): string[] {
  const c = analysis.customer;
  const names = new Set<string>();
  const add = (v: string | null | undefined): void => {
    const t = v?.replace(/\s+/g, ' ').trim();
    if (t) names.add(t);
  };
  if (c) {
    add([c.lastName, c.firstName].filter(Boolean).join(' '));
    add([c.firstName, c.lastName].filter(Boolean).join(' '));
    for (const d of c.declaredAccounts) add(d.holderName);
  }
  // Verifier-ээр харилцагчтай таарсан (verifierOk) хуулгын эзэмшигчийн нэр = харилцагчийн нэр
  for (const j of jobs) if (j.status === 'COMPLETED') add(j.holderName);
  return [...names];
}

@Injectable()
export class RecalculationService {
  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
    @Inject(ClassifierService) private readonly classifier: ClassifierService,
    @Inject(DtiAnalysisService) private readonly dti: DtiAnalysisService,
    @Inject(SUSPICION_COUNTER) private readonly suspicion: SuspicionCounter,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────────────────── Public API ─────────────────────────

  /** BSA-FR-4.1 «Дахин тооцоолох»: эрх шалгаад (бичих) өөрийн transaction-д дахин ангилж тооцоолно */
  async recalculate(ctx: RequestContext, analysisId: string): Promise<RecalculationResult> {
    return this.repo.runInTransaction(async (r) => {
      await loadAnalysis(r, ctx, analysisId, 'write');
      return this.run(r, { analysisId, actorId: ctx.userId, reason: 'MANUAL', refreshClassification: true });
    });
  }

  /** BSA-FR-4.2/4.3: дэлгэрэнгүй тайлан (хадгалахгүй, ямар ч өөрчлөлтгүй). Унших эрх хангалттай */
  async report(ctx: RequestContext, analysisId: string): Promise<ReportResult> {
    const analysis = await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const loaded = await this.load(this.repo, analysis);
    const computed = await this.computeFromLoaded(loaded, this.storedResults(loaded));
    if (computed === null) return { summary: null, details: null, summaryStale: analysis.summary !== null };
    // jsonb түлхүүрийн дарааллыг хадгалдаггүй ⇒ дарааллаас үл хамаарах харьцуулалт (canonical-json.ts)
    const stale = analysis.summary === null || !sameJson(analysis.summary, computed.summary);
    return { summary: computed.summary, details: computed.details, summaryStale: stale };
  }

  /**
   * INT-5: Тооцоолол / Sosco Score-д өгөх оролт. Хадгалсан ангиллаар шинээр тооцно (хадгалахгүй). `householdExpenseMonthly` нь INT-4
   * `BsaSummary`-д байхгүй тул энд DTI үр дүнгээс шууд гарна. Өгөгдөл байхгүй бол null.
   */
  async scoringInput(ctx: RequestContext, analysisId: string): Promise<BsaScoringInput | null> {
    const analysis = await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const loaded = await this.load(this.repo, analysis);
    const computed = await this.computeFromLoaded(loaded, this.storedResults(loaded));
    if (computed === null) return null;
    return buildScoringInput({
      analysis: {
        analysisId: analysis.id,
        loanApplicationId: analysis.applicationId,
        borrowerId: analysis.borrowerId ?? analysis.customerId,
        status: analysis.status,
        version: analysis.version,
        periodFrom: computed.period.from,
        periodTo: computed.period.to,
      },
      dtiResult: computed.dtiResult,
      transactionCount: computed.transactionCount,
      pendingSuspiciousCount: computed.pending,
      reportPdfUrl: null,
    });
  }

  /**
   * Цөм. Дуудагч эрхийг өмнө нь шалгасан байх ёстой. `repo` нь дуудагчийн transaction-ийн repo байх ёстой (дотроос root repo дуудахгүй).
   * Өгөгдөл байхгүй бол юу ч бичихгүй, summary = null.
   */
  async run(repo: BsaRepository, opts: RecalcOptions): Promise<RecalculationResult> {
    const analysis = await repo.analyses.getById(opts.analysisId);
    if (!analysis) throw analysisNotFound();
    const loaded = await this.load(repo, analysis);

    let results: ClassifiedTxn[];
    let reclassified = 0;
    if (opts.refreshClassification) {
      const refreshed = this.classifyAll(loaded);
      reclassified = refreshed.updates.length;
      if (refreshed.updates.length > 0) await repo.transactions.updateClassifications(analysis.id, refreshed.updates, opts.actorId);
      results = refreshed.results;
    } else {
      results = this.storedResults(loaded);
    }

    const computed = await this.computeFromLoaded(loaded, results);
    if (computed === null) return { analysis, summary: null, details: null, reclassified };

    const updated = await repo.analyses.update(
      analysis.id,
      { summary: computed.summary, ...computed.analysisPatch },
      opts.actorId,
    );
    await repo.events.append({
      analysisId: analysis.id,
      action: BSA_EVENT.RECALCULATED,
      actorId: opts.actorId,
      at: this.clock.now(),
      detail: {
        reason: opts.reason,
        transactions: loaded.txns.length,
        inPeriod: computed.counts.inPeriod,
        outOfPeriod: computed.counts.outOfPeriod,
        ownTransfers: computed.counts.ownTransfers,
        reclassified,
        periodMonths: computed.period.months,
        periodMode: computed.period.mode,
        dtiPercent: computed.summary.dtiPercent,
        dtiLevel: computed.summary.dtiLevel,
        warnings: computed.details.warnings.map((w) => w.code),
      },
    });
    return { analysis: updated, summary: computed.summary, details: computed.details, reclassified };
  }

  // ───────────────────────── Ачаалалт ─────────────────────────

  private async load(repo: BsaRepository, analysis: BsaAnalysisRecord): Promise<Loaded> {
    const settings = await this.settingsProvider.get(analysis.orgId);
    const [categories, rules, txns, jobs] = await Promise.all([
      repo.config.listCategories(analysis.orgId),
      repo.config.listRules(analysis.orgId),
      repo.transactions.loadAll(analysis.id),
      this.loadJobs(repo, analysis.id),
    ]);
    try {
      assertSystemCategories(categories);
    } catch (e) {
      if (e instanceof ClassifierConfigError) throw unprocessable('CATALOG_INCOMPLETE');
      throw e;
    }
    return { analysis, settings, categories, rules, txns, jobs };
  }

  private async loadJobs(repo: BsaRepository, analysisId: string): Promise<BsaImportJobRecord[]> {
    const all: BsaImportJobRecord[] = [];
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const page = await repo.importJobs.list({ analysisId }, { limit: MAX_PAGE_SIZE, offset });
      all.push(...page.items);
      if (offset + page.items.length >= page.total || page.items.length === 0) break;
    }
    return all;
  }

  // ───────────────────────── Ангилал ─────────────────────────

  private toClassifiable(loaded: Loaded): ClassifiableTxn[] {
    const bankOf = new Map(loaded.jobs.map((j) => [j.id, j.bankCode]));
    return loaded.txns.map((t) => ({
      key: t.id,
      statementKey: t.statementKey,
      bank: bankOf.get(t.importJobId) ?? null,
      txnDate: t.txnDate,
      txnTime: t.txnTime,
      direction: t.direction,
      amount: t.amount,
      description: t.description,
      counterpartyAccount: t.counterpartyAccount,
      counterpartyName: t.counterpartyName,
      manualCategoryCode: t.manualOverride ? t.categoryCode : null,
    }));
  }

  /** Гар засваргүй мөр бүрийг дахин ангилж, өөрчлөгдсөнийг л хадгалахад бэлтгэнэ */
  private classifyAll(loaded: Loaded): { results: ClassifiedTxn[]; updates: ClassificationUpdate[] } {
    const txns = this.toClassifiable(loaded);
    const fresh = this.classifier.classify(txns, {
      categories: loaded.categories,
      rules: loaded.rules,
      ownAccounts: loaded.analysis.ownAccounts,
      customerNames: customerNameVariants(loaded.analysis, loaded.jobs),
    });
    const updates: ClassificationUpdate[] = [];
    const results: ClassifiedTxn[] = txns.map((txn, i) => {
      const stored = loaded.txns[i];
      if (stored.manualOverride) return { txn, result: this.resultOf(stored, loaded.categories) };
      const r = fresh[i];
      const changed =
        stored.categoryCode !== r.categoryCode || stored.categoryGroup !== r.categoryGroup || stored.channel !== r.channel
        || stored.isOwnTransfer !== r.isOwnTransfer || round2(stored.confidence) !== round2(r.confidence);
      if (changed) {
        updates.push({ id: stored.id, categoryCode: r.categoryCode, categoryGroup: r.categoryGroup, confidence: r.confidence, channel: r.channel, isOwnTransfer: r.isOwnTransfer });
      }
      return { txn, result: r };
    });
    return { results, updates };
  }

  /** Хадгалсан ангиллаас ClassifiedTxn (ангилаагүй мөр = «Бусад») */
  private storedResults(loaded: Loaded): ClassifiedTxn[] {
    const txns = this.toClassifiable(loaded);
    return txns.map((txn, i) => ({ txn, result: this.resultOf(loaded.txns[i], loaded.categories) }));
  }

  private resultOf(t: BsaTransactionRecord, categories: readonly BsaCategoryDef[]): ClassificationResult {
    const fallback = t.direction === 'INCOME' ? SYSTEM_CATEGORY.OTHER_INCOME : SYSTEM_CATEGORY.OTHER_EXPENSE;
    const code = t.categoryCode ?? fallback;
    const group = t.categoryGroup ?? categories.find((c) => c.code === code)?.groupCode ?? '?';
    return { key: t.id, categoryCode: code, categoryGroup: group, confidence: t.confidence, channel: t.channel, isOwnTransfer: t.isOwnTransfer, reason: 'stored' };
  }

  // ───────────────────────── Тооцоолол ─────────────────────────

  private coveragePeriods(loaded: Loaded): StatementPeriod[] {
    const extentByJob = new Map<string, DateSpan>();
    for (const t of loaded.txns) {
      const e = extentByJob.get(t.importJobId);
      if (!e) extentByJob.set(t.importJobId, { from: t.txnDate, to: t.txnDate });
      else {
        if (t.txnDate < e.from) e.from = t.txnDate;
        if (t.txnDate > e.to) e.to = t.txnDate;
      }
    }
    const completed = loaded.jobs.filter((j) => j.status === 'COMPLETED').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
    const labels = new Map<string, string>();
    const labelOf = (j: BsaImportJobRecord, index: number): string => {
      const acct = (j.accountNo ?? j.iban ?? '').replace(/\s+/g, '').toUpperCase();
      // Дансны дугаарыг лог/тайланд гаргахгүй: дарааллын дугаараар шошголно
      if (acct === '') return `${j.bankCode ?? 'ACCT'}-J${index + 1}`;
      if (!labels.has(acct)) labels.set(acct, `${j.bankCode ?? 'ACCT'}-${labels.size + 1}`);
      return labels.get(acct) as string;
    };
    const periods: StatementPeriod[] = [];
    completed.forEach((j, index) => {
      const extent = extentByJob.get(j.id);
      const from = j.periodFrom ?? extent?.from;
      const to = j.periodTo ?? extent?.to;
      if (from && to) periods.push({ from, to, account: labelOf(j, index) });
    });
    return periods;
  }

  private async computeFromLoaded(loaded: Loaded, classified: readonly ClassifiedTxn[]): Promise<Computed | null> {
    const { analysis, settings } = loaded;
    const hasCompleted = loaded.jobs.some((j) => j.status === 'COMPLETED');
    if (!hasCompleted || loaded.txns.length === 0) return null;

    const periods = this.coveragePeriods(loaded);
    const validPeriods = periods.filter((p) => p.from <= p.to);
    const coverage: DateSpan | null =
      validPeriods.length === 0
        ? null
        : { from: validPeriods.reduce((m, p) => (p.from < m ? p.from : m), validPeriods[0].from), to: validPeriods.reduce((m, p) => (p.to > m ? p.to : m), validPeriods[0].to) };
    const period = resolvePeriod({ periodMonths: analysis.periodMonths, periodFrom: analysis.periodFrom, periodTo: analysis.periodTo }, coverage, settings);
    if (period === null) return null;

    const warnings: BsaAnalysisWarning[] = [...period.warnings];
    const proposed = analysis.proposedMonthlyPayment;
    if (proposed === null) {
      warnings.push({ code: 'PROPOSED_PAYMENT_MISSING', message: 'Санал болгосон сарын төлбөр оруулаагүй тул 0 гэж тооцлоо.' });
    }
    const params = toDtiParams(settings, {
      periodFrom: period.from,
      periodTo: period.to,
      proposedMonthlyPayment: proposed ?? 0,
      ...(analysis.costOfGoodsRate !== null ? { costOfGoodsRate: analysis.costOfGoodsRate } : {}),
    });

    let result: DtiAnalysisResult;
    try {
      result = this.dti.analyze({ classified, categories: loaded.categories, params, otherShareThreshold: settings.otherShareThreshold });
    } catch (e) {
      if (e instanceof BsaAggregationError) {
        throw unprocessable('AGGREGATION_FAILED', { issues: e.issues.map((i) => ({ code: i.code, categoryCode: i.categoryCode ?? null, count: i.count })) });
      }
      if (e instanceof RangeError) throw badRequest('INVALID_PERIOD');
      throw e;
    }

    // BSA-FR-2.4: шаардсан хугацааны хамрах байдал
    const targetMonths = Math.max(settings.minStatementMonths, period.requestedMonths ?? period.months);
    const requiredFrom = windowStart(period.to, targetMonths);
    const required: DateSpan = { from: requiredFrom, to: period.to };
    const cov = analyzeCoverage(validPeriods, required);
    if (cov.shortfallMonths > 0) {
      warnings.push({ code: 'STATEMENT_COVERAGE_SHORT', message: `${cov.shortfallMonths} сарын хуулга дутуу (${cov.missingMonths.join(', ')}).` });
    }
    if (cov.gaps.length > 0) {
      warnings.push({ code: 'STATEMENT_GAPS', message: `Хуулгын хамрах хугацаанд ${cov.gaps.length} завсар байна.` });
    }
    if (cov.accountGaps.length > 0) {
      warnings.push({ code: 'ACCOUNT_STATEMENT_GAPS', message: `Зарим дансны хуулгын хооронд ${cov.accountGaps.length} завсар байна.` });
    }
    if (cov.overlaps.length > 0) {
      warnings.push({ code: 'STATEMENT_OVERLAP', message: 'Нэг дансны хуулгын хугацаа давхцаж байна (давхар мөрийг автоматаар нэг болгосон).' });
    }

    // BSA-BR-7: «Бусад» ангиллын хувь
    const otherShare: OtherShareReport[] = result.otherShare ?? [];
    for (const o of otherShare) {
      if (o.exceeded) {
        const dir = o.direction === 'INCOME' ? 'орлогын' : 'зарлагын';
        warnings.push({ code: 'OTHER_SHARE_EXCEEDED', message: `«Бусад» ангилал ${dir} ${pct(o.share)} байна (босго ${pct(settings.otherShareThreshold)}). Ангиллыг шалгана уу.` });
      }
    }

    const pending = await this.suspicion.countPending(analysis.orgId, analysis.id);
    const dtiResult = result.dti;
    const summary = buildBsaSummary({
      analysis: {
        analysisId: analysis.id,
        loanApplicationId: analysis.applicationId,
        borrowerId: analysis.borrowerId ?? analysis.customerId,
        status: analysis.status,
        version: analysis.version,
        periodFrom: period.from,
        periodTo: period.to,
      },
      dtiResult,
      transactionCount: result.transactionCount,
      pendingSuspiciousCount: pending,
      reportPdfUrl: analysis.summary?.reportPdfUrl ?? null,
    });

    const details: BsaAnalysisDetails = {
      analysisId: analysis.id,
      computedAt: this.clock.now().toISOString(),
      period: { from: period.from, to: period.to, months: period.months, mode: period.mode, requestedMonths: period.requestedMonths, clamped: period.clamped },
      coverage: {
        requiredFrom: required.from,
        requiredTo: required.to,
        requiredMonths: targetMonths,
        coveredMonths: cov.coveredMonths,
        shortfallMonths: cov.shortfallMonths,
        missingMonths: cov.missingMonths,
        gaps: cov.gaps,
        accountGaps: cov.accountGaps,
        overlaps: cov.overlaps,
      },
      otherShare: otherShare.map((o) => ({ direction: o.direction, otherAmount: o.otherAmount, totalAmount: o.totalAmount, share: o.share, exceeded: o.exceeded })),
      warnings,
      transactions: {
        inPeriod: result.transactionCount,
        ownTransfers: result.ownTransferCount,
        outOfPeriod: result.outOfPeriodCount,
        manualOverrides: loaded.txns.filter((t) => t.manualOverride).length,
      },
      dti: {
        dtiRatio: Number.isFinite(dtiResult.dtiRatio) ? dtiResult.dtiRatio : null,
        meetsLimit: dtiResult.meetsLimit,
        maxDti: settings.maxDti,
        costOfGoodsRate: params.costOfGoodsRate,
        proposedMonthlyPayment: params.proposedMonthlyPayment,
        householdExpenseMonthly: dtiResult.householdExpenseMonthly,
      },
      categories: dtiResult.categories.map((c) => ({
        code: c.code, name: c.name, direction: c.direction, groupCode: c.groupCode, weight: c.weight, dtiRole: c.dtiRole, totalAmount: c.totalAmount,
        monthlyAvg: c.monthlyAvg, weightedMonthly: c.weightedMonthly, monthsPresent: c.monthsPresent, txnCount: c.txnCount, share: c.share,
      })),
      methodology: dtiResult.methodology.map((m) => ({ step: m.step, key: m.key, label: m.label, formula: m.formula, inputs: m.inputs, value: m.value })),
    };

    // Хугацааны талбарын хадгалалт (period.ts-ийн дүрэм): MONTHS → resolved from/to; AUTO → анхдагч сар; EXPLICIT → хүссэнээр нь үлдээнэ
    const analysisPatch: Computed['analysisPatch'] = {};
    if (period.mode === 'MONTHS') Object.assign(analysisPatch, { periodFrom: period.from, periodTo: period.to });
    if (period.mode === 'AUTO') Object.assign(analysisPatch, { periodFrom: period.from, periodTo: period.to, periodMonths: defaultPeriodMonths(settings) });

    return {
      dtiResult,
      transactionCount: result.transactionCount,
      pending,
      summary,
      details,
      period,
      analysisPatch,
      counts: { inPeriod: result.transactionCount, outOfPeriod: result.outOfPeriodCount, ownTransfers: result.ownTransferCount },
    };
  }
}
