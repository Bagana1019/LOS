import {
  CalculationRecord,
  ScoreOverview,
  ScorePreviewResponse,
  UnderwriteResult,
  type CalcMethod,
  type MethodReason,
  type MethodVerdict,
  type ReasonCode,
  type ScoreLimits,
  type ScoreTerms,
  type SoscoComponentBreakdown,
  type SoscoSummary,
} from '@los/contracts';

// Тестийн fixture + "хуурамч сервер". vitest ба Playwright хоёулаа ашиглана.
// ЧУХАЛ: энэ нь UI-ийн код БИШ — origination/scoring-ийн хариуг дуурайх тестийн хэсэг тул энд тооцоолол байж болно.
// Бүх гаралт @los/contracts-ийн zod схемээр parse() хийгддэг: гэрээ өөрчлөгдвөл тест нэн даруй унана.

export const APP_ID = '7b0f7f3a-6e43-4f6c-9d29-2c1d6a3a0001';
export const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
export const COMPUTED_AT = '2026-10-29T06:05:00.000Z'; // 14:05 Улаанбаатар

export const POLICY = { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 } as const;
export const STRESS = { rateDeltaPoints: 5, incomeChange: -0.2 } as const;
export const LIMITS: ScoreLimits = { minAmount: 500_000, maxAmount: 50_000_000, minTermMonths: 3, maxTermMonths: 60, minRate: 12, maxRate: 36 };
export const TERMS: ScoreTerms = { amount: 20_000_000, termMonths: 24, interestRate: 23.99 };

/** Серверийн шалтгааны каталог (packages/calc REASON_CATALOG-тай ижил код → алхам) */
const REASONS: Record<ReasonCode, Pick<MethodReason, 'step' | 'message'>> = {
  NO_SALARY_INCOME: { step: 'income', message: 'Цалингийн орлого байхгүй' },
  NO_BUSINESS_INCOME: { step: 'income', message: 'Бизнесийн орлого (ЦМУ) байхгүй' },
  NEGATIVE_BUSINESS_NCF: { step: 'income', message: 'Бизнесийн цэвэр мөнгөн урсгал (ЦМУ) сөрөг байна' },
  NO_INCOME: { step: 'income', message: 'Цалин болон бизнесийн орлого аль нь ч байхгүй' },
  NON_POSITIVE_BASE_INCOME: { step: 'income', message: 'Өрхийн зардал хассны дараах суурь орлого 0-ээс ихгүй байна' },
  DTI_ABOVE_LIMIT: { step: 'loan', message: 'Өр/орлогын харьцаа (ӨОХ) зөвшөөрөгдөх дээд хязгаараас хэтэрсэн' },
  DSCR_BELOW_MIN: { step: 'loan', message: 'Өрийн төлбөр чадварын харьцаа (ӨТЧХ) доод хязгаараас бага байна' },
  NO_COLLATERAL_VALUE: { step: 'collateral', message: 'Барьцаа шаардлагатай боловч барьцааны үнэлгээ байхгүй' },
  LTV_ABOVE_LIMIT: { step: 'collateral', message: 'Зээл/барьцааны харьцаа (LTV) зөвшөөрөгдөх дээд хязгаараас хэтэрсэн' },
  LOAN_TERMS_MISSING: { step: 'loan', message: 'Зээлийн нөхцөл (дүн, хугацаа, хүү) бөглөгдөөгүй байна' },
};
export const reason = (code: ReasonCode): MethodReason => ({ code, ...REASONS[code] });

// ───────────────────────────── хуурамч сервер: underwrite ─────────────────────────────

export interface FakeInputs {
  salary: number;
  businessNcf: number;
  householdExpense: number;
  existingDebtService: number;
  collateralValue: number;
  collateralRequired: boolean;
}
/** Тогтвортой анхдагч орлого: цалин 42.9% / бизнес 57.1% → босго 70%-д хүрэхгүй → C (MIXED) */
export const MIXED_INPUTS: FakeInputs = { salary: 4_500_000, businessNcf: 6_000_000, householdExpense: 1_200_000, existingDebtService: 800_000, collateralValue: 40_000_000, collateralRequired: true };
/** A хангана (ногоон) · B хамаарахгүй (саарал) · C хангахгүй (улаан) */
export const VERDICT_INPUTS: FakeInputs = { salary: 3_000_000, businessNcf: 0, householdExpense: 1_200_000, existingDebtService: 800_000, collateralValue: 40_000_000, collateralRequired: true };
/** VERDICT_INPUTS-тай хамт: нийт өрийн үйлчилгээ ≈ 1.54 сая → ӨОХ ≈ 51.3% (A ✓), C-ийн ӨТЧХ ≈ 1.16 (✗) */
export const VERDICT_TERMS: ScoreTerms = { amount: 14_000_000, termMonths: 24, interestRate: 23.99 };

