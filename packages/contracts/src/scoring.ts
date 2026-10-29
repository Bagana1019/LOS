import { z } from 'zod';
import { CalcMethod } from './enums';

// Модуль 8 — Тооцоолол (FR-8, BR-1…BR-5) ба дотоод Sosco Score. Дэлгэрэнгүй: docs/05-scoring-sosco.md.
// Энэ файл нь origination ↔ scoring (sync REST), origination → web, `@los/calc` гурвын ЦОРЫН ГАНЦ гэрээ.
// Нэгж: мөнгө ₮ (хоёр оронтой), хувь бутархай (0.55 = 55%) — ЭСВЭЛ нэрэнд `Percent`/`Points` байвал хувь/п.п. (5 = 5%).
// `interestRate` нь жилийн хувь (23.99), products.min_rate/max_rate-тэй ижил (docs/DECISIONS.md FR-5.5).

export const CalcMethodCode = z.enum(CalcMethod);

// ───────────────────────────── Бодлого (BR-1…BR-4, FR-8.5) ─────────────────────────────

/** `setting`-ээс (origination) уншигдаж scoring-д дамжина — scoring BR утгыг hardcode хийхгүй */
export const UnderwritingPolicy = z.object({
  /** BR-1 · ӨОХ дээд (A арга). 0.55 */
  maxDti: z.number().gt(0).max(1),
  /** BR-2 · ӨТЧХ доод (B, C арга). 1.25 */
  minDscr: z.number().gt(0).max(100),
  /** BR-3 · LTV дээд. 0.7 */
  maxLtv: z.number().gt(0).max(1),
  /** BR-4 · автомат сонголтын жингийн босго. 0.7 */
  weightThreshold: z.number().min(0).max(1),
});
export type UnderwritingPolicy = z.infer<typeof UnderwritingPolicy>;

/** FR-8.5 · stress. `setting` `stress.rate_delta` (0.05) → rateDeltaPoints 5; `stress.income_delta` (−0.2) → incomeChange −0.2 */
export const StressPolicy = z.object({
  /** Хүү өснө (п.п.): 5 = +5 пунктын хувь */
  rateDeltaPoints: z.number().finite().min(0).max(100),
  /** Орлого буурна: −0.2 = −20% (зөвхөн эерэг орлогод; сөрөг ЦМУ-д нөлөөлөхгүй) */
  incomeChange: z.number().finite().min(-1).max(0),
});
export type StressPolicy = z.infer<typeof StressPolicy>;

const Money = z.number().finite().min(0).max(9e13);

// ───────────────────────────── Оролт: origination → scoring ─────────────────────────────

export const ScoreRequest = z.object({
  applicationId: z.string().min(1).max(128),
  /** Хүссэн зээлийн дүн (₮) */
  amount: z.number().finite().positive().max(9e13),
  termMonths: z.number().int().min(1).max(600),
  /** Жилийн хувь: 23.99 */
  interestRate: z.number().finite().min(0).max(1000),
  /** Шинэ зээлийн сарын төлбөр (ЭТХ-ээс; ЭТХ байхгүй бол origination annuity-аар тооцно) */
  monthlyPayment: Money,
  /** Сарын дундаж цалин (НДШ + гар цалин), хамтран зээлдэгчийн орлого нэгтгэсэн */
  salaryMonthly: Money,
  /** Бизнесийн ЦМУ (BSA). Алдагдалтай бол сөрөг */
  businessNcfMonthly: z.number().finite().min(-9e13).max(9e13),
  householdExpenseMonthly: Money,
  /** Идэвхтэй зээлүүдийн сарын төлбөр (ЗМС/BSA) */
  existingDebtServiceMonthly: Money,
  /** Σ барьцааны үнэлгээ (haircut-тай) */
  collateralValueTotal: Money,
  /** Барьцаагүй бүтээгдэхүүнд false: хөрөнгө байхгүй бол LTV шалгуур хамаарахгүй (FR-6.4) */
  collateralRequired: z.boolean().default(true),
  policy: UnderwritingPolicy,
  stress: StressPolicy.optional(),
});
export type ScoreRequest = z.infer<typeof ScoreRequest>;
/** Оролтын (default-тай) хэлбэр — HTTP body-д `collateralRequired`-г орхиж болно */
export type ScoreRequestInput = z.input<typeof ScoreRequest>;

