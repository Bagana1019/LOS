// Sosco Score — дотоод зээлжих чадварын оноо (0–1000). Логик нь энэ monorepo-д бичигдэнэ (шийдвэр 2026-10-28).
// Жин, босго, муруй — scoring.sosco_model хүснэгтээс (admin). Дэлгэрэнгүй: docs/05-scoring-sosco.md §3.
// Цэвэр функц — I/O байхгүй. Тооцоо бүхэлдээ Decimal (40 орон, ROUND_HALF_UP; bsa-dti.ts-тэй ижил) тул үр дүн float drift-гүй,
// давтагдахуйц. Тайлагдах утга бүр бүрэн нарийвчлалаас НЭГ удаа бөөрөнхийлөгдөнө. Алдаатай оролт/загвар → RangeError (zod-гүй дуудахад ч).
import Decimal from 'decimal.js';
import { SOSCO_COMPONENTS } from '@los/contracts';
import type { SoscoComponentBreakdown, SoscoComponentKey, SoscoCurves, SoscoGrade, SoscoGradeThresholds, SoscoInput, SoscoScoreResult, SoscoWeights } from '@los/contracts';

export type { SoscoCurves, SoscoGradeThresholds, SoscoInput, SoscoScoreResult, SoscoWeights } from '@los/contracts';

/** DEMO таамаг (docs/DECISIONS.md): бодит эрсдэлийн загвар ирэхэд admin `sosco_model`-оор солино */
export const DEFAULT_SOSCO_WEIGHTS: SoscoWeights = { fico: 0.3, dti: 0.25, reliability: 0.15, suspicious: 0.1, history: 0.15, ltv: 0.05 };
export const DEFAULT_SOSCO_GRADE_THRESHOLDS: SoscoGradeThresholds = { A: 800, B: 700, C: 600, D: 500, E: 0 };
export const DEFAULT_SOSCO_CURVES: SoscoCurves = {
  fico: { min: 300, max: 850 },
  dti: { bestPercent: 20, worstPercent: 80 },
  ltv: { best: 0.3, worst: 1 },
  suspiciousPenaltyPerFlag: 0.2,
  history: { overdueMonthsWorst: 12, activeLoanPenalty: 0.05 },
  minCoverage: 0.5,
};

// ───────────────────────── Дотоод туслахууд (экспортлогдохгүй) ─────────────────────────

/** Глобал Decimal тохиргоонд нөлөөлөхгүй тусдаа clone: 40 орон, ROUND_HALF_UP */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new D(0);
const ONE = new D(1);

/** Оноо ба зэргийн босгын дээд заг (risk-pricing.ts-ийн SOSCO_SCORE_MAX-тай давхцахгүйн тулд дотоод) */
const SCORE_MAX = 1000;
/** Жингийн нийлбэрийн зөвшөөрөгдөх хазайлт — contracts-ийн `SoscoWeights` refine-тай ижил (1e-9) */
const WEIGHT_SUM_TOLERANCE = new D('1e-9');
/** coverage-ийг тайланд гаргах нарийвчлал (орон) */
const COVERAGE_DP = 4;
/** points-ийг тайланд гаргах нарийвчлал (орон) */
const POINTS_DP = 1;

/** Тайланд гаргахдаа нэг л удаа бөөрөнхийлнө; `+ 0` нь -0-г 0 болгоно */
const round = (x: Decimal, dp: number): number => x.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toNumber() + 0;
const toNumber = (x: Decimal): number => x.toNumber() + 0;
const clamp01 = (x: Decimal): Decimal => (x.lt(ZERO) ? ZERO : x.gt(ONE) ? ONE : x);
const sumOf = (xs: Iterable<Decimal>): Decimal => {
  let s = ZERO;
  for (const x of xs) s = s.plus(x);
  return s;
};

// ── шалгалт ──

/** Хязгаартай төгсгөлөг тоо. `Number.isFinite` нь тоо биш утгыг (string, undefined, null) шууд хаяна */
function assertNum(name: string, v: number, min: number, max: number): void {
  if (!(Number.isFinite(v) && v >= min && v <= max)) throw new RangeError(`${name} must be a finite number within [${min}, ${max}], got ${String(v)}`);
}