const cents = (n: number): number => Math.round(n * 100) / 100;
const annuity = (amount: number, annualRatePct: number, months: number): number => {
  const r = annualRatePct / 100 / 12;
  return cents(r === 0 ? amount / months : (amount * r) / (1 - (1 + r) ** -months));
};
const maxPrincipal = (payment: number, annualRatePct: number, months: number): number => {
  if (payment <= 0) return 0;
  const r = annualRatePct / 100 / 12;
  return Math.floor(r === 0 ? payment * months : (payment * (1 - (1 + r) ** -months)) / r);
};
const ceil4 = (n: number): number => Math.ceil(Math.round(n * 1e8) / 1e4) / 1e4;
const floor2 = (n: number): number => Math.floor(Math.round(n * 1e6) / 1e4) / 100;

export function fakeUnderwrite(terms: ScoreTerms, inputs: FakeInputs = MIXED_INPUTS, opts: { stress?: boolean } = {}): UnderwriteResult {
  const { amount, termMonths, interestRate } = terms;
  const stress = opts.stress ?? true;
  const payment = annuity(amount, interestRate, termMonths);
  const tds = cents(inputs.existingDebtService + payment);
  const stressedPayment = annuity(amount, interestRate + STRESS.rateDeltaPoints, termMonths);
  const stressedTds = cents(inputs.existingDebtService + stressedPayment);
  const salaryPos = Math.max(inputs.salary, 0);
  const ncfPos = Math.max(inputs.businessNcf, 0);
  const totalPos = salaryPos + ncfPos;
  const salaryShare = totalPos > 0 ? salaryPos / totalPos : null;
  const businessShare = totalPos > 0 ? ncfPos / totalPos : null;

  const collateralMax = inputs.collateralRequired || inputs.collateralValue > 0 ? Math.floor(inputs.collateralValue * POLICY.maxLtv) : null;
  const ltv = inputs.collateralValue > 0 ? ceil4(amount / inputs.collateralValue) : null;
  const collateralReasons: MethodReason[] = [];
  if (inputs.collateralRequired && inputs.collateralValue <= 0) collateralReasons.push(reason('NO_COLLATERAL_VALUE'));
  else if (ltv !== null && amount / inputs.collateralValue > POLICY.maxLtv) collateralReasons.push(reason('LTV_ABOVE_LIMIT'));
  const collateralPass = collateralReasons.length === 0;

  const method = (m: CalcMethod): MethodVerdict => {
    const isA = m === 'A_SALARY';
    const base = m === 'A_SALARY' ? inputs.salary : m === 'B_BUSINESS' ? inputs.businessNcf : inputs.salary + inputs.businessNcf - inputs.householdExpense;
    const applicable = m === 'A_SALARY' ? inputs.salary > 0 : m === 'B_BUSINESS' ? inputs.businessNcf > 0 : inputs.salary > 0 || inputs.businessNcf > 0;
    const reasons: MethodReason[] = [];
    if (!applicable) {
      reasons.push(reason(m === 'A_SALARY' ? 'NO_SALARY_INCOME' : m === 'B_BUSINESS' ? (inputs.businessNcf < 0 ? 'NEGATIVE_BUSINESS_NCF' : 'NO_BUSINESS_INCOME') : 'NO_INCOME'));
    } else if (base <= 0) reasons.push(reason('NON_POSITIVE_BASE_INCOME'));
    const ratioOk = applicable && base > 0;
    const ratio = ratioOk ? (isA ? ceil4(tds / base) : floor2(base / tds)) : null;
    const pass = ratioOk && (isA ? tds / base <= POLICY.maxDti : base / tds >= POLICY.minDscr);
    if (ratioOk && !pass) reasons.push(reason(isA ? 'DTI_ABOVE_LIMIT' : 'DSCR_BELOW_MIN'));
    const maxPaymentRaw = isA ? POLICY.maxDti * base - inputs.existingDebtService : base / POLICY.minDscr - inputs.existingDebtService;
    const maxPayment = ratioOk ? Math.max(0, cents(maxPaymentRaw)) : 0;
    const maxAffordable = maxPrincipal(maxPayment, interestRate, termMonths);
    let stressOutcome: MethodVerdict['stress'] = null;
    if (stress) {
      const sBase = m === 'A_SALARY' ? salaryPos * (1 + STRESS.incomeChange) : m === 'B_BUSINESS' ? ncfPos * (1 + STRESS.incomeChange) : salaryPos * (1 + STRESS.incomeChange) + (inputs.businessNcf >= 0 ? ncfPos * (1 + STRESS.incomeChange) : inputs.businessNcf) - inputs.householdExpense;
      const sOk = applicable && sBase > 0;
      stressOutcome = {
        baseIncome: cents(sBase),
        totalDebtService: stressedTds,
        ratio: sOk ? (isA ? ceil4(stressedTds / sBase) : floor2(sBase / stressedTds)) : null,
        pass: sOk && (isA ? stressedTds / sBase <= POLICY.maxDti : sBase / stressedTds >= POLICY.minDscr),
      };
    }
    return {
      method: m,
      applicable,
      baseIncome: cents(base),
      totalDebtService: tds,
      ratioKind: isA ? 'DTI' : 'DSCR',
      ratio,
      limit: isA ? POLICY.maxDti : POLICY.minDscr,
      pass,
      burdenPercent: base > 0 ? Math.ceil((tds / base) * 1000) / 10 : null,
      eligible: applicable && pass && collateralPass,
      maxPayment,
      maxAffordable,
      maxLoanAmount: collateralMax === null ? maxAffordable : Math.min(maxAffordable, collateralMax),
      reasons,
      stress: stressOutcome,
    };
  };

  const autoSelected: CalcMethod | null = totalPos === 0 ? null : salaryShare! > POLICY.weightThreshold ? 'A_SALARY' : businessShare! > POLICY.weightThreshold ? 'B_BUSINESS' : 'C_COMBINED';
  return UnderwriteResult.parse({
    applicationId: APP_ID,
    loan: { amount, termMonths, interestRate, monthlyPayment: payment, totalPayable: cents(payment * termMonths), totalInterest: cents(payment * termMonths - amount) },
    methods: (['A_SALARY', 'B_BUSINESS', 'C_COMBINED'] as const).map(method),
    incomeMix: { salaryShare, businessShare, weightThreshold: POLICY.weightThreshold },
    autoSelected,
    autoSelectReason: autoSelected === null ? 'NO_INCOME' : autoSelected === 'A_SALARY' ? 'SALARY_DOMINANT' : autoSelected === 'B_BUSINESS' ? 'BUSINESS_DOMINANT' : 'MIXED',
    collateral: {
      required: inputs.collateralRequired,
      valueTotal: inputs.collateralValue,
      ltv,
      limit: POLICY.maxLtv,
      pass: collateralPass,
      maxAmount: collateralMax,
      reasons: collateralReasons,
    },
    stress: stress ? { ...STRESS, stressedMonthlyPayment: stressedPayment } : null,
    policy: POLICY,
  });
}