// ───────────────────────────── Үр дүн ─────────────────────────────

/** FR-8.6 · шалтгаан хамаарах wizard-ийн алхам (StepKey-ийн дэд олонлог) */
export const ReasonStep = z.enum(['client', 'inquiry', 'income', 'loan', 'collateral', 'installment']);
export type ReasonStep = z.infer<typeof ReasonStep>;

export const ReasonCode = z.enum([
  'NO_SALARY_INCOME', // A: цалингийн орлого байхгүй
  'NO_BUSINESS_INCOME', // B: бизнесийн ЦМУ байхгүй (BSA хийгдээгүй эсвэл 0)
  'NEGATIVE_BUSINESS_NCF', // B: бизнесийн ЦМУ сөрөг
  'NO_INCOME', // C: цалин, бизнесийн орлого аль нь ч байхгүй
  'NON_POSITIVE_BASE_INCOME', // C: өрхийн зардал хассны дараах суурь орлого ≤ 0
  'DTI_ABOVE_LIMIT', // A: ӨОХ дээд хязгаараас их
  'DSCR_BELOW_MIN', // B/C: ӨТЧХ доод хязгаараас бага
  'NO_COLLATERAL_VALUE', // барьцаа шаардлагатай ч үнэлгээ байхгүй
  'LTV_ABOVE_LIMIT', // LTV дээд хязгаараас их
  'LOAN_TERMS_MISSING', // зээлийн нөхцөл (дүн/хугацаа/хүү) бөглөгдөөгүй — origination
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const MethodReason = z.object({ code: ReasonCode, step: ReasonStep, message: z.string() });
export type MethodReason = z.infer<typeof MethodReason>;

export const StressOutcome = z.object({
  baseIncome: z.number(),
  totalDebtService: z.number(),
  ratio: z.number().nullable(),
  pass: z.boolean(),
});
export type StressOutcome = z.infer<typeof StressOutcome>;

export const RatioKind = z.enum(['DTI', 'DSCR']);

/** Нэг аргын (A/B/C) дүгнэлт. FR-8.1 харьцуулах хүснэгтийн нэг багана */
export const MethodVerdict = z.object({
  method: CalcMethodCode,
  /** Орлогын суурь байгаа эсэх; false бол сонгож болохгүй, `reasons` шалтгаантай (FR-8.6) */
  applicable: z.boolean(),
  /** A: цалин; B: бизнесийн ЦМУ; C: цалин + ЦМУ − өрхийн зардал (BR-5) */
  baseIncome: z.number(),
  /** Идэвхтэй зээлийн төлбөр + шинэ зээлийн сарын төлбөр */
  totalDebtService: z.number(),
  ratioKind: RatioKind,
  /** A: ӨОХ (бутархай, дээш тоймлосон 4 орон); B/C: ӨТЧХ (доош тоймлосон 2 орон). Тооцох боломжгүй бол null */
  ratio: z.number().nullable(),
  /** A: maxDti; B/C: minDscr */
  limit: z.number(),
  /** ratio-ийн бөөрөнхийлөөгүй утгаар шийдэгдсэн; applicable=false бол false */
  pass: z.boolean(),
  /** totalDebtService ÷ baseIncome × 100 (1 орон, дээш) — Sosco-ийн dtiPercent, ScoringCompleted.dtiPercent */
  burdenPercent: z.number().nullable(),
  /** applicable && pass && collateral.pass */
  eligible: z.boolean(),
  /** Боломжит дээд сарын төлбөр (одоогийн өрийг хассан) */
  maxPayment: z.number(),
  /** Төлбөрийн чадвараар боломжит дээд дүн (annuity, доош бүхэл ₮) */
  maxAffordable: z.number(),
  /** min(maxAffordable, LTV-ээр хязгаарлагдсан дүн) */
  maxLoanAmount: z.number(),
  reasons: z.array(MethodReason),
  /** FR-8.5. stress өгөөгүй бол null */
  stress: StressOutcome.nullable(),
});
export type MethodVerdict = z.infer<typeof MethodVerdict>;

export const CollateralVerdict = z.object({
  required: z.boolean(),
  valueTotal: z.number(),
  /** amount ÷ valueTotal (дээш тоймлосон 4 орон); valueTotal = 0 бол null */
  ltv: z.number().nullable(),
  limit: z.number(),
  pass: z.boolean(),
  /** valueTotal × maxLtv (доош бүхэл ₮); хязгааргүй (барьцаа шаардахгүй, хөрөнгөгүй) бол null */
  maxAmount: z.number().nullable(),
  reasons: z.array(MethodReason),
});
export type CollateralVerdict = z.infer<typeof CollateralVerdict>;

export const LoanSummary = z.object({
  amount: z.number(),
  termMonths: z.number().int(),
  interestRate: z.number(),
  monthlyPayment: z.number(),
  /** monthlyPayment × termMonths (annuity-тай тэнцэх тооцоо; бусад төрөлд ойролцоо) */
  totalPayable: z.number(),
  /** totalPayable − amount (FR-8.3 хүүгийн орлого) */
  totalInterest: z.number(),
});
export type LoanSummary = z.infer<typeof LoanSummary>;

export const AutoSelectReason = z.enum(['SALARY_DOMINANT', 'BUSINESS_DOMINANT', 'MIXED', 'NO_INCOME']);
export type AutoSelectReason = z.infer<typeof AutoSelectReason>;

export const UnderwriteResult = z.object({
  applicationId: z.string(),
  loan: LoanSummary,
  /** Үргэлж [A_SALARY, B_BUSINESS, C_COMBINED] дарааллаар */
  methods: z.array(MethodVerdict).length(3),
  /** BR-4: эерэг орлогын бүтэц; нийт 0 бол null */
  incomeMix: z.object({ salaryShare: z.number().nullable(), businessShare: z.number().nullable(), weightThreshold: z.number() }),
  /** BR-4. Орлого огт байхгүй бол null */
  autoSelected: CalcMethodCode.nullable(),
  autoSelectReason: AutoSelectReason,
  collateral: CollateralVerdict,
  /** FR-8.5. stress өгөөгүй бол null */
  stress: z.object({ rateDeltaPoints: z.number(), incomeChange: z.number(), stressedMonthlyPayment: z.number() }).nullable(),
  policy: UnderwritingPolicy,
});
export type UnderwriteResult = z.infer<typeof UnderwriteResult>;

// ───────────────────────────── Хадгалагдсан тооцоолол (scoring.calculation) ─────────────────────────────

export const SelectionKind = z.enum(['AUTO', 'MANUAL']);

export const CalculationRecord = z.object({
  id: z.string(),
  applicationId: z.string(),
  /** Үндсэн зээлдэгч (Sosco Score-ийн субьект) */
  customerId: z.string().nullable(),
  computedAt: z.string().datetime(),
  isStale: z.boolean(),
  staleReason: z.string().nullable(),
  selectedMethod: CalcMethodCode.nullable(),
  selection: SelectionKind.nullable(),
  selectedBy: z.string().nullable(),
  selectedAt: z.string().datetime().nullable(),
  selectionReason: z.string().nullable(),
  inputs: ScoreRequest,
  result: UnderwriteResult,
});
export type CalculationRecord = z.infer<typeof CalculationRecord>;

/** `POST /api/underwrite` (persist). origination → scoring */
export const UnderwritePersistRequest = z.object({
  request: ScoreRequest,
  customerId: z.string().min(1).max(128),
  /** Өмнөх гар сонголтыг хадгалах (боломжтой бол). Өгөөгдөхгүй бол автомат */
  selectedMethod: CalcMethodCode.nullish(),
  selectionReason: z.string().trim().max(500).nullish(),
});
export type UnderwritePersistRequest = z.infer<typeof UnderwritePersistRequest>;

const noNul = (s: string) => !s.includes('\u0000'); // PostgreSQL text NUL-г хүлээн авдаггүй → 500/503 биш 400 VALIDATION_FAILED
export const SelectMethodRequest = z.object({ method: CalcMethodCode, reason: z.string().trim().max(500).refine(noNul, 'NUL тэмдэгт зөвшөөрөгдөхгүй').nullish() });
export type SelectMethodRequest = z.infer<typeof SelectMethodRequest>;

export const MarkCalculationStaleRequest = z.object({ reason: z.string().trim().min(1).max(200).refine(noNul, 'NUL тэмдэгт зөвшөөрөгдөхгүй') });
export type MarkCalculationStaleRequest = z.infer<typeof MarkCalculationStaleRequest>;

// ───────────────────────────── Sosco Score ─────────────────────────────

export const SOSCO_COMPONENTS = ['fico', 'dti', 'reliability', 'suspicious', 'history', 'ltv'] as const;
export type SoscoComponentKey = (typeof SOSCO_COMPONENTS)[number];
export const SoscoComponentKeyCode = z.enum(SOSCO_COMPONENTS);

/** Мэдэгдэхгүй (null) оролт нь тухайн бүрэлдэхүүнийг оноонд оруулахгүй — жинг үлдсэн бүрэлдэхүүнд дахин хуваарилна (шагнахгүй, шийтгэхгүй) */
export const SoscoInput = z.object({
  /** ЗМС/FICO оноо */
  ficoScore: z.number().finite().min(0).max(1000).nullable(),
  /** Өр/орлогын харьцаа, % (BSA-ийн dtiPercent эсвэл Тооцоололын burdenPercent) */
  dtiPercent: z.number().finite().min(0).nullable(),
  /** BSA орлогын найдвар 0..100 */
  incomeReliability: z.number().finite().min(0).max(100).nullable(),
  /** BSA хүлээгдэж буй сэжигтэй дохио; BSA байхгүй бол null */
  pendingSuspiciousCount: z.number().int().min(0).nullable(),
  activeLoanCount: z.number().int().min(0).nullable(),
  /** Сүүлийн хугацаанд хугацаа хэтэрсэн сарын тоо (ЗМС); мэдэгдэхгүй бол null */
  overdueHistoryMonths: z.number().int().min(0).nullable(),
  /** Тооцоололын collateral.ltv; барьцаагүй бол null */
  ltv: z.number().finite().min(0).nullable(),
});
export type SoscoInput = z.infer<typeof SoscoInput>;

const Weight = z.number().finite().min(0).max(1);
export const SoscoWeights = z
  .object({ fico: Weight, dti: Weight, reliability: Weight, suspicious: Weight, history: Weight, ltv: Weight })
  .refine((w) => Math.abs(w.fico + w.dti + w.reliability + w.suspicious + w.history + w.ltv - 1) <= 1e-9, { message: 'weights must sum to 1' });
export type SoscoWeights = z.infer<typeof SoscoWeights>;

export const SoscoGrade = z.enum(['A', 'B', 'C', 'D', 'E']);
export type SoscoGrade = z.infer<typeof SoscoGrade>;

const Threshold = z.number().int().min(0).max(1000);
/** Доод хязгаар: score ≥ A → A … E үргэлж 0. A > B > C > D > E */
export const SoscoGradeThresholds = z
  .object({ A: Threshold, B: Threshold, C: Threshold, D: Threshold, E: Threshold })
  .refine((t) => t.A > t.B && t.B > t.C && t.C > t.D && t.D > t.E && t.E === 0, { message: 'thresholds must be strictly decreasing and E must be 0' });
export type SoscoGradeThresholds = z.infer<typeof SoscoGradeThresholds>;

/** Бүрэлдэхүүн бүрийг 0..1 болгох муруйн параметр (sosco_model.params_json). Анхдагч утга: DEMO — `DEFAULT_SOSCO_CURVES` (@los/calc) */
export const SoscoCurves = z.object({
  fico: z.object({ min: z.number().finite(), max: z.number().finite() }).refine((r) => r.max > r.min, { message: 'fico.max must exceed fico.min' }),
  dti: z.object({ bestPercent: z.number().finite().min(0), worstPercent: z.number().finite().min(0) }).refine((r) => r.worstPercent > r.bestPercent, { message: 'dti.worstPercent must exceed bestPercent' }),
  ltv: z.object({ best: z.number().finite().min(0), worst: z.number().finite().min(0) }).refine((r) => r.worst > r.best, { message: 'ltv.worst must exceed best' }),
  /** Хүлээгдэж буй сэжигтэй дохио бүрийн хасалт (0..1) */
  suspiciousPenaltyPerFlag: z.number().finite().min(0).max(1),
  history: z.object({
    /** Энэ сар ба түүнээс дээш хугацаа хэтэрсэн бол бүрэлдэхүүн 0 */
    overdueMonthsWorst: z.number().finite().positive(),
    /** Идэвхтэй зээл бүрийн хасалт (0..1) */
    activeLoanPenalty: z.number().finite().min(0).max(1),
  }),
  /** Оноо гаргахад шаардлагатай хамгийн бага жингийн хамрах хувь (0..1); дутвал INSUFFICIENT_DATA */
  minCoverage: z.number().finite().min(0).max(1),
});
export type SoscoCurves = z.infer<typeof SoscoCurves>;

export const SoscoComponentBreakdown = z.object({
  key: SoscoComponentKeyCode,
  available: z.boolean(),
  /** Оролтын утга (тайлбарт) */
  input: z.number().nullable(),
  /** 0..1 */
  normalized: z.number().nullable(),
  /** Загварын жин */
  weight: z.number(),
  /** Мэдэгдэх бүрэлдэхүүнд дахин хуваарилсан жин (нийлбэр 1); боломжгүй бол 0 */
  effectiveWeight: z.number(),
  /** 1000 онооны хэдийг энэ бүрэлдэхүүн өгсөн (1 орон) */
  points: z.number(),
});
export type SoscoComponentBreakdown = z.infer<typeof SoscoComponentBreakdown>;

export const SoscoStatus = z.enum(['SCORED', 'INSUFFICIENT_DATA']);

export const SoscoScoreResult = z.object({
  status: SoscoStatus,
  /** 0..1000 бүхэл; INSUFFICIENT_DATA үед null */
  score: z.number().int().min(0).max(1000).nullable(),
  grade: SoscoGrade.nullable(),
  /** Мэдэгдсэн бүрэлдэхүүнүүдийн жингийн нийлбэр 0..1 */
  coverage: z.number(),
  components: z.array(SoscoComponentBreakdown).length(6),
  modelVersion: z.number().int(),
});
export type SoscoScoreResult = z.infer<typeof SoscoScoreResult>;

/** `POST /api/sosco/score`. origination → scoring */
export const SoscoScoreRequest = z.object({
  applicationId: z.string().min(1).max(128),
  customerId: z.string().min(1).max(128),
  input: SoscoInput,
  /** false бол зөвхөн тооцоолно (хадгалахгүй) */
  persist: z.boolean().default(true),
});
export type SoscoScoreRequest = z.infer<typeof SoscoScoreRequest>;

export const SoscoScoreResponse = SoscoScoreResult.extend({
  /** Хадгалагдаагүй (persist=false эсвэл INSUFFICIENT_DATA) бол null */
  resultId: z.string().nullable(),
  modelId: z.string(),
  computedAt: z.string().datetime(),
});
export type SoscoScoreResponse = z.infer<typeof SoscoScoreResponse>;

export const SoscoModelView = z.object({
  id: z.string(),
  version: z.number().int(),
  isActive: z.boolean(),
  weights: SoscoWeights,
  gradeThresholds: SoscoGradeThresholds,
  curves: SoscoCurves,
  createdAt: z.string().datetime(),
  createdBy: z.string().nullable(),
});
export type SoscoModelView = z.infer<typeof SoscoModelView>;

/** `PUT /api/sosco/models` (settings:manage) — шинэ хувилбар үүсгэж идэвхжүүлнэ; өмнөхийг идэвхгүй болгоно */
export const SaveSoscoModelRequest = z.object({ weights: SoscoWeights, gradeThresholds: SoscoGradeThresholds, curves: SoscoCurves.optional() });
export type SaveSoscoModelRequest = z.infer<typeof SaveSoscoModelRequest>;

// ───────────────────────────── origination → web (wizard 7-р алхам `score`) ─────────────────────────────

/** BR-6 · slider-ийн хязгаар (product) */
export const ScoreLimits = z.object({
  minAmount: z.number(), maxAmount: z.number(), minTermMonths: z.number().int(), maxTermMonths: z.number().int(), minRate: z.number(), maxRate: z.number(),
});
export type ScoreLimits = z.infer<typeof ScoreLimits>;

export const ScoreTerms = z.object({ amount: z.number().positive(), termMonths: z.number().int().min(1), interestRate: z.number().min(0) });
export type ScoreTerms = z.infer<typeof ScoreTerms>;

export const SoscoSummary = z.object({
  resultId: z.string().nullable(),
  customerId: z.string(),
  status: SoscoStatus,
  score: z.number().int().nullable(),
  grade: SoscoGrade.nullable(),
  coverage: z.number(),
  components: z.array(SoscoComponentBreakdown),
  modelVersion: z.number().int(),
  computedAt: z.string().datetime(),
});
export type SoscoSummary = z.infer<typeof SoscoSummary>;

export const ScoreOverview = z.object({
  applicationId: z.string(),
  /** Тооцоолох/сонгох эрхтэй эсэх (төлөв DRAFT/RETURNED + ЗЭЗ) */
  editable: z.boolean(),
  /** Зээлийн нөхцөл (алхам 4) — байхгүй бол null, `blockers`-д LOAN_TERMS_MISSING */
  terms: ScoreTerms.nullable(),
  limits: ScoreLimits.nullable(),
  /** Тооцоолол явуулахаас өмнөх саад (нөхцөл дутуу гэх мэт) */
  blockers: z.array(MethodReason),
  calculation: CalculationRecord.nullable(),
  sosco: SoscoSummary.nullable(),
});
export type ScoreOverview = z.infer<typeof ScoreOverview>;

/** `POST …/score/preview` — slider (FR-8.3). Өгөөгүй талбар = хүсэлтийн одоогийн нөхцөл. Хадгалахгүй */
export const ScorePreviewRequest = z.object({
  amount: z.number().finite().positive().optional(),
  termMonths: z.number().int().min(1).optional(),
  interestRate: z.number().finite().min(0).optional(),
});
export type ScorePreviewRequest = z.infer<typeof ScorePreviewRequest>;

export const ScorePreviewResponse = z.object({ terms: ScoreTerms, result: UnderwriteResult });
export type ScorePreviewResponse = z.infer<typeof ScorePreviewResponse>;

/** Тогтвортой алдааны кодууд (DomainError.code) */
export const SCORING_ERROR_CODES = [
  'CALCULATION_NOT_FOUND', 'CALCULATION_STALE', 'METHOD_NOT_APPLICABLE', 'NO_SELECTABLE_METHOD', 'SOSCO_MODEL_NOT_FOUND', 'INVALID_SOSCO_MODEL',
  'LOAN_TERMS_MISSING', 'OUT_OF_PRODUCT_LIMITS', 'APPLICATION_NOT_EDITABLE', 'SCORING_UNAVAILABLE',
] as const;
export type ScoringErrorCode = (typeof SCORING_ERROR_CODES)[number];