function assertCount(name: string, v: number): void {
  if (!(Number.isInteger(v) && v >= 0)) throw new RangeError(`${name} must be an integer >= 0, got ${String(v)}`);
}

/** low < high (хоёул төгсгөлөг, `floor`-оос багагүй) — «хамгийн сайн/муу» хоёр үзүүрийн муруй */
function assertOrdered(path: string, lowKey: string, low: number, highKey: string, high: number, floor: number): void {
  assertNum(`${path}.${lowKey}`, low, floor, Infinity);
  assertNum(`${path}.${highKey}`, high, floor, Infinity);
  if (!(high > low)) throw new RangeError(`${path}.${highKey} (${high}) must exceed ${path}.${lowKey} (${low})`);
}

const assertFicoCurve = (c: SoscoCurves['fico']): void => assertOrdered('curves.fico', 'min', c.min, 'max', c.max, -Infinity);
const assertDtiCurve = (c: SoscoCurves['dti']): void => assertOrdered('curves.dti', 'bestPercent', c.bestPercent, 'worstPercent', c.worstPercent, 0);
const assertLtvCurve = (c: SoscoCurves['ltv']): void => assertOrdered('curves.ltv', 'best', c.best, 'worst', c.worst, 0);
const assertPenalty = (name: string, v: number): void => assertNum(name, v, 0, 1);
const assertHistoryCurve = (c: SoscoCurves['history']): void => {
  // overdueMonthsWorst > 0 (хуваагч) — 0 байж болохгүй
  assertNum('curves.history.overdueMonthsWorst', c.overdueMonthsWorst, 0, Infinity);
  if (c.overdueMonthsWorst === 0) throw new RangeError('curves.history.overdueMonthsWorst must be > 0, got 0');
  assertPenalty('curves.history.activeLoanPenalty', c.activeLoanPenalty);
};

function assertWeights(w: SoscoWeights): void {
  for (const k of SOSCO_COMPONENTS) assertNum(`weights.${k}`, w[k], 0, 1);
  const sum = sumOf(SOSCO_COMPONENTS.map((k) => new D(w[k])));
  if (sum.minus(ONE).abs().gt(WEIGHT_SUM_TOLERANCE)) throw new RangeError(`weights must sum to 1 (+-1e-9), got ${sum.toString()}`);
}

const GRADE_KEYS = ['A', 'B', 'C', 'D', 'E'] as const;

function assertThresholds(t: SoscoGradeThresholds): void {
  for (const g of GRADE_KEYS) {
    if (!(Number.isInteger(t[g]) && t[g] >= 0 && t[g] <= SCORE_MAX)) throw new RangeError(`gradeThresholds.${g} must be an integer within [0, ${SCORE_MAX}], got ${String(t[g])}`);
  }
  if (!(t.A > t.B && t.B > t.C && t.C > t.D && t.D > t.E)) {
    throw new RangeError(`gradeThresholds must be strictly decreasing A > B > C > D > E, got ${t.A}/${t.B}/${t.C}/${t.D}/${t.E}`);
  }
  if (t.E !== 0) throw new RangeError(`gradeThresholds.E must be 0 so every score has a grade, got ${t.E}`);
}

function assertCurves(c: SoscoCurves): void {
  assertFicoCurve(c.fico);
  assertDtiCurve(c.dti);
  assertLtvCurve(c.ltv);
  assertPenalty('curves.suspiciousPenaltyPerFlag', c.suspiciousPenaltyPerFlag);
  assertHistoryCurve(c.history);
  assertNum('curves.minCoverage', c.minCoverage, 0, 1);
}

