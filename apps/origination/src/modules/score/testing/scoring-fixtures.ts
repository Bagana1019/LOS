import {
  CalculationRecord, MethodVerdict, SoscoComponentBreakdown, SoscoScoreResponse, UnderwriteResult, SOSCO_COMPONENTS,
  type CalcMethod, type ScoreRequest, type SoscoGrade, type SoscoSummary,
} from '@los/contracts';

// Scoring-ийн хариуг орлуулах СТАТИК fixture-үүд (`@los/contracts` zod-оор шалгагдсан). `@los/calc` engine-ээс хамааралгүй: тоонууд гараар
// тогтоосон, зөвхөн хэлбэр/семантик (3 арга, дараалал) жинхэнэтэй ижил. Бодит тооцооллын зөв байдлыг scoring + calc-ийн тестүүд хариуцна.

export const METHODS: readonly CalcMethod[] = ['A_SALARY', 'B_BUSINESS', 'C_COMBINED'];
const RATIO_KIND = { A_SALARY: 'DTI', B_BUSINESS: 'DSCR', C_COMBINED: 'DSCR' } as const;

export interface VerdictOptions { applicable?: boolean; pass?: boolean; ratio?: number | null; burdenPercent?: number | null; baseIncome?: number }

export function methodVerdict(method: CalcMethod, request: ScoreRequest, o: VerdictOptions = {}): MethodVerdict {
  const applicable = o.applicable ?? true;
  const pass = applicable && (o.pass ?? true);
  const kind = RATIO_KIND[method];
  return MethodVerdict.parse({
    method, applicable,
    baseIncome: o.baseIncome ?? (method === 'A_SALARY' ? request.salaryMonthly : method === 'B_BUSINESS' ? request.businessNcfMonthly : request.salaryMonthly + request.businessNcfMonthly - request.householdExpenseMonthly),
    totalDebtService: request.existingDebtServiceMonthly + request.monthlyPayment,
    ratioKind: kind,
    ratio: applicable ? (o.ratio !== undefined ? o.ratio : kind === 'DTI' ? 0.3 : 2) : null,
    limit: kind === 'DTI' ? request.policy.maxDti : request.policy.minDscr,
    pass, burdenPercent: applicable ? (o.burdenPercent !== undefined ? o.burdenPercent : 30) : null,
    eligible: pass, maxPayment: 1_000_000, maxAffordable: 10_000_000, maxLoanAmount: 10_000_000,
    reasons: applicable ? [] : [{ code: method === 'A_SALARY' ? 'NO_SALARY_INCOME' : 'NO_BUSINESS_INCOME', step: 'income', message: 'Орлого байхгүй' }],
    stress: request.stress ? { baseIncome: 1, totalDebtService: 1, ratio: 1, pass: true } : null,
  });
}

export interface ResultOptions {
  autoSelected?: CalcMethod | null;
  applicable?: Partial<Record<CalcMethod, boolean>>;
  pass?: Partial<Record<CalcMethod, boolean>>;
  burdenPercent?: Partial<Record<CalcMethod, number | null>>;
  ltv?: number | null;
}