export const previewResponse = (terms: ScoreTerms, inputs: FakeInputs = MIXED_INPUTS, opts?: { stress?: boolean }): ScorePreviewResponse =>
  ScorePreviewResponse.parse({ terms, result: fakeUnderwrite(terms, inputs, opts) });

// ───────────────────────────── Sosco ─────────────────────────────

const comp = (key: SoscoComponentBreakdown['key'], input: number | null, normalized: number | null, weight: number, effectiveWeight: number, points: number): SoscoComponentBreakdown => ({
  key,
  available: normalized !== null,
  input,
  normalized,
  weight,
  effectiveWeight,
  points,
});

/** score=724 (B), 5 бүрэлдэхүүн мэдэгдэнэ, `history` мэдэгдэхгүй (null) → жин дахин хуваарилагдсан */
export function soscoScored(over: Partial<SoscoSummary> = {}): SoscoSummary {
  return {
    resultId: 'sr-1',
    customerId: CUSTOMER_ID,
    status: 'SCORED',
    score: 724,
    grade: 'B',
    coverage: 0.85,
    components: [
      comp('fico', 702, 0.7309, 0.25, 0.2941, 215),
      comp('dti', 41.3, 0.6217, 0.2, 0.2353, 146.3),
      comp('reliability', 82, 0.82, 0.2, 0.2353, 193),
      comp('suspicious', 1, 0.8, 0.1, 0.1176, 94.1),
      comp('history', null, null, 0.15, 0, 0),
      comp('ltv', 0.5, 0.7143, 0.1, 0.1176, 84),
    ],
    modelVersion: 3,
    computedAt: COMPUTED_AT,
    ...over,
  };
}