/** Мэдэгдэхгүй (null) зөвшөөрөгдөнө; бусад нь хүчинтэй. `undefined` (талбар дутуу) нь null биш тул алдаа */
function assertSoscoInput(i: SoscoInput): void {
  if (i.ficoScore !== null) assertNum('ficoScore', i.ficoScore, 0, Infinity);
  if (i.dtiPercent !== null) assertNum('dtiPercent', i.dtiPercent, 0, Infinity);
  if (i.incomeReliability !== null) assertNum('incomeReliability', i.incomeReliability, 0, 100);
  if (i.pendingSuspiciousCount !== null) assertCount('pendingSuspiciousCount', i.pendingSuspiciousCount);
  if (i.activeLoanCount !== null) assertCount('activeLoanCount', i.activeLoanCount);
  if (i.overdueHistoryMonths !== null) assertCount('overdueHistoryMonths', i.overdueHistoryMonths);
  if (i.ltv !== null) assertNum('ltv', i.ltv, 0, Infinity);
}

// ── 0..1 болгох (Decimal; экспортлогдох normalizeXxx нь эдгээрийг шалгалттай ороож number буцаана) ──

/** Өсөх шугаман: x ≤ min → 0; x ≥ max → 1 */
const ascending = (x: number, min: number, max: number): Decimal => clamp01(new D(x).minus(min).div(new D(max).minus(min)));
/** Буурах шугаман: x ≤ best → 1; x ≥ worst → 0 */
const descending = (x: number, best: number, worst: number): Decimal => clamp01(new D(worst).minus(x).div(new D(worst).minus(best)));

const unitFico = (fico: number, c: SoscoCurves['fico']): Decimal => ascending(fico, c.min, c.max);
const unitDti = (dtiPercent: number, c: SoscoCurves['dti']): Decimal => descending(dtiPercent, c.bestPercent, c.worstPercent);
const unitReliability = (reliability: number): Decimal => clamp01(new D(reliability).div(100));
const unitSuspicious = (count: number, penaltyPerFlag: number): Decimal => clamp01(ONE.minus(new D(penaltyPerFlag).mul(count)));
const unitHistory = (overdueMonths: number, activeLoans: number, c: SoscoCurves['history']): Decimal =>
  clamp01(ONE.minus(new D(overdueMonths).div(c.overdueMonthsWorst)).minus(new D(c.activeLoanPenalty).mul(activeLoans)));
const unitLtv = (ltv: number, c: SoscoCurves['ltv']): Decimal => descending(ltv, c.best, c.worst);

// ───────────────────────────────── Экспортлогдох функцууд ─────────────────────────────────

/**
 * fico бүрэлдэхүүн: `(fico − min) ÷ (max − min)`, муруйн гадна 0..1-д хязгаарлана (max-аас дээш → 1).
 * fico < 0, төгсгөлгүй/NaN, эсвэл муруй (max ≤ min) алдаатай бол RangeError.
 */
export function normalizeFico(fico: number, curve: SoscoCurves['fico']): number {
  assertNum('ficoScore', fico, 0, Infinity);
  assertFicoCurve(curve);
  return toNumber(unitFico(fico, curve));
}

/** dti бүрэлдэхүүн: dtiPercent ≤ bestPercent → 1; ≥ worstPercent → 0; хоорондоо шугаман. dtiPercent < 0 бол RangeError. */
export function normalizeDti(dtiPercent: number, curve: SoscoCurves['dti']): number {
  assertNum('dtiPercent', dtiPercent, 0, Infinity);
  assertDtiCurve(curve);
  return toNumber(unitDti(dtiPercent, curve));
}

/** reliability бүрэлдэхүүн: `incomeReliability ÷ 100` (BSA, 0..100). Муж давбал RangeError. */
export function normalizeReliability(incomeReliability: number): number {
  assertNum('incomeReliability', incomeReliability, 0, 100);
  return toNumber(unitReliability(incomeReliability));
}

/** suspicious бүрэлдэхүүн: `1 − penaltyPerFlag × тоо`, доод заг 0. Тоо сөрөг/бүхэл биш бол RangeError. */
export function normalizeSuspicious(pendingSuspiciousCount: number, penaltyPerFlag: SoscoCurves['suspiciousPenaltyPerFlag']): number {
  assertCount('pendingSuspiciousCount', pendingSuspiciousCount);
  assertPenalty('curves.suspiciousPenaltyPerFlag', penaltyPerFlag);
  return toNumber(unitSuspicious(pendingSuspiciousCount, penaltyPerFlag));
}

