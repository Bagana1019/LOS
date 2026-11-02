// FR-8 / BR-1..5: A цалин (ӨОХ ≤ maxDti), B бизнес (ӨТЧХ ≥ minDscr), C хосолсон. Утга hardcode хийхгүй — policy параметрээр.
// Дэлгэрэнгүй томьёо, тоймлолтын дүрэм: docs/05-scoring-sosco.md §2. Цэвэр функц — I/O байхгүй.
//
// Тоймлолт (мөнгө/харьцаа бүгд Decimal, float drift-гүй):
//   мөнгө 2 орон HALF_UP · ӨОХ дээш 4 орон · ӨТЧХ доош 2 орон · burdenPercent дээш 1 орон · LTV дээш 4 орон
//   maxAffordable, collateral.maxAmount доош бүхэл ₮ · maxPayment доош 2 орон (хязгаараас хэзээ ч хэтрэхгүй)
//   `pass` нь БӨӨРӨНХИЙЛӨӨГҮЙ (exact) утгаар шийдэгдэнэ — харуулах `ratio` нь консерватив тул хязгаартай үргэлж нийцнэ.
import Decimal from 'decimal.js';
import type {
  AutoSelectReason,
  CalcMethod,
  CollateralVerdict,
  LoanSummary,
  MethodReason,
  MethodVerdict,
  ReasonCode,
  ReasonStep,
  ScoreRequest,
  StressOutcome,
  UnderwriteResult,
} from '@los/contracts';
import { annuityPayment } from './schedule';

/** Глобал Decimal тохиргоонд нөлөөлөхгүй тусдаа clone: 40 орон, ROUND_HALF_UP (bsa-dti.ts-тэй ижил) */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const HALF_UP = Decimal.ROUND_HALF_UP;
const CEIL = Decimal.ROUND_CEIL;
const FLOOR = Decimal.ROUND_FLOOR;

/** Decimal → number (dp орон, заасан тоймлолтоор). `+ 0` нь -0-г 0 болгоно (JSON/тест тогтвортой) */
const num = (x: Decimal, dp: number, mode: Decimal.Rounding): number => x.toDecimalPlaces(dp, mode).toNumber() + 0;
const money = (x: Decimal): number => num(x, 2, HALF_UP);

// ───────────────────────────── Шалтгааны каталог (FR-8.6) ─────────────────────────────

/**
 * Бүх шалтгааны ЦОРЫН ГАНЦ хүснэгт: код → {алхам, мессеж}. `step` = хэрэглэгч шалтгааныг засахаар очих wizard-ийн алхам.
 *  - орлогын шалтгаан (NO_*_INCOME, NEGATIVE_BUSINESS_NCF, NO_INCOME, NON_POSITIVE_BASE_INCOME) → `income` (орлого/өрхийн зардал энд)
 *  - ӨОХ/ӨТЧХ хэтрэлт → `loan` (дүн, хугацаа, хүүг багасгах/уртасгах — слайдер ба нөхцөл энд)
 *  - барьцааны шалтгаан (NO_COLLATERAL_VALUE, LTV_ABOVE_LIMIT) → `collateral` (үнэлгээ нэмэх/барьцаа нэмэх)
 *  - LOAN_TERMS_MISSING → `loan` (origination гаргана; underwrite өөрөө гаргахгүй, мессежийг давтахгүйн тулд энд)
 */
