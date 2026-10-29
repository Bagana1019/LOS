// «Шинжилгээ — тойм» (docs/02 §2) ба «Орлого/зарлагын задаргаа» (BSA-FR-4.3/4.4) хариуны цэвэр бүтээгч. I/O байхгүй: controller service-үүдээс
// авсан хэсгүүдийг нэгтгэнэ. PII: ажлын анхааруулга (код + тогтмол мессеж), тоо, id л орно.
import type { BsaAnalysisDetails, BsaAnalysisWarning, BsaSummary } from '@los/contracts';
import type { BsaAnalysisEventRecord, BsaTransactionCounts, ImportIssue, ImportJobStatus } from '../../common/persistence';
import type { AnalysisView, ImportJobView } from '../views';

export interface OverviewWarning {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING';
  /** ANALYSIS: хугацаа / ангилал / хамрах хугацааны анхааруулга · JOB: тодорхой хуулгын импортын анхааруулга, алдаа */
  scope: 'ANALYSIS' | 'JOB';
  /** scope = JOB: хамаарах импорт ажлууд */
  jobIds?: string[];
}

export interface OverviewParts {
  analysis: AnalysisView;
  /** `RecalculationService.report` */
  report: { summary: BsaSummary | null; details: BsaAnalysisDetails | null; summaryStale: boolean };
  jobs: { items: ImportJobView[]; total: number; counts: Record<ImportJobStatus, number> };
  history: { items: BsaAnalysisEventRecord[]; total: number };
  transactions: BsaTransactionCounts;
}

export interface AnalysisOverview {
  /** Шинжилгээний мета (регистр/данс/утас далдлагдсан); хураангуйг `summary`-д тусад нь өгнө */
  analysis: Omit<AnalysisView, 'summary'>;
  /** Хадгалагдсан INT-4 хураангуй (LOS-д татахад бичигддэг) */
  summary: BsaSummary | null;
  /** Хадгалагдсан хураангуй нь одоогийн гүйлгээ/параметрээс тооцсоноос ялгаатай (дахин тооцоолох хэрэгтэй) */
  summaryStale: boolean;
  /** Одоогийн гүйлгээнээс тооцсон дэлгэрэнгүй: хугацаа, хамрах хугацаа, DTI, задаргаа, аргачлал */
  details: BsaAnalysisDetails | null;
  warnings: OverviewWarning[];
  jobs: AnalysisOverviewJobs;
  history: { items: BsaAnalysisEventRecord[]; total: number };
  transactions: Pick<BsaTransactionCounts, 'total' | 'income' | 'expense' | 'ownTransfers' | 'manualOverrides' | 'unclassified'>;
}

export interface AnalysisOverviewJobs {
  items: ImportJobView[];
  total: number;
  counts: Record<ImportJobStatus, number>;
}

const fromAnalysis = (w: BsaAnalysisWarning): OverviewWarning => ({ code: w.code, message: w.message, severity: 'WARNING', scope: 'ANALYSIS' });

/** Ажлын алдаа/анхааруулгыг КОД тутамд нэгтгэнэ (хамаарах jobId-тай). Жишээ: UNVERIFIED_PARSER — 2 ажил */
function jobWarnings(jobs: readonly ImportJobView[]): OverviewWarning[] {
  const byKey = new Map<string, OverviewWarning>();
  const add = (job: ImportJobView, issue: ImportIssue, severity: 'ERROR' | 'WARNING'): void => {
    const key = `${severity}:${issue.code}`;
    const existing = byKey.get(key);
    if (existing) existing.jobIds?.push(job.id);
    else byKey.set(key, { code: issue.code, message: issue.message, severity, scope: 'JOB', jobIds: [job.id] });
  };
  for (const job of jobs) {
    for (const issue of job.errors) add(job, issue, 'ERROR');
    for (const issue of job.warnings) add(job, issue, 'WARNING');
  }
  return [...byKey.values()];
}

const severityRank = (w: OverviewWarning): number => (w.severity === 'ERROR' ? 0 : 1);
const scopeRank = (w: OverviewWarning): number => (w.scope === 'ANALYSIS' ? 0 : 1);

export function buildOverview(parts: OverviewParts): AnalysisOverview {
  const { summary: _stored, ...analysis } = parts.analysis;
  const warnings = [...(parts.report.details?.warnings ?? []).map(fromAnalysis), ...jobWarnings(parts.jobs.items)].sort(
    (a, b) => severityRank(a) - severityRank(b) || scopeRank(a) - scopeRank(b) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  const { total, income, expense, ownTransfers, manualOverrides, unclassified } = parts.transactions;
  return {
    analysis,
    summary: parts.analysis.summary,
    summaryStale: parts.report.summaryStale,
    details: parts.report.details,
    warnings,
    jobs: parts.jobs,
    history: parts.history,
    transactions: { total, income, expense, ownTransfers, manualOverrides, unclassified },
  };
}

// ───────────────────────── Задаргаа (BSA-FR-4.3 / 4.4) ─────────────────────────

type Category = BsaAnalysisDetails['categories'][number];

export interface BreakdownSide {
  categories: Category[];
  /** Σ ангилал бүрийн сарын дундаж (own-transfer мөрийг оруулаагүй: aggregate хасч тооцсон) */
  monthlyAvgTotal: number;
  /** Σ дайчлах хувиар үржүүлсэн сарын дундаж */
  weightedMonthlyTotal: number;
  txnCount: number;
}

export interface Breakdown {
  analysisId: string;
  computedAt: string;
  period: BsaAnalysisDetails['period'];
  income: BreakdownSide;
  expense: BreakdownSide;
  /** BSA-FR-4.3: тооцооллын алхам бүр (томьёо, оролт, утга) */
  methodology: BsaAnalysisDetails['methodology'];
  dti: BsaAnalysisDetails['dti'];
  otherShare: BsaAnalysisDetails['otherShare'];
  transactions: BsaAnalysisDetails['transactions'];
  warnings: BsaAnalysisWarning[];
  summaryStale: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function side(categories: readonly Category[], direction: 'INCOME' | 'EXPENSE', includeEmpty: boolean): BreakdownSide {
  const own = categories.filter((c) => c.direction === direction && (includeEmpty || c.txnCount > 0));
  return {
    categories: own,
    monthlyAvgTotal: round2(own.reduce((sum, c) => sum + c.monthlyAvg, 0)),
    weightedMonthlyTotal: round2(own.reduce((sum, c) => sum + c.weightedMonthly, 0)),
    txnCount: own.reduce((sum, c) => sum + c.txnCount, 0),
  };
}

export function buildBreakdown(details: BsaAnalysisDetails, summaryStale: boolean, includeEmpty: boolean): Breakdown {
  return {
    analysisId: details.analysisId,
    computedAt: details.computedAt,
    period: details.period,
    income: side(details.categories, 'INCOME', includeEmpty),
    expense: side(details.categories, 'EXPENSE', includeEmpty),
    methodology: details.methodology,
    dti: details.dti,
    otherShare: details.otherShare,
    transactions: details.transactions,
    warnings: details.warnings,
    summaryStale,
  };
}