/**
 * history бүрэлдэхүүн: `1 − сар ÷ overdueMonthsWorst − activeLoanPenalty × идэвхтэй зээл`, 0..1-д хязгаарлана
 * (`overdueMonthsWorst` ба түүнээс дээш сар → 0). `activeLoanCount` нь тоолуур тул `null` (мэдэгдэхгүй) бол дуудагч 0 дамжуулна.
 */
export function normalizeHistory(overdueHistoryMonths: number, activeLoanCount: number, curve: SoscoCurves['history']): number {
  assertCount('overdueHistoryMonths', overdueHistoryMonths);
  assertCount('activeLoanCount', activeLoanCount);
  assertHistoryCurve(curve);
  return toNumber(unitHistory(overdueHistoryMonths, activeLoanCount, curve));
}

/** ltv бүрэлдэхүүн: ltv ≤ best → 1; ≥ worst → 0; хоорондоо шугаман. ltv < 0 бол RangeError. */
export function normalizeLtv(ltv: number, curve: SoscoCurves['ltv']): number {
  assertNum('ltv', ltv, 0, Infinity);
  assertLtvCurve(curve);
  return toNumber(unitLtv(ltv, curve));
}

/** Оноо → зэрэг: A, B, C, D, E-ийн эхнийх нь босго ≤ оноо. Оноо 0..1000-аас гарвал, босго алдаатай бол RangeError. */
export function gradeFor(score: number, thresholds: SoscoGradeThresholds): SoscoGrade {
  assertThresholds(thresholds);
  assertNum('score', score, 0, SCORE_MAX);
  if (score >= thresholds.A) return 'A';
  if (score >= thresholds.B) return 'B';
  if (score >= thresholds.C) return 'C';
  if (score >= thresholds.D) return 'D';
  return 'E'; // E = 0 (assertThresholds) тул 0..1000 дотор үргэлж таарна
}

/**
 * `sosco_model` хадгалахын өмнө дуудна. Бүгдийг нь шалгана:
 *  - жин: 6 бүрэлдэхүүн бүр төгсгөлөг, 0..1; нийлбэр 1 (±1e-9)
 *  - босго: бүгд 0..1000 бүхэл; A > B > C > D > E чанд буурах; E = 0
 *  - муруй: fico max > min; dti/ltv worst > best (≥ 0); сэжигтэй/идэвхтэй зээлийн хасалт 0..1; overdueMonthsWorst > 0; minCoverage 0..1
 * Хүчингүй бол тодорхой мессежтэй RangeError (scoring сервис INVALID_SOSCO_MODEL болгож монголоор хөрвүүлнэ).
 */
export function validateSoscoModel(weights: SoscoWeights, thresholds: SoscoGradeThresholds, curves: SoscoCurves): void {
  assertWeights(weights);
  assertThresholds(thresholds);
  assertCurves(curves);
}

/**
 * Sosco Score (docs/05 §3). 6 бүрэлдэхүүнийг 0..1 болгож, жингээр нийлбэрлэнэ.
 *  - Бүрэлдэхүүн үргэлж SOSCO_COMPONENTS дарааллаар, яг 6.
 *  - null оролт → бүрэлдэхүүн «байхгүй» (available=false, input/normalized null, effectiveWeight 0, points 0): үлдсэн жинг
 *    пропорциональ дахин хуваарилна (мэдэхгүй зүйлийг шагнахгүй, шийтгэхгүй). history нь overdueHistoryMonths мэдэгдэх үед л
 *    байна (activeLoanCount=null → 0; breakdown.input = overdueHistoryMonths).
 *  - coverage = мэдэгдсэн бүрэлдэхүүнүүдийн ЗАГВАРЫН жингийн нийлбэр (4 оронд). coverage < minCoverage эсвэл мэдэгдсэн жин 0 бол
 *    INSUFFICIENT_DATA (score, grade null). Харьцуулалт нь тайлагдсан (4 оронд бөөрөнхийлсөн) coverage-аар — үр дүнгээс шалгагдахуйц.
 *  - score = round-half-up(1000 × Σ(effectiveWeight × normalized)) = 1000 × Σ(жин × утга) ÷ Σ(мэдэгдсэн жин); эцэст нь НЭГ хуваалт.
 *  - points = 1000 × effectiveWeight × normalized (1 орон). INSUFFICIENT_DATA үед ч мэдэгдсэн жин > 0 бол мэдээллийн шинжтэй тооцогдоно.
 * Оролт/загвар хүчингүй бол RangeError.
 */