/** Хамрах хувь 0.35 < доод хязгаар → оноо өгөөгүй */
export function soscoInsufficient(): SoscoSummary {
  return {
    resultId: null,
    customerId: CUSTOMER_ID,
    status: 'INSUFFICIENT_DATA',
    score: null,
    grade: null,
    coverage: 0.35,
    components: [
      comp('fico', null, null, 0.25, 0, 0),
      comp('dti', 41.3, 0.6217, 0.2, 0.5714, 0),
      comp('reliability', null, null, 0.2, 0, 0),
      comp('suspicious', null, null, 0.1, 0, 0),
      comp('history', null, null, 0.15, 0, 0),
      comp('ltv', 0.5, 0.7143, 0.1, 0.4286, 0),
    ],
    modelVersion: 3,
    computedAt: COMPUTED_AT,
  };
}

// ───────────────────────────── Overview ─────────────────────────────

/** `inputs` (FakeInputs) нь CalculationRecord.inputs-ээс ялгаатай: бүртгэлийн inputs-ийг fakeUnderwrite-ээс үүсгэнэ. */
export function makeCalculation(over: Omit<Partial<CalculationRecord>, 'inputs'> & { terms?: ScoreTerms; inputs?: FakeInputs; stress?: boolean } = {}): CalculationRecord {
  const { terms = TERMS, inputs = MIXED_INPUTS, stress, ...rest } = over;
  const result = fakeUnderwrite(terms, inputs, { stress });
  const selected = result.autoSelected;
  return CalculationRecord.parse({
    id: 'calc-1',
    applicationId: APP_ID,
    customerId: CUSTOMER_ID,
    computedAt: COMPUTED_AT,
    isStale: false,
    staleReason: null,
    selectedMethod: selected,
    selection: selected ? 'AUTO' : null,
    selectedBy: null,
    selectedAt: selected ? COMPUTED_AT : null,
    selectionReason: null,
    inputs: {
      applicationId: APP_ID,
      amount: terms.amount,
      termMonths: terms.termMonths,
      interestRate: terms.interestRate,
      monthlyPayment: result.loan.monthlyPayment,
      salaryMonthly: inputs.salary,
      businessNcfMonthly: inputs.businessNcf,
      householdExpenseMonthly: inputs.householdExpense,
      existingDebtServiceMonthly: inputs.existingDebtService,
      collateralValueTotal: inputs.collateralValue,
      collateralRequired: inputs.collateralRequired,
      policy: POLICY,
      stress: STRESS,
    },
    result,
    ...rest,
  });
}

export interface OverviewOptions {
  editable?: boolean;
  terms?: ScoreTerms | null;
  limits?: ScoreLimits | null;
  blockers?: MethodReason[];
  calculation?: CalculationRecord | null;
  sosco?: SoscoSummary | null;
}

export function makeOverview(o: OverviewOptions = {}): ScoreOverview {
  return ScoreOverview.parse({
    applicationId: APP_ID,
    editable: o.editable ?? true,
    terms: o.terms === undefined ? TERMS : o.terms,
    limits: o.limits === undefined ? LIMITS : o.limits,
    blockers: o.blockers ?? [],
    calculation: o.calculation === undefined ? makeCalculation() : o.calculation,
    sosco: o.sosco === undefined ? soscoScored() : o.sosco,
  });
}

/** Тооцоолол хараахан хийгдээгүй (анх нээсэн) */
export const emptyOverview = (o: OverviewOptions = {}): ScoreOverview => makeOverview({ calculation: null, sosco: null, ...o });