/** `request`-ээс хэлбэр нь нийцсэн UnderwriteResult. Анхдагч: гурвуулаа хэрэглэгдэнэ, A арга автоматаар сонгогдоно. */
export function underwriteResult(request: ScoreRequest, o: ResultOptions = {}): UnderwriteResult {
  const autoSelected = o.autoSelected === undefined ? 'A_SALARY' : o.autoSelected;
  return UnderwriteResult.parse({
    applicationId: request.applicationId,
    loan: { amount: request.amount, termMonths: request.termMonths, interestRate: request.interestRate, monthlyPayment: request.monthlyPayment, totalPayable: request.monthlyPayment * request.termMonths, totalInterest: request.monthlyPayment * request.termMonths - request.amount },
    methods: METHODS.map((m) => methodVerdict(m, request, { applicable: o.applicable?.[m], pass: o.pass?.[m], burdenPercent: o.burdenPercent?.[m] })),
    incomeMix: { salaryShare: 1, businessShare: 0, weightThreshold: request.policy.weightThreshold },
    autoSelected, autoSelectReason: autoSelected === null ? 'NO_INCOME' : 'SALARY_DOMINANT',
    collateral: {
      required: request.collateralRequired, valueTotal: request.collateralValueTotal, ltv: o.ltv === undefined ? 0.5 : o.ltv, limit: request.policy.maxLtv,
      pass: true, maxAmount: request.collateralValueTotal * request.policy.maxLtv, reasons: [],
    },
    stress: request.stress ? { rateDeltaPoints: request.stress.rateDeltaPoints, incomeChange: request.stress.incomeChange, stressedMonthlyPayment: request.monthlyPayment * 1.1 } : null,
    policy: request.policy,
  });
}

export interface RecordOptions extends ResultOptions {
  id?: string;
  customerId?: string | null;
  computedAt?: string;
  selectedMethod?: CalcMethod | null;
  selection?: 'AUTO' | 'MANUAL' | null;
  selectionReason?: string | null;
  selectedAt?: string | null;
  isStale?: boolean;
  staleReason?: string | null;
}

export function calculationRecord(request: ScoreRequest, o: RecordOptions = {}): CalculationRecord {
  const result = underwriteResult(request, o);
  const computedAt = o.computedAt ?? '2026-10-29T10:00:00.000Z';
  const selectedMethod = o.selectedMethod === undefined ? result.autoSelected : o.selectedMethod;
  return CalculationRecord.parse({
    id: o.id ?? 'calc-1', applicationId: request.applicationId, customerId: o.customerId === undefined ? 'cust-primary' : o.customerId, computedAt,
    isStale: o.isStale ?? false, staleReason: o.staleReason ?? null,
    selectedMethod, selection: o.selection === undefined ? (selectedMethod ? 'AUTO' : null) : o.selection,
    selectedBy: null, selectedAt: o.selectedAt === undefined ? (selectedMethod ? computedAt : null) : o.selectedAt, selectionReason: o.selectionReason ?? null,
    inputs: request, result,
  });
}

export interface SoscoOptions { score?: number | null; grade?: SoscoGrade | null; status?: 'SCORED' | 'INSUFFICIENT_DATA'; computedAt?: string; resultId?: string | null; modelVersion?: number }

function soscoComponents(score: number | null) {
  return SOSCO_COMPONENTS.map((key) => SoscoComponentBreakdown.parse({
    key, available: score !== null, input: score !== null ? 1 : null, normalized: score !== null ? score / 1000 : null,
    weight: 1 / SOSCO_COMPONENTS.length, effectiveWeight: score !== null ? 1 / SOSCO_COMPONENTS.length : 0, points: score !== null ? score / SOSCO_COMPONENTS.length : 0,
  }));
}

export function soscoResponse(o: SoscoOptions = {}): SoscoScoreResponse {
  const status = o.status ?? 'SCORED';
  const score = status === 'SCORED' ? (o.score === undefined ? 720 : o.score) : null;
  return SoscoScoreResponse.parse({
    status, score, grade: score === null ? null : (o.grade === undefined ? 'B' : o.grade), coverage: score === null ? 0.3 : 1, components: soscoComponents(score), modelVersion: o.modelVersion ?? 1,
    resultId: o.resultId === undefined ? (score === null ? null : 'sosco-1') : o.resultId, modelId: 'model-1', computedAt: o.computedAt ?? '2026-10-29T10:00:00.000Z',
  });
}

export function soscoSummary(customerId: string, o: SoscoOptions = {}): SoscoSummary {
  const { modelId: _modelId, ...rest } = soscoResponse(o);
  return { ...rest, customerId };
}