export function soscoScore(
  input: SoscoInput, weights: SoscoWeights, thresholds: SoscoGradeThresholds, curves: SoscoCurves, modelVersion: number,
): SoscoScoreResult {
  validateSoscoModel(weights, thresholds, curves);
  assertSoscoInput(input);
  assertCount('modelVersion', modelVersion);

  // null → бүрэлдэхүүн байхгүй. FR-8 / docs/05 §3 хүснэгтийн дагуу
  const measured: Record<SoscoComponentKey, { value: number | null; unit: Decimal | null }> = {
    fico: { value: input.ficoScore, unit: input.ficoScore === null ? null : unitFico(input.ficoScore, curves.fico) },
    dti: { value: input.dtiPercent, unit: input.dtiPercent === null ? null : unitDti(input.dtiPercent, curves.dti) },
    reliability: { value: input.incomeReliability, unit: input.incomeReliability === null ? null : unitReliability(input.incomeReliability) },
    suspicious: {
      value: input.pendingSuspiciousCount,
      unit: input.pendingSuspiciousCount === null ? null : unitSuspicious(input.pendingSuspiciousCount, curves.suspiciousPenaltyPerFlag),
    },
    history: {
      value: input.overdueHistoryMonths,
      unit: input.overdueHistoryMonths === null ? null : unitHistory(input.overdueHistoryMonths, input.activeLoanCount ?? 0, curves.history),
    },
    ltv: { value: input.ltv, unit: input.ltv === null ? null : unitLtv(input.ltv, curves.ltv) },
  };

  const rows = SOSCO_COMPONENTS.map((key) => ({ key, ...measured[key], weight: new D(weights[key]) }));
  const known = rows.filter((r) => r.unit !== null);
  const knownWeight = sumOf(known.map((r) => r.weight));
  const coverage = round(knownWeight, COVERAGE_DP);
  // Мэдэгдсэн жин 0 бол дахин хуваарилах суурь байхгүй (minCoverage = 0 үед ч) → effectiveWeight бүгд 0
  const hasWeight = knownWeight.gt(ZERO);
  const insufficient = !hasWeight || coverage < curves.minCoverage;

  // Σ(жин × утга); score, points-д ХУВААЛТ ХИЙЖ БАЙГАА тул өмнө нь бөөрөнхийлөхгүй
  const weighted = (r: { unit: Decimal | null; weight: Decimal }): Decimal => (r.unit === null ? ZERO : r.weight.mul(r.unit));
  const components: SoscoComponentBreakdown[] = rows.map((r) => ({
    key: r.key,
    available: r.unit !== null,
    input: r.value,
    normalized: r.unit === null ? null : toNumber(r.unit),
    weight: weights[r.key],
    effectiveWeight: r.unit !== null && hasWeight ? toNumber(r.weight.div(knownWeight)) : 0,
    points: r.unit !== null && hasWeight ? round(weighted(r).mul(SCORE_MAX).div(knownWeight), POINTS_DP) : 0,
  }));

  if (insufficient) return { status: 'INSUFFICIENT_DATA', score: null, grade: null, coverage, components, modelVersion };

  const score = round(sumOf(rows.map(weighted)).mul(SCORE_MAX).div(knownWeight), 0);
  return { status: 'SCORED', score, grade: gradeFor(score, thresholds), coverage, components, modelVersion };
}
