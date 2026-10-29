// INT-4 / INT-5: DTI үр дүнгээс LOS руу бичих `BsaSummary` ба тооцооллын `BsaScoringInput`-ийг бүрдүүлэх. Цэвэр функц (I/O байхгүй).
// Гаралт нь @los/contracts-ийн zod схемээр баталгаажна — гэрээнээс зөрвөл тэр дор алдаа.
import type { BsaDtiResult } from '@los/calc';
import { BsaScoringInput, BsaSummary, type BsaStatus as BsaStatusValues } from '@los/contracts';

/** docs/03 BsaStatus: DRAFT | ANALYZED */
export type BsaStatus = (typeof BsaStatusValues)[number];

/** Шинжилгээний мета (bsa_analysis-ээс) */
export interface BsaAnalysisMeta {
  analysisId: string;
  loanApplicationId: string;
  borrowerId: string;
  status: BsaStatus;
  version: number;
  /** YYYY-MM-DD */
  periodFrom: string;
  periodTo: string;
}

export interface BsaSummaryInput {
  analysis: BsaAnalysisMeta;
  dtiResult: BsaDtiResult;
  transactionCount: number;
  /** BSA-FR-5.3: хүлээгдэж буй сэжигтэй дохионы тоо */
  pendingSuspiciousCount: number;
  reportPdfUrl: string | null;
}

function assertCount(name: string, v: number, min = 0): void {
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} must be an integer >= ${min}, got ${v}`);
}

function validate(input: BsaSummaryInput): void {
  assertCount('transactionCount', input.transactionCount);
  assertCount('pendingSuspiciousCount', input.pendingSuspiciousCount);
  assertCount('analysis.version', input.analysis.version, 1);
  for (const [k, v] of Object.entries(input.dtiResult)) {
    if (typeof v === 'number' && !Number.isFinite(v) && k !== 'dtiRatio') throw new RangeError(`dtiResult.${k} must be finite`);
  }
}

/** INT-4: LOS-ын loan_application.bsa_summary_json-д бичих хураангуй */
export function buildBsaSummary(input: BsaSummaryInput): BsaSummary {
  validate(input);
  const { analysis: a, dtiResult: r } = input;
  return BsaSummary.parse({
    analysisId: a.analysisId,
    loanApplicationId: a.loanApplicationId,
    borrowerId: a.borrowerId,
    status: a.status,
    version: a.version,
    periodMonths: r.periodMonths,
    periodFrom: a.periodFrom,
    periodTo: a.periodTo,
    transactionCount: input.transactionCount,
    totalMonthlyIncome: r.totalMonthlyIncome,
    verifiedMonthlyIncome: r.verifiedMonthlyIncome,
    dtiIncome: r.dtiIncome,
    businessIncomeMonthly: r.businessIncomeMonthly,
    businessExpenseMonthly: r.businessExpenseMonthly,
    netCashFlowMonthly: r.netCashFlowMonthly,
    existingDebtServiceMonthly: r.existingDebtServiceMonthly,
    incomeReliability: r.incomeReliability,
    dtiPercent: r.dtiPercent,
    dtiLevel: r.dtiLevel,
    pendingSuspiciousCount: input.pendingSuspiciousCount,
    reportPdfUrl: input.reportPdfUrl,
  });
}

/** INT-5: Тооцоолол (B/C арга) ба Sosco Score-д өгөх оролт (`toScoringPatch`-ийн эх) */
export function buildScoringInput(input: BsaSummaryInput): BsaScoringInput {
  validate(input);
  const { analysis: a, dtiResult: r } = input;
  return BsaScoringInput.parse({
    analysisId: a.analysisId,
    loanApplicationId: a.loanApplicationId,
    borrowerId: a.borrowerId,
    version: a.version,
    status: a.status,
    periodMonths: r.periodMonths,
    transactionCount: input.transactionCount,
    businessIncomeMonthly: r.businessIncomeMonthly,
    businessExpenseMonthly: r.businessExpenseMonthly,
    businessNcfMonthly: r.netCashFlowMonthly,
    householdExpenseMonthly: r.householdExpenseMonthly,
    existingDebtServiceMonthly: r.existingDebtServiceMonthly,
    verifiedMonthlyIncome: r.verifiedMonthlyIncome,
    dtiIncomeMonthly: r.dtiIncome,
    dtiPercent: r.dtiPercent,
    incomeReliability: r.incomeReliability,
    pendingSuspiciousCount: input.pendingSuspiciousCount,
  });
}