export const REASON_CATALOG: Readonly<Record<ReasonCode, { step: ReasonStep; message: string }>> = {
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

const reason = (code: ReasonCode): MethodReason => ({ code, step: REASON_CATALOG[code].step, message: REASON_CATALOG[code].message });

// ───────────────────────────── Оролтын шалгалт ─────────────────────────────
// Функц zod-гүйгээр дуудагдаж болох тул (жишээ нь scoring/origination дотор шууд) хүчингүй оролтод RangeError шиднэ.

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function requireNumber(field: string, v: unknown, ok: (n: number) => boolean, rule: string): number {
  if (!isFiniteNumber(v) || !ok(v)) throw new RangeError(`underwrite: ${field} буруу — ${rule} (өгсөн: ${String(v)})`);
  return v;
}

function validateRequest(req: ScoreRequest): void {
  const finite = (n: number): boolean => Number.isFinite(n);
  const nonNeg = (n: number): boolean => n >= 0;
  requireNumber('amount', req.amount, (n) => n > 0, 'эерэг төгсгөлөг тоо байх ёстой');
  requireNumber('termMonths', req.termMonths, (n) => Number.isInteger(n) && n >= 1, '1-ээс багагүй бүхэл тоо байх ёстой');
  requireNumber('interestRate', req.interestRate, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  requireNumber('monthlyPayment', req.monthlyPayment, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  requireNumber('salaryMonthly', req.salaryMonthly, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  requireNumber('businessNcfMonthly', req.businessNcfMonthly, finite, 'төгсгөлөг тоо байх ёстой');
  requireNumber('householdExpenseMonthly', req.householdExpenseMonthly, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  requireNumber('existingDebtServiceMonthly', req.existingDebtServiceMonthly, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  requireNumber('collateralValueTotal', req.collateralValueTotal, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  const p = req.policy;
  requireNumber('policy.maxDti', p.maxDti, (n) => n > 0 && n <= 1, '(0, 1] завсарт байх ёстой');
  requireNumber('policy.minDscr', p.minDscr, (n) => n > 0, 'эерэг төгсгөлөг тоо байх ёстой');
  requireNumber('policy.maxLtv', p.maxLtv, (n) => n > 0 && n <= 1, '(0, 1] завсарт байх ёстой');
  requireNumber('policy.weightThreshold', p.weightThreshold, (n) => n >= 0 && n <= 1, '[0, 1] завсарт байх ёстой');
  if (req.stress) {
    requireNumber('stress.rateDeltaPoints', req.stress.rateDeltaPoints, nonNeg, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
    requireNumber('stress.incomeChange', req.stress.incomeChange, (n) => n >= -1 && n <= 0, '[-1, 0] завсарт байх ёстой');
  }
}

// ───────────────────────────── Боломжит дээд дүн (annuity урвуу) ─────────────────────────────

/**
 * `payment` сарын төлбөрт тохирох annuity үндсэн дүн (доош бүхэл ₮) — `annuityPayment`-ийн урвуу.
 * Баталгаа (payment нь 2 оронтой үед): annuityPayment(буцаасан дүн) ≤ payment, annuityPayment(буцаасан дүн + 1000) > payment.
 * rate = 0 → payment × n; payment ≤ 0 → 0.
 */
export function maxPrincipalForPayment(payment: number, annualRatePct: number, termMonths: number): number {
  requireNumber('payment', payment, () => true, 'төгсгөлөг тоо байх ёстой');
  requireNumber('annualRatePct', annualRatePct, (n) => n >= 0, '0-ээс багагүй төгсгөлөг тоо байх ёстой');
  requireNumber('termMonths', termMonths, (n) => Number.isInteger(n) && n >= 1, '1-ээс багагүй бүхэл тоо байх ёстой');
  if (payment <= 0) return 0;
  const pmt = new D(payment);
  if (annualRatePct === 0) return num(pmt.mul(termMonths), 0, FLOOR);
  const r = new D(annualRatePct).div(1200);
  // P = pmt × (1 − (1+r)^−n) ÷ r
  const annuityFactor = new D(1).minus(r.plus(1).pow(-termMonths)).div(r);
  return num(pmt.mul(annuityFactor), 0, FLOOR);
}

// ───────────────────────────── Нэг сценарийн (суурь / stress) тооцоо ─────────────────────────────

interface Policy {
  maxDti: Decimal;
  minDscr: Decimal;
  maxLtv: Decimal;
  weightThreshold: Decimal;
}

/** Нэг сценарийн Decimal оролт. Өрийн үйлчилгээ = existing + payment */
interface Scenario {
  salary: Decimal;
  /** ЦМУ — сөрөг байж болно (C аргад түүхий хэвээр орно) */
  ncf: Decimal;
  household: Decimal;
  existing: Decimal;
  payment: Decimal;
}

interface Evaluation {
  applicable: boolean;
  base: Decimal;
  total: Decimal;
  ratio: number | null;
  pass: boolean;
}

/** Суурь орлого: A цалин; B бизнесийн ЦМУ; C цалин + ЦМУ − өрхийн зардал (BR-5, түүхий ЦМУ) */
function baseIncomeOf(method: CalcMethod, s: Scenario): Decimal {
  if (method === 'A_SALARY') return s.salary;
  if (method === 'B_BUSINESS') return s.ncf;
  return s.salary.plus(s.ncf).minus(s.household);
}

/** Хэрэглэгдэх (FR-8.6): A — цалин > 0; B — ЦМУ > 0; C — цалин > 0 эсвэл ЦМУ > 0 */
function isApplicable(method: CalcMethod, s: Scenario): boolean {
  if (method === 'A_SALARY') return s.salary.gt(0);
  if (method === 'B_BUSINESS') return s.ncf.gt(0);
  return s.salary.gt(0) || s.ncf.gt(0);
}

/** FR-8.4 · BR-1, BR-2. `pass` бөөрөнхийлөөгүй утгаар (харьцуулалтыг үржвэрээр хийж хуваалтын алдаа оруулахгүй) */
function evaluate(method: CalcMethod, s: Scenario, policy: Policy): Evaluation {
  const total = s.existing.plus(s.payment);
  const base = baseIncomeOf(method, s);
  const applicable = isApplicable(method, s);
  if (!applicable) return { applicable, base, total, ratio: null, pass: false };
  if (method === 'A_SALARY') {
    // BR-1 · ӨОХ = өрийн үйлчилгээ ÷ цалин ≤ maxDti (applicable ⇒ цалин > 0). Харуулах: дээш 4 орон
    return { applicable, base, total, ratio: num(total.div(base), 4, CEIL), pass: total.lte(base.mul(policy.maxDti)) };
  }
  // BR-2 · ӨТЧХ = суурь ÷ өрийн үйлчилгээ ≥ minDscr. Өрийн үйлчилгээ 0 бол ratio тодорхойгүй (null), суурь > 0 үед хангана.
  // Харуулах: доош 2 орон. Суурь ≤ 0 (C) үед үржвэр нь автоматаар хангахгүй.
  if (total.isZero()) return { applicable, base, total, ratio: null, pass: base.gt(0) };
  return { applicable, base, total, ratio: num(base.div(total), 2, FLOOR), pass: base.gte(total.mul(policy.minDscr)) };
}

/** FR-8.3 · боломжит дээд сарын төлбөр (одоогийн өрийг хассан), доош 2 орон; хэрэглэгдэхгүй / сөрөг бол 0 */
function maxPaymentOf(method: CalcMethod, ev: Evaluation, existing: Decimal, policy: Policy): number {
  if (!ev.applicable) return 0;
  const limit = method === 'A_SALARY' ? ev.base.mul(policy.maxDti) : ev.base.div(policy.minDscr);
  return Math.max(0, num(limit.minus(existing), 2, FLOOR));
}

/** FR-8.6 · аргын шалтгаан. Хэрэглэгдэхгүй бол орлогын шалтгаан; хангаагүй бол ӨОХ/ӨТЧХ (C-д суурь ≤ 0 бол үндсэн шалтгаан нь л) */
function methodReasons(method: CalcMethod, ev: Evaluation, s: Scenario): MethodReason[] {
  if (!ev.applicable) {
    if (method === 'A_SALARY') return [reason('NO_SALARY_INCOME')];
    if (method === 'B_BUSINESS') return [reason(s.ncf.isNegative() ? 'NEGATIVE_BUSINESS_NCF' : 'NO_BUSINESS_INCOME')];
    return [reason('NO_INCOME')];
  }
  if (ev.pass) return [];
  if (method === 'A_SALARY') return [reason('DTI_ABOVE_LIMIT')];
  // B-д applicable ⇒ ЦМУ > 0 тул суурь ≤ 0 нь зөвхөн C (цалин + ЦМУ − өрхийн зардал ≤ 0)
  if (!ev.base.gt(0)) return [reason('NON_POSITIVE_BASE_INCOME')];
  return [reason('DSCR_BELOW_MIN')];
}

// ───────────────────────────── Барьцаа (BR-3, FR-6.4) ─────────────────────────────

function evaluateCollateral(amount: Decimal, value: Decimal, required: boolean, maxLtv: number, maxLtvD: Decimal): CollateralVerdict {
  const head = { required, valueTotal: money(value), limit: maxLtv };
  if (value.isZero()) {
    // Шаардлагатай ч үнэлгээ 0 → хангаагүй; шаардахгүй ба хөрөнгөгүй → LTV хамаарахгүй
    return required
      ? { ...head, ltv: null, pass: false, maxAmount: 0, reasons: [reason('NO_COLLATERAL_VALUE')] }
      : { ...head, ltv: null, pass: true, maxAmount: null, reasons: [] };
  }
  // Хөрөнгө байвал шаардлагатай эсэхээс үл хамааран LTV хэрэгжинэ. Яг хязгаарт байвал хангана
  const limitAmount = value.mul(maxLtvD);
  const pass = amount.lte(limitAmount);
  return { ...head, ltv: num(amount.div(value), 4, CEIL), pass, maxAmount: num(limitAmount, 0, FLOOR), reasons: pass ? [] : [reason('LTV_ABOVE_LIMIT')] };
}

// ───────────────────────────── Автомат сонголт (BR-4, FR-8.2) ─────────────────────────────

interface AutoSelection {
  salaryShare: number | null;
  businessShare: number | null;
  autoSelected: CalcMethod | null;
  autoSelectReason: AutoSelectReason;
}

/**
 * Эерэг орлогын бүтэц (цалин⁺, ЦМУ⁺). Хувь > босго (ХАТУУ «>») бол тухайн арга; цалин түрүүлнэ; үгүй бол C.
 * Шалгалтыг үржвэрээр (хувь > босго ⇔ хэсэг > босго × нийлбэр) хийж бөөрөнхийлөлтөөс хамгаална.
 * Босго 0 → эерэг цалинтай бол A; босго 1 → хэзээ ч «давахгүй» тул үргэлж C.
 */
function autoSelect(s: Scenario, threshold: Decimal): AutoSelection {
  const salaryPos = D.max(s.salary, 0);
  const ncfPos = D.max(s.ncf, 0);
  const sum = salaryPos.plus(ncfPos);
  if (sum.isZero()) return { salaryShare: null, businessShare: null, autoSelected: null, autoSelectReason: 'NO_INCOME' };
  const shares = { salaryShare: num(salaryPos.div(sum), 4, HALF_UP), businessShare: num(ncfPos.div(sum), 4, HALF_UP) };
  const limit = sum.mul(threshold);
  if (salaryPos.gt(limit)) return { ...shares, autoSelected: 'A_SALARY', autoSelectReason: 'SALARY_DOMINANT' };
  if (ncfPos.gt(limit)) return { ...shares, autoSelected: 'B_BUSINESS', autoSelectReason: 'BUSINESS_DOMINANT' };
  return { ...shares, autoSelected: 'C_COMBINED', autoSelectReason: 'MIXED' };
}

// ───────────────────────────── underwrite ─────────────────────────────

const METHOD_ORDER: readonly CalcMethod[] = ['A_SALARY', 'B_BUSINESS', 'C_COMBINED'];

/**
 * FR-8.1 · A/B/C гурван аргыг зэрэг бодож харьцуулах гаралт. Үргэлж [A_SALARY, B_BUSINESS, C_COMBINED] дараалалтай.
 * Хүчингүй оролт (NaN/Infinity, дүн ≤ 0, хугацаа < 1, policy хязгаараас гарсан) → RangeError.
 */
export function underwrite(req: ScoreRequest): UnderwriteResult {
  validateRequest(req);
  const { policy } = req;
  const pol: Policy = { maxDti: new D(policy.maxDti), minDscr: new D(policy.minDscr), maxLtv: new D(policy.maxLtv), weightThreshold: new D(policy.weightThreshold) };
  // `collateralRequired` zod default = true → өгөөгүй (undefined) бол шаардлагатай гэж үзнэ (консерватив)
  const required = req.collateralRequired !== false;

  const amount = new D(req.amount);
  const payment = new D(req.monthlyPayment);
  const base: Scenario = {
    salary: new D(req.salaryMonthly),
    ncf: new D(req.businessNcfMonthly),
    household: new D(req.householdExpenseMonthly),
    existing: new D(req.existingDebtServiceMonthly),
    payment,
  };

  // Зээлийн хураангуй (FR-8.3): totalPayable = сарын төлбөр × хугацаа; totalInterest = totalPayable − дүн (2 орон)
  const totalPayable = payment.mul(req.termMonths).toDecimalPlaces(2, HALF_UP);
  const loan: LoanSummary = {
    amount: money(amount),
    termMonths: req.termMonths,
    interestRate: req.interestRate,
    monthlyPayment: money(payment),
    totalPayable: totalPayable.toNumber(),
    totalInterest: money(totalPayable.minus(amount.toDecimalPlaces(2, HALF_UP))),
  };

  const collateral = evaluateCollateral(amount, new D(req.collateralValueTotal), required, policy.maxLtv, pol.maxLtv);

  // FR-8.5 · stress: хүү +п.п. → шинэ annuity төлбөр; эерэг орлого ×(1+Δ); сөрөг ЦМУ, өрхийн зардал, идэвхтэй өр хэвээр
  let stressScenario: Scenario | null = null;
  let stressSummary: UnderwriteResult['stress'] = null;
  if (req.stress) {
    const stressedMonthlyPayment = money(new D(annuityPayment(req.amount, new D(req.interestRate).plus(req.stress.rateDeltaPoints).toNumber(), req.termMonths)));
    const k = new D(1).plus(req.stress.incomeChange);
    stressScenario = {
      salary: base.salary.mul(k),
      ncf: base.ncf.gt(0) ? base.ncf.mul(k) : base.ncf,
      household: base.household,
      existing: base.existing,
      payment: new D(stressedMonthlyPayment),
    };
    stressSummary = { rateDeltaPoints: req.stress.rateDeltaPoints, incomeChange: req.stress.incomeChange, stressedMonthlyPayment };
  }

  const methods = METHOD_ORDER.map((method): MethodVerdict => {
    const ev = evaluate(method, base, pol);
    const maxPayment = maxPaymentOf(method, ev, base.existing, pol);
    const maxAffordable = maxPrincipalForPayment(maxPayment, req.interestRate, req.termMonths);
    let stress: StressOutcome | null = null;
    if (stressScenario) {
      const st = evaluate(method, stressScenario, pol);
      stress = { baseIncome: money(st.base), totalDebtService: money(st.total), ratio: st.ratio, pass: st.pass };
    }
    return {
      method,
      applicable: ev.applicable,
      baseIncome: money(ev.base),
      totalDebtService: money(ev.total),
      ratioKind: method === 'A_SALARY' ? 'DTI' : 'DSCR',
      ratio: ev.ratio,
      limit: method === 'A_SALARY' ? policy.maxDti : policy.minDscr,
      pass: ev.pass,
      // totalDebtService ÷ baseIncome × 100, дээш 1 орон; суурь ≤ 0 бол null (Sosco dtiPercent)
      burdenPercent: ev.base.gt(0) ? num(ev.total.mul(100).div(ev.base), 1, CEIL) : null,
      eligible: ev.applicable && ev.pass && collateral.pass,
      maxPayment,
      maxAffordable,
      // FR-8.3 · min(төлбөрийн чадвараар, LTV-ээр); барьцааны хязгааргүй (maxAmount = null) бол чадвараар
      maxLoanAmount: collateral.maxAmount === null ? maxAffordable : Math.min(maxAffordable, collateral.maxAmount),
      reasons: methodReasons(method, ev, base),
      stress,
    };
  });

  const auto = autoSelect(base, pol.weightThreshold);
  return {
    applicationId: req.applicationId,
    loan,
    methods,
    incomeMix: { salaryShare: auto.salaryShare, businessShare: auto.businessShare, weightThreshold: policy.weightThreshold },
    autoSelected: auto.autoSelected,
    autoSelectReason: auto.autoSelectReason,
    collateral,
    stress: stressSummary,
    policy: { maxDti: policy.maxDti, minDscr: policy.minDscr, maxLtv: policy.maxLtv, weightThreshold: policy.weightThreshold },
  };
}
