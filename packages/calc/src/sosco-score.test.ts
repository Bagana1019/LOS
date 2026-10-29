// Sosco Score тест (docs/05-scoring-sosco.md §3, FR-5.5, FR-8). БҮХ ӨГӨГДӨЛ СИНТЕТИК.
// Жин/муруй/босго нь DEMO таамаг (DEFAULT_SOSCO_*) — бизнесийн баталгаажсан утга биш. Хүлээгдэх утга бүр гараар бодогдсон; арифметик тайлбарт.
import { describe, expect, it } from 'vitest';
import { SOSCO_COMPONENTS, SoscoScoreResult } from '@los/contracts';
import {
  DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS, gradeFor, normalizeDti, normalizeFico, normalizeHistory, normalizeLtv,
  normalizeReliability, normalizeSuspicious, soscoScore, validateSoscoModel,
  type SoscoCurves, type SoscoGradeThresholds, type SoscoInput, type SoscoWeights,
} from './sosco-score';

const W = DEFAULT_SOSCO_WEIGHTS;
const T = DEFAULT_SOSCO_GRADE_THRESHOLDS;
const C = DEFAULT_SOSCO_CURVES;

const NONE: SoscoInput = {
  ficoScore: null, dtiPercent: null, incomeReliability: null, pendingSuspiciousCount: null, activeLoanCount: null, overdueHistoryMonths: null, ltv: null,
};
const inp = (over: Partial<SoscoInput>): SoscoInput => ({ ...NONE, ...over });
/** Бүх зургаан бүрэлдэхүүн мэдэгдэх жишиг оролт */
const FULL: SoscoInput = {
  ficoScore: 700, dtiPercent: 35, incomeReliability: 80, pendingSuspiciousCount: 1, activeLoanCount: 2, overdueHistoryMonths: 3, ltv: 0.5,
};
const score = (input: SoscoInput, over: { w?: SoscoWeights; t?: SoscoGradeThresholds; c?: SoscoCurves; v?: number } = {}) =>
  soscoScore(input, over.w ?? W, over.t ?? T, over.c ?? C, over.v ?? 1);
/** Жин зөвхөн нэг бүрэлдэхүүнд */
const only = (key: keyof SoscoWeights): SoscoWeights => ({ fico: 0, dti: 0, reliability: 0, suspicious: 0, history: 0, ltv: 0, [key]: 1 });
const byKey = (r: ReturnType<typeof score>) => Object.fromEntries(r.components.map((c) => [c.key, c]));

describe('normalizeFico', () => {
  it('(fico − min) ÷ (max − min): 300 → 0, 575 → 0.5, 850 → 1', () => {
    expect(normalizeFico(300, C.fico)).toBe(0);
    expect(normalizeFico(575, C.fico)).toBe(0.5); // 275 ÷ 550
    expect(normalizeFico(850, C.fico)).toBe(1);
    expect(normalizeFico(700, C.fico)).toBeCloseTo(8 / 11, 14); // 400 ÷ 550
    expect(normalizeFico(450, C.fico)).toBeCloseTo(3 / 11, 14); // 150 ÷ 550
  });
  it('муруйн гадна 0..1-д хязгаарлана (max-аас дээш → 1, min-ээс доош → 0)', () => {
    expect(normalizeFico(851, C.fico)).toBe(1);
    expect(normalizeFico(1000, C.fico)).toBe(1);
    expect(normalizeFico(299, C.fico)).toBe(0);
    expect(normalizeFico(0, C.fico)).toBe(0);
  });
  it('сөрөг min-тэй муруй хүчинтэй', () => {
    expect(normalizeFico(0, { min: -100, max: 100 })).toBe(0.5);
  });
  it.each([[-1], [Number.NaN], [Infinity], [-Infinity]])('хүчингүй fico %s → RangeError', (bad) => {
    expect(() => normalizeFico(bad, C.fico)).toThrow(RangeError);
    expect(() => normalizeFico(bad, C.fico)).toThrow(/ficoScore/);
  });
  it.each([
    ['max = min', { min: 300, max: 300 }],
    ['max < min', { min: 850, max: 300 }],
    ['NaN', { min: Number.NaN, max: 850 }],
    ['Infinity', { min: 300, max: Infinity }],
  ])('алдаатай муруй (%s) → RangeError', (_label, curve) => {
    expect(() => normalizeFico(500, curve)).toThrow(RangeError);
    expect(() => normalizeFico(500, curve)).toThrow(/curves\.fico/);
  });
});

describe('normalizeDti', () => {
  it('≤ 20% → 1; ≥ 80% → 0; хооронд шугаман', () => {
    expect(normalizeDti(20, C.dti)).toBe(1);
    expect(normalizeDti(10, C.dti)).toBe(1);
    expect(normalizeDti(0, C.dti)).toBe(1);
    expect(normalizeDti(80, C.dti)).toBe(0);
    expect(normalizeDti(120, C.dti)).toBe(0);
    expect(normalizeDti(50, C.dti)).toBe(0.5); // (80−50) ÷ 60
    expect(normalizeDti(35, C.dti)).toBe(0.75); // 45 ÷ 60
    expect(normalizeDti(65, C.dti)).toBe(0.25); // 15 ÷ 60
    expect(normalizeDti(55.89, C.dti)).toBeCloseTo(24.11 / 60, 14);
  });
  it.each([[-0.1], [Number.NaN], [Infinity]])('хүчингүй dtiPercent %s → RangeError', (bad) => {
    expect(() => normalizeDti(bad, C.dti)).toThrow(/dtiPercent/);
  });
  it.each([
    ['worst = best', { bestPercent: 20, worstPercent: 20 }],
    ['worst < best', { bestPercent: 80, worstPercent: 20 }],
    ['best < 0', { bestPercent: -1, worstPercent: 80 }],
  ])('алдаатай муруй (%s) → RangeError', (_label, curve) => {
    expect(() => normalizeDti(50, curve)).toThrow(/curves\.dti/);
  });
});

describe('normalizeReliability', () => {
  it('÷ 100', () => {
    expect(normalizeReliability(0)).toBe(0);
    expect(normalizeReliability(100)).toBe(1);
    expect(normalizeReliability(80)).toBe(0.8);
    expect(normalizeReliability(33.3)).toBe(0.333);
  });
  it.each([[-0.1], [100.1], [Number.NaN], [Infinity], [-Infinity]])('0..100-аас гадуур %s → RangeError', (bad) => {
    expect(() => normalizeReliability(bad)).toThrow(RangeError);
    expect(() => normalizeReliability(bad)).toThrow(/incomeReliability/);
  });
});

describe('normalizeSuspicious', () => {
  it('1 − 0.2 × тоо, доод заг 0', () => {
    expect(normalizeSuspicious(0, 0.2)).toBe(1);
    expect(normalizeSuspicious(1, 0.2)).toBe(0.8);
    expect(normalizeSuspicious(3, 0.2)).toBe(0.4); // float: 1 − 0.2×3 = 0.3999999999999999; Decimal-аар яг 0.4
    expect(normalizeSuspicious(4, 0.2)).toBe(0.2);
    expect(normalizeSuspicious(5, 0.2)).toBe(0);
    expect(normalizeSuspicious(6, 0.2)).toBe(0); // сөрөг болохгүй
    expect(normalizeSuspicious(100, 0.2)).toBe(0);
  });
  it('хасалт 0 бол үргэлж 1; хасалт 1 бол нэг дохио л 0', () => {
    expect(normalizeSuspicious(9, 0)).toBe(1);
    expect(normalizeSuspicious(1, 1)).toBe(0);
    expect(normalizeSuspicious(0, 1)).toBe(1);
  });
  it.each([[-1], [1.5], [Number.NaN], [Infinity]])('хүчингүй тоо %s → RangeError', (bad) => {
    expect(() => normalizeSuspicious(bad, 0.2)).toThrow(/pendingSuspiciousCount/);
  });
  it.each([[-0.1], [1.1], [Number.NaN]])('хүчингүй хасалт %s → RangeError', (bad) => {
    expect(() => normalizeSuspicious(1, bad)).toThrow(/suspiciousPenaltyPerFlag/);
  });
});

describe('normalizeHistory', () => {
  it('1 − сар÷12 − 0.05×идэвхтэй зээл (0..1)', () => {
    expect(normalizeHistory(0, 0, C.history)).toBe(1);
    expect(normalizeHistory(3, 2, C.history)).toBe(0.65); // 1 − 0.25 − 0.10
    expect(normalizeHistory(6, 0, C.history)).toBe(0.5);
    expect(normalizeHistory(6, 2, C.history)).toBe(0.4); // 1 − 0.5 − 0.1
    expect(normalizeHistory(0, 3, C.history)).toBe(0.85); // 1 − 0.15
  });
  it('12 ба түүнээс дээш сар → 0; сөрөг болохгүй', () => {
    expect(normalizeHistory(12, 0, C.history)).toBe(0);
    expect(normalizeHistory(24, 0, C.history)).toBe(0);
    expect(normalizeHistory(0, 20, C.history)).toBe(0); // 1 − 1.0
    expect(normalizeHistory(0, 50, C.history)).toBe(0);
    expect(normalizeHistory(1, 0, { overdueMonthsWorst: 0.5, activeLoanPenalty: 0 })).toBe(0); // 1 − 2 → 0
  });
  it.each([[-1], [1.5], [Number.NaN], [Infinity]])('хүчингүй сар/зээл %s → RangeError', (bad) => {
    expect(() => normalizeHistory(bad, 0, C.history)).toThrow(/overdueHistoryMonths/);
    expect(() => normalizeHistory(0, bad, C.history)).toThrow(/activeLoanCount/);
  });
  it.each([
    ['overdueMonthsWorst = 0', { overdueMonthsWorst: 0, activeLoanPenalty: 0.05 }],
    ['overdueMonthsWorst < 0', { overdueMonthsWorst: -3, activeLoanPenalty: 0.05 }],
    ['overdueMonthsWorst NaN', { overdueMonthsWorst: Number.NaN, activeLoanPenalty: 0.05 }],
    ['activeLoanPenalty > 1', { overdueMonthsWorst: 12, activeLoanPenalty: 1.5 }],
  ])('алдаатай муруй (%s) → RangeError', (_label, curve) => {
    expect(() => normalizeHistory(1, 1, curve)).toThrow(/curves\.history/);
  });
});

describe('normalizeLtv', () => {
  it('≤ 0.3 → 1; ≥ 1.0 → 0; хооронд шугаман', () => {
    expect(normalizeLtv(0.3, C.ltv)).toBe(1);
    expect(normalizeLtv(0.2, C.ltv)).toBe(1);
    expect(normalizeLtv(0, C.ltv)).toBe(1);
    expect(normalizeLtv(1, C.ltv)).toBe(0);
    expect(normalizeLtv(1.5, C.ltv)).toBe(0);
    expect(normalizeLtv(0.65, C.ltv)).toBe(0.5); // 0.35 ÷ 0.7
    expect(normalizeLtv(0.5, C.ltv)).toBeCloseTo(5 / 7, 14); // 0.5 ÷ 0.7
    expect(normalizeLtv(0.8, C.ltv)).toBeCloseTo(2 / 7, 14); // 0.2 ÷ 0.7
  });
  it.each([[-0.01], [Number.NaN], [Infinity]])('хүчингүй ltv %s → RangeError', (bad) => {
    expect(() => normalizeLtv(bad, C.ltv)).toThrow(/ltv/);
  });
  it.each([
    ['worst = best', { best: 0.3, worst: 0.3 }],
    ['worst < best', { best: 1, worst: 0.3 }],
    ['best < 0', { best: -0.1, worst: 1 }],
  ])('алдаатай муруй (%s) → RangeError', (_label, curve) => {
    expect(() => normalizeLtv(0.5, curve)).toThrow(/curves\.ltv/);
  });
});

describe('gradeFor (DEFAULT босго A≥800 B≥700 C≥600 D≥500 E≥0)', () => {
  it.each([
    [1000, 'A'], [800, 'A'], [799, 'B'], [700, 'B'], [699, 'C'], [600, 'C'], [599, 'D'], [500, 'D'], [499, 'E'], [1, 'E'], [0, 'E'],
  ] as const)('score %i → %s', (s, grade) => {
    expect(gradeFor(s, T)).toBe(grade);
  });
  it('өөр босготой загвар', () => {
    const t: SoscoGradeThresholds = { A: 900, B: 750, C: 500, D: 250, E: 0 };
    expect(gradeFor(900, t)).toBe('A');
    expect(gradeFor(899, t)).toBe('B');
    expect(gradeFor(750, t)).toBe('B');
    expect(gradeFor(749, t)).toBe('C');
    expect(gradeFor(250, t)).toBe('D');
    expect(gradeFor(249, t)).toBe('E');
  });
  it('бүхэл биш оноог хүлээн авна (799.5 → B)', () => {
    expect(gradeFor(799.5, T)).toBe('B');
  });
  it.each([[-1], [1001], [Number.NaN], [Infinity]])('0..1000-аас гадуур оноо %s → RangeError', (bad) => {
    expect(() => gradeFor(bad, T)).toThrow(RangeError);
    expect(() => gradeFor(bad, T)).toThrow(/score/);
  });
  it('алдаатай босго → RangeError', () => {
    expect(() => gradeFor(10, { ...T, E: 50 })).toThrow(/gradeThresholds\.E/);
  });
});

describe('validateSoscoModel', () => {
  it('DEFAULT загвар хүчинтэй', () => {
    expect(() => validateSoscoModel(W, T, C)).not.toThrow();
  });
  it('нэг бүрэлдэхүүнд бүх жин, тэг жинтэй загвар хүчинтэй; нийлбэрийн хазайлт ±1e-9 зөвшөөрөгдөнө', () => {
    expect(() => validateSoscoModel(only('ltv'), T, C)).not.toThrow();
    expect(() => validateSoscoModel({ ...W, fico: W.fico + 5e-10 }, T, C)).not.toThrow();
    expect(() => validateSoscoModel({ ...W, fico: W.fico - 5e-10 }, T, C)).not.toThrow();
  });
  it('сөрөг min-тэй fico муруй, босго A=1000/D=1 хүчинтэй', () => {
    expect(() => validateSoscoModel(W, { A: 1000, B: 3, C: 2, D: 1, E: 0 }, { ...C, fico: { min: -50, max: 50 } })).not.toThrow();
  });
  it('minCoverage 0 ба 1 хүчинтэй', () => {
    expect(() => validateSoscoModel(W, T, { ...C, minCoverage: 0 })).not.toThrow();
    expect(() => validateSoscoModel(W, T, { ...C, minCoverage: 1 })).not.toThrow();
  });

  describe.each([
    ['нийлбэр 0.9', { ...W, fico: 0.2 }, /weights must sum to 1/],
    ['нийлбэр 1 + 2e-9', { ...W, fico: W.fico + 2e-9 }, /weights must sum to 1/],
    ['сөрөг жин', { ...W, fico: -0.1, dti: 0.35 }, /weights\.fico/],
    ['NaN жин', { ...W, dti: Number.NaN }, /weights\.dti/],
    ['Infinity жин', { ...W, reliability: Infinity }, /weights\.reliability/],
    ['жин > 1', { ...W, suspicious: 1.5 }, /weights\.suspicious/],
    ['жин дутуу (undefined)', { ...W, ltv: undefined as unknown as number }, /weights\.ltv/],
  ])('жин: %s', (_label, weights, pattern) => {
    it('RangeError', () => {
      expect(() => validateSoscoModel(weights, T, C)).toThrow(RangeError);
      expect(() => validateSoscoModel(weights, T, C)).toThrow(pattern);
    });
  });

  describe.each([
    ['A = B', { ...T, B: 800 }, /strictly decreasing/],
    ['B > A', { ...T, A: 650 }, /strictly decreasing/],
    ['C = D', { ...T, C: 500 }, /strictly decreasing/],
    ['D = E', { ...T, D: 0 }, /strictly decreasing/],
    ['E ≠ 0', { A: 800, B: 700, C: 600, D: 500, E: 100 }, /gradeThresholds\.E must be 0/],
    ['A > 1000', { ...T, A: 1001 }, /gradeThresholds\.A/],
    ['E < 0', { ...T, E: -1 }, /gradeThresholds\.E/],
    ['бүхэл биш', { ...T, B: 699.5 }, /gradeThresholds\.B/],
    ['NaN', { ...T, C: Number.NaN }, /gradeThresholds\.C/],
  ])('босго: %s', (_label, thresholds, pattern) => {
    it('RangeError', () => {
      expect(() => validateSoscoModel(W, thresholds, C)).toThrow(RangeError);
      expect(() => validateSoscoModel(W, thresholds, C)).toThrow(pattern);
    });
  });

  describe.each([
    ['fico max = min', { ...C, fico: { min: 300, max: 300 } }, /curves\.fico/],
    ['dti worst < best', { ...C, dti: { bestPercent: 80, worstPercent: 20 } }, /curves\.dti/],
    ['ltv worst = best', { ...C, ltv: { best: 0.5, worst: 0.5 } }, /curves\.ltv/],
    ['suspiciousPenaltyPerFlag < 0', { ...C, suspiciousPenaltyPerFlag: -0.1 }, /suspiciousPenaltyPerFlag/],
    ['suspiciousPenaltyPerFlag > 1', { ...C, suspiciousPenaltyPerFlag: 1.1 }, /suspiciousPenaltyPerFlag/],
    ['overdueMonthsWorst = 0', { ...C, history: { overdueMonthsWorst: 0, activeLoanPenalty: 0.05 } }, /overdueMonthsWorst/],
    ['activeLoanPenalty < 0', { ...C, history: { overdueMonthsWorst: 12, activeLoanPenalty: -0.05 } }, /activeLoanPenalty/],
    ['minCoverage < 0', { ...C, minCoverage: -0.1 }, /minCoverage/],
    ['minCoverage > 1', { ...C, minCoverage: 1.5 }, /minCoverage/],
    ['minCoverage NaN', { ...C, minCoverage: Number.NaN }, /minCoverage/],
  ])('муруй: %s', (_label, curves, pattern) => {
    it('RangeError', () => {
      expect(() => validateSoscoModel(W, T, curves)).toThrow(RangeError);
      expect(() => validateSoscoModel(W, T, curves)).toThrow(pattern);
    });
  });

  it('soscoScore нь хүчингүй загварыг оролт хэдий хүчинтэй ч няцаана', () => {
    expect(() => score(FULL, { w: { ...W, fico: 0.2 } })).toThrow(/weights must sum to 1/);
    expect(() => score(FULL, { t: { ...T, E: 1 } })).toThrow(/gradeThresholds\.E/);
    expect(() => score(FULL, { c: { ...C, minCoverage: 2 } })).toThrow(/minCoverage/);
  });
});

describe('soscoScore — гараар бодсон жишээ (DEFAULT загвар)', () => {
  it('бүх зургаан бүрэлдэхүүн мэдэгдэнэ → 739, B', () => {
    // fico 700: 400 ÷ 550 = 8/11 = 0.727273 · dti 35: 45 ÷ 60 = 0.75 · reliability 80: 0.8 · suspicious 1: 1 − 0.2 = 0.8
    // history (3 сар, 2 зээл): 1 − 3/12 − 0.05×2 = 0.65 · ltv 0.5: 0.5 ÷ 0.7 = 5/7 = 0.714286
    // жин×утга: 0.3×8/11 = 0.218182 · 0.25×0.75 = 0.1875 · 0.15×0.8 = 0.12 · 0.1×0.8 = 0.08 · 0.15×0.65 = 0.0975 · 0.05×5/7 = 0.035714
    // Σ = 0.738896 → 1000 × Σ = 738.896 → 739 → B (≥ 700)
    const r = score(FULL, { v: 7 });
    expect(r).toMatchObject({ status: 'SCORED', score: 739, grade: 'B', coverage: 1, modelVersion: 7 });
    expect(r.components.map((c) => c.key)).toEqual(['fico', 'dti', 'reliability', 'suspicious', 'history', 'ltv']);
    expect(r.components.every((c) => c.available)).toBe(true);
    expect(r.components.map((c) => c.input)).toEqual([700, 35, 80, 1, 3, 0.5]); // history.input = overdueHistoryMonths
    expect(r.components[0].normalized).toBeCloseTo(8 / 11, 14);
    expect(r.components.slice(1, 5).map((c) => c.normalized)).toEqual([0.75, 0.8, 0.8, 0.65]);
    expect(r.components[5].normalized).toBeCloseTo(5 / 7, 14);
    expect(r.components.map((c) => c.weight)).toEqual([0.3, 0.25, 0.15, 0.1, 0.15, 0.05]);
    // бүгд мэдэгдэх үед effectiveWeight = жин
    for (const c of r.components) expect(c.effectiveWeight).toBeCloseTo(c.weight, 14);
    // points = 1000 × жин × утга (1 орон): 218.18 · 187.5 · 120 · 80 · 97.5 · 35.71
    expect(r.components.map((c) => c.points)).toEqual([218.2, 187.5, 120, 80, 97.5, 35.7]);
  });

  it('нэг бүрэлдэхүүн (fico) мэдэгдэхгүй → жин дахин хуваарилагдана: 744, B, coverage 0.7', () => {
    // Үлдсэн жин: 0.25 + 0.15 + 0.1 + 0.15 + 0.05 = 0.70 (coverage 0.7 ≥ 0.5)
    // Σ(жин×утга) = 0.1875 + 0.12 + 0.08 + 0.0975 + 0.035714 = 0.520714 → ÷ 0.7 = 0.743878 → 743.878 → 744
    // effectiveWeight = жин ÷ 0.7: dti 0.357143 · reliability 0.214286 · suspicious 0.142857 · history 0.214286 · ltv 0.071429 (нийлбэр 1)
    // points = 1000×(жин×утга)÷0.7: 267.857 · 171.429 · 114.286 · 139.286 · 51.020 → 267.9 · 171.4 · 114.3 · 139.3 · 51.0
    const r = score({ ...FULL, ficoScore: null });
    expect(r).toMatchObject({ status: 'SCORED', score: 744, grade: 'B', coverage: 0.7 });
    const c = byKey(r);
    expect(c.fico).toEqual({ key: 'fico', available: false, input: null, normalized: null, weight: 0.3, effectiveWeight: 0, points: 0 });
    expect(r.components.slice(1).map((x) => x.available)).toEqual([true, true, true, true, true]);
    expect(c.dti.effectiveWeight).toBeCloseTo(0.25 / 0.7, 14);
    expect(c.reliability.effectiveWeight).toBeCloseTo(0.15 / 0.7, 14);
    expect(c.suspicious.effectiveWeight).toBeCloseTo(0.1 / 0.7, 14);
    expect(c.history.effectiveWeight).toBeCloseTo(0.15 / 0.7, 14);
    expect(c.ltv.effectiveWeight).toBeCloseTo(0.05 / 0.7, 14);
    expect(r.components.reduce((s, x) => s + x.effectiveWeight, 0)).toBeCloseTo(1, 12);
    expect(r.components.slice(1).map((x) => x.points)).toEqual([267.9, 171.4, 114.3, 139.3, 51]);
  });

  it('null нь шагнал/шийтгэл биш: бүх мэдэгдэх бүрэлдэхүүн ижил утгатай бол оноо тэр утгыг 1000-аар үржүүлснээр', () => {
    // reliability 80 → 0.8 ба suspicious 1 → 0.8; бусад null. Мэдэгдэх жин 0.15 + 0.1 = 0.25 (coverage 0.25 < 0.5) тул minCoverage 0.25 болгоно.
    // Σ = 0.15×0.8 + 0.1×0.8 = 0.2 → ÷ 0.25 = 0.8 → 800 → A
    const r = score(inp({ incomeReliability: 80, pendingSuspiciousCount: 1 }), { c: { ...C, minCoverage: 0.25 } });
    expect(r).toMatchObject({ status: 'SCORED', score: 800, grade: 'A', coverage: 0.25 });
  });

  it('history: overdueHistoryMonths мэдэгдэж, activeLoanCount мэдэгдэхгүй → зээл 0 гэж тооцно', () => {
    // history = 1 − 3/12 − 0.05×0 = 0.75; fico 850 → 1, dti 20 → 1, reliability 100 → 1 (жин 0.3 + 0.25 + 0.15 + 0.15 = 0.85)
    // Σ = 0.3 + 0.25 + 0.15 + 0.15×0.75 = 0.8125 → ÷ 0.85 = 0.955882 → 955.88 → 956
    const r = score(inp({ ficoScore: 850, dtiPercent: 20, incomeReliability: 100, overdueHistoryMonths: 3 }));
    expect(r).toMatchObject({ status: 'SCORED', score: 956, grade: 'A', coverage: 0.85 });
    expect(byKey(r).history).toMatchObject({ available: true, input: 3, normalized: 0.75 });
  });

  it('history: overdueHistoryMonths null бол activeLoanCount мэдэгдсэн ч бүрэлдэхүүн байхгүй', () => {
    const r = score({ ...FULL, overdueHistoryMonths: null, activeLoanCount: 4 });
    expect(byKey(r).history).toEqual({ key: 'history', available: false, input: null, normalized: null, weight: 0.15, effectiveWeight: 0, points: 0 });
    expect(r.coverage).toBe(0.85);
  });
});

describe('soscoScore — coverage (minCoverage = 0.5)', () => {
  // fico 575 → 0.5 · reliability 60 → 0.6 · ltv 0.65 → 0.5; бусад null
  const AT_MIN = inp({ ficoScore: 575, incomeReliability: 60, ltv: 0.65 });

  it('coverage яг minCoverage (0.3 + 0.15 + 0.05 = 0.5) → оноотой', () => {
    expect(0.3 + 0.15 + 0.05).toBeLessThan(0.5); // float-оор 0.49999999999999994 — Decimal нийлбэр яг 0.5
    // Σ = 0.3×0.5 + 0.15×0.6 + 0.05×0.5 = 0.15 + 0.09 + 0.025 = 0.265 → ÷ 0.5 = 0.53 → 530 → D
    const r = score(AT_MIN);
    expect(r).toMatchObject({ status: 'SCORED', score: 530, grade: 'D', coverage: 0.5 });
    // effectiveWeight 0.6 · 0.3 · 0.1 → points 0.6×0.5 = 300 · 0.3×0.6 = 180 · 0.1×0.5 = 50 (Σ = 530)
    expect(r.components.filter((c) => c.available).map((c) => [c.key, c.effectiveWeight, c.points])).toEqual([
      ['fico', 0.6, 300], ['reliability', 0.3, 180], ['ltv', 0.1, 50],
    ]);
  });

  it('coverage minCoverage-аас бага (0.5 < 0.5001) → INSUFFICIENT_DATA, бүрэлдэхүүн тайлагдана', () => {
    const r = score(AT_MIN, { c: { ...C, minCoverage: 0.5001 } });
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, coverage: 0.5, modelVersion: 1 });
    expect(r.components).toHaveLength(6);
    expect(r.components.map((c) => c.available)).toEqual([true, false, true, false, false, true]);
    expect(r.components.map((c) => c.normalized)).toEqual([0.5, null, 0.6, null, null, 0.5]);
  });

  it('fico + reliability = 0.45 < 0.5 → INSUFFICIENT_DATA', () => {
    const r = score(inp({ ficoScore: 575, incomeReliability: 60 }));
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, coverage: 0.45 });
    expect(byKey(r).fico).toMatchObject({ available: true, input: 575, normalized: 0.5, weight: 0.3 });
    // мэдэгдэх жин > 0 тул мэдээллийн шинжтэй effectiveWeight: 0.3÷0.45 · 0.15÷0.45
    expect(r.components.reduce((s, x) => s + x.effectiveWeight, 0)).toBeCloseTo(1, 12);
  });

  it('бүх оролт null → INSUFFICIENT_DATA, coverage 0, effectiveWeight/points 0', () => {
    const r = score(NONE);
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, coverage: 0 });
    for (const c of r.components) expect(c).toMatchObject({ available: false, input: null, normalized: null, effectiveWeight: 0, points: 0 });
  });

  it('minCoverage = 0 бол нэг бүрэлдэхүүн ч оноо өгнө (ltv 0.3 → 1, жин 0.05 → дахин хуваарилсан 1 → 1000)', () => {
    const r = score(inp({ ltv: 0.3 }), { c: { ...C, minCoverage: 0 } });
    expect(r).toMatchObject({ status: 'SCORED', score: 1000, grade: 'A', coverage: 0.05 });
    expect(byKey(r).ltv).toMatchObject({ effectiveWeight: 1, points: 1000 });
  });

  it('minCoverage = 0 ч мэдэгдсэн жин 0 бол INSUFFICIENT_DATA (дахин хуваарилах суурь байхгүй)', () => {
    const r = score(NONE, { c: { ...C, minCoverage: 0 } });
    expect(r).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, coverage: 0 });
    // Жин 0-тэй бүрэлдэхүүн л мэдэгдэж байвал ч адил
    const zero = score(inp({ ficoScore: 850 }), { w: only('dti'), c: { ...C, minCoverage: 0 } });
    expect(zero).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, coverage: 0 });
    expect(byKey(zero).fico).toEqual({ key: 'fico', available: true, input: 850, normalized: 1, weight: 0, effectiveWeight: 0, points: 0 });
  });

  it('coverage 4 оронд бөөрөнхийлөгдөнө', () => {
    // 1/3 + 1/3 + 1/3 жин (нийлбэр 0.99999999 ≈ 1 ±1e-9 доторх): fico, dti, reliability л мэдэгдэнэ → coverage = 3 × 0.33333333 = 0.99999999 → 1
    const third = 0.33333333;
    const r = score(inp({ ficoScore: 850, dtiPercent: 20, incomeReliability: 100 }), {
      w: { fico: third, dti: third, reliability: third, suspicious: 0.00000001, history: 0, ltv: 0 },
    });
    expect(r.coverage).toBe(1);
    expect(r.score).toBe(1000);
  });
});

describe('soscoScore — зэргийн хилүүд', () => {
  it('нэг бүрэлдэхүүнт загвар (reliability жин 1): score = round-half-up(10 × reliability), DEFAULT босго', () => {
    // Хуваалт ÷100 × 1000 = ×10. Босго: A≥800 B≥700 C≥600 D≥500 E≥0
    const run = (reliability: number) => score(inp({ incomeReliability: reliability }), { w: only('reliability') });
    const cases: Array<[number, number, string]> = [
      [100, 1000, 'A'], [80, 800, 'A'], [79.9, 799, 'B'], [70, 700, 'B'], [69.9, 699, 'C'], [60, 600, 'C'], [59.9, 599, 'D'],
      [50, 500, 'D'], [49.9, 499, 'E'], [0.1, 1, 'E'], [0, 0, 'E'],
    ];
    for (const [reliability, expected, grade] of cases) {
      expect(run(reliability), `reliability ${reliability}`).toMatchObject({ status: 'SCORED', score: expected, grade, coverage: 1 });
    }
  });

  it('яг .5-д дээш бөөрөнхийлнө (round-half-up, banker биш; float drift-гүй)', () => {
    const run = (reliability: number) => score(inp({ incomeReliability: reliability }), { w: only('reliability') }).score;
    expect(run(0.05)).toBe(1); // 0.5 → 1
    expect(run(0.15)).toBe(2); // 1.5 → 2
    expect(run(0.25)).toBe(3); // 2.5 → 3 (banker бол 2)
    expect(run(4.35)).toBe(44); // 43.5 → 44 (float: 4.35 ÷ 100 × 1000 = 43.49999999999999)
    expect(run(0.04)).toBe(0);
    expect(run(99.95)).toBe(1000); // 999.5
    expect(run(99.94)).toBe(999);
  });

  // DEFAULT загварын бүх зургаан бүрэлдэхүүнээр хилийн оноог яг гаргана. Σ(жин×утга) × 1000:
  const BOUNDARY: Array<[string, SoscoInput, number, string]> = [
    // fico 850 → 1 (0.30) · dti 20 → 1 (0.25) · susp 3 → 0.4 (0.04) · history (0,0) → 1 (0.15) · ltv 1 → 0 (0)
    // reliability 40 → 0.06: Σ = 0.30 + 0.25 + 0.06 + 0.04 + 0.15 = 0.80 → 800
    ['800', { ficoScore: 850, dtiPercent: 20, incomeReliability: 40, pendingSuspiciousCount: 3, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 1 }, 800, 'A'],
    // reliability 39.4 → 0.0591: Σ = 0.7991 → 799.1 → 799
    ['799', { ficoScore: 850, dtiPercent: 20, incomeReliability: 39.4, pendingSuspiciousCount: 3, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 1 }, 799, 'B'],
    // susp 5 → 0 · history (6 сар, 2 зээл) → 1 − 0.5 − 0.1 = 0.4 (0.06) · reliability 60 → 0.09: Σ = 0.30 + 0.25 + 0.09 + 0 + 0.06 + 0 = 0.70 → 700
    ['700', { ficoScore: 850, dtiPercent: 20, incomeReliability: 60, pendingSuspiciousCount: 5, activeLoanCount: 2, overdueHistoryMonths: 6, ltv: 1 }, 700, 'B'],
    // reliability 59.4 → 0.0891: Σ = 0.6991 → 699.1 → 699
    ['699', { ficoScore: 850, dtiPercent: 20, incomeReliability: 59.4, pendingSuspiciousCount: 5, activeLoanCount: 2, overdueHistoryMonths: 6, ltv: 1 }, 699, 'C'],
    // fico 575 → 0.5 (0.15) · dti 50 → 0.5 (0.125) · reliability 60 → 0.09 · susp 2 → 0.6 (0.06) · history (0,0) → 0.15 · ltv 0.65 → 0.5 (0.025)
    // Σ = 0.15 + 0.125 + 0.09 + 0.06 + 0.15 + 0.025 = 0.600 → 600
    ['600', { ficoScore: 575, dtiPercent: 50, incomeReliability: 60, pendingSuspiciousCount: 2, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 0.65 }, 600, 'C'],
    // reliability 59.4 → 0.0891: Σ = 0.5991 → 599.1 → 599
    ['599', { ficoScore: 575, dtiPercent: 50, incomeReliability: 59.4, pendingSuspiciousCount: 2, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 0.65 }, 599, 'D'],
    // fico 575 (0.15) · dti 50 (0.125) · reliability 30 → 0.045 · susp 1 → 0.8 (0.08) · history (6,0) → 0.5 (0.075) · ltv 0.65 (0.025)
    // Σ = 0.15 + 0.125 + 0.045 + 0.08 + 0.075 + 0.025 = 0.500 → 500
    ['500', { ficoScore: 575, dtiPercent: 50, incomeReliability: 30, pendingSuspiciousCount: 1, activeLoanCount: 0, overdueHistoryMonths: 6, ltv: 0.65 }, 500, 'D'],
    // reliability 29.4 → 0.0441: Σ = 0.4991 → 499.1 → 499
    ['499', { ficoScore: 575, dtiPercent: 50, incomeReliability: 29.4, pendingSuspiciousCount: 1, activeLoanCount: 0, overdueHistoryMonths: 6, ltv: 0.65 }, 499, 'E'],
  ];
  it.each(BOUNDARY)('DEFAULT загвар: %s-д хүрэх оролт', (_label, input, expectedScore, grade) => {
    expect(score(input)).toMatchObject({ status: 'SCORED', score: expectedScore, grade, coverage: 1 });
  });

  it('оноо 0 → E (SCORED, INSUFFICIENT_DATA биш)', () => {
    // fico 300 → 0 · dti 80 → 0 · reliability 0 · susp 5 → 0 · history (12 сар) → 0 · ltv 1 → 0
    const r = score({ ficoScore: 300, dtiPercent: 80, incomeReliability: 0, pendingSuspiciousCount: 5, activeLoanCount: 0, overdueHistoryMonths: 12, ltv: 1 });
    expect(r).toMatchObject({ status: 'SCORED', score: 0, grade: 'E', coverage: 1 });
    expect(r.components.map((c) => c.normalized)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.components.map((c) => c.points)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('soscoScore — онооны туйлууд', () => {
  it('бүгд хамгийн сайн → 1000, A', () => {
    // fico 850 · dti 20 · reliability 100 · susp 0 · history (0,0) · ltv 0.3 → бүгд 1; Σ жин = 1 → 1000
    const r = score({ ficoScore: 850, dtiPercent: 20, incomeReliability: 100, pendingSuspiciousCount: 0, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 0.3 });
    expect(r).toMatchObject({ status: 'SCORED', score: 1000, grade: 'A', coverage: 1 });
    expect(r.components.map((c) => c.normalized)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(r.components.map((c) => c.points)).toEqual([300, 250, 150, 100, 150, 50]);
  });

  it('муруйн гадна утгууд хязгаарлагдана: хамгийн сайн талд 1000, хамгийн муу талд 0', () => {
    const best = score({ ficoScore: 1000, dtiPercent: 0, incomeReliability: 100, pendingSuspiciousCount: 0, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 0 });
    expect(best).toMatchObject({ score: 1000, grade: 'A' });
    const worst = score({ ficoScore: 0, dtiPercent: 999.9, incomeReliability: 0, pendingSuspiciousCount: 10, activeLoanCount: 50, overdueHistoryMonths: 100, ltv: 3 });
    expect(worst).toMatchObject({ score: 0, grade: 'E' });
  });

  it('тэг жинтэй бүрэлдэхүүн оноонд нөлөөлөхгүй (мэдэгдсэн ч, мэдэгдээгүй ч)', () => {
    // жин: dti 0.5, reliability 0.5, бусад 0. dti 35 → 0.75, reliability 80 → 0.8: Σ = 0.375 + 0.4 = 0.775 → 775 → B
    const w: SoscoWeights = { fico: 0, dti: 0.5, reliability: 0.5, suspicious: 0, history: 0, ltv: 0 };
    const withZeroKnown = score(FULL, { w });
    expect(withZeroKnown).toMatchObject({ status: 'SCORED', score: 775, grade: 'B', coverage: 1 });
    expect(byKey(withZeroKnown).fico).toMatchObject({ available: true, weight: 0, effectiveWeight: 0, points: 0 });
    expect(byKey(withZeroKnown).dti).toMatchObject({ effectiveWeight: 0.5, points: 375 });
    expect(byKey(withZeroKnown).reliability).toMatchObject({ effectiveWeight: 0.5, points: 400 });
    const withoutZero = score({ ...FULL, ficoScore: null, ltv: null }, { w });
    expect(withoutZero).toMatchObject({ score: 775, coverage: 1 });
  });

  it('жин нийлбэр 1 боловч 4 бүрэлдэхүүн тэг жинтэй: жинтэй хоёр нь мэдэгдэхгүй бол (minCoverage 0 ч) INSUFFICIENT_DATA', () => {
    const w: SoscoWeights = { fico: 0, dti: 0.5, reliability: 0.5, suspicious: 0, history: 0, ltv: 0 };
    expect(score(inp({ ficoScore: 700, ltv: 0.5 }), { w, c: { ...C, minCoverage: 0 } })).toMatchObject({ status: 'INSUFFICIENT_DATA', coverage: 0 });
  });
});

describe('soscoScore — хүчингүй оролт → RangeError', () => {
  const bad: Array<[string, Partial<Record<keyof SoscoInput, unknown>>, RegExp]> = [
    ['fico NaN', { ficoScore: Number.NaN }, /ficoScore/],
    ['fico Infinity', { ficoScore: Infinity }, /ficoScore/],
    ['fico -Infinity', { ficoScore: -Infinity }, /ficoScore/],
    ['fico < 0', { ficoScore: -1 }, /ficoScore/],
    ['dti NaN', { dtiPercent: Number.NaN }, /dtiPercent/],
    ['dti Infinity', { dtiPercent: Infinity }, /dtiPercent/],
    ['dti < 0', { dtiPercent: -0.1 }, /dtiPercent/],
    ['reliability NaN', { incomeReliability: Number.NaN }, /incomeReliability/],
    ['reliability < 0', { incomeReliability: -1 }, /incomeReliability/],
    ['reliability > 100', { incomeReliability: 100.1 }, /incomeReliability/],
    ['reliability Infinity', { incomeReliability: Infinity }, /incomeReliability/],
    ['suspicious < 0', { pendingSuspiciousCount: -1 }, /pendingSuspiciousCount/],
    ['suspicious бүхэл биш', { pendingSuspiciousCount: 1.5 }, /pendingSuspiciousCount/],
    ['suspicious NaN', { pendingSuspiciousCount: Number.NaN }, /pendingSuspiciousCount/],
    ['activeLoanCount < 0', { activeLoanCount: -1 }, /activeLoanCount/],
    ['activeLoanCount бүхэл биш', { activeLoanCount: 0.5 }, /activeLoanCount/],
    ['overdue < 0', { overdueHistoryMonths: -3 }, /overdueHistoryMonths/],
    ['overdue Infinity', { overdueHistoryMonths: Infinity }, /overdueHistoryMonths/],
    ['ltv NaN', { ltv: Number.NaN }, /ltv/],
    ['ltv < 0', { ltv: -0.5 }, /ltv/],
    ['ltv Infinity', { ltv: Infinity }, /ltv/],
    ['fico тоо биш (string)', { ficoScore: '700' }, /ficoScore/],
    ['fico талбар дутуу (undefined)', { ficoScore: undefined }, /ficoScore/],
  ];
  it.each(bad)('%s', (_label, over, pattern) => {
    const input = { ...FULL, ...over } as SoscoInput;
    expect(() => score(input)).toThrow(RangeError);
    expect(() => score(input)).toThrow(pattern);
  });

  it('хэрэглэгдэхгүй (history байхгүй үед) activeLoanCount ч хүчингүй бол няцаана', () => {
    expect(() => score({ ...NONE, ficoScore: 700, activeLoanCount: -1 })).toThrow(/activeLoanCount/);
  });

  it.each([[-1], [1.5], [Number.NaN]])('modelVersion %s → RangeError', (v) => {
    expect(() => score(FULL, { v })).toThrow(/modelVersion/);
  });

  it('алдааны мессеж зөвхөн талбарын нэр ба хүчингүй утгыг агуулна (регистр/дансны дугаар байхгүй)', () => {
    try {
      score({ ...FULL, ficoScore: -7 });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe('ficoScore must be a finite number within [0, Infinity], got -7');
    }
  });
});

describe('soscoScore — давтагдах чанар, гэрээ', () => {
  const deepFreeze = <T extends object>(o: T): T => {
    for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) deepFreeze(v);
    return Object.freeze(o);
  };

  it('ижил оролт → ижил үр дүн (оролт, загварыг өөрчлөхгүй)', () => {
    const input = deepFreeze({ ...FULL });
    const [w, t, c] = [deepFreeze({ ...W }), deepFreeze({ ...T }), deepFreeze({ ...C, fico: { ...C.fico }, dti: { ...C.dti }, ltv: { ...C.ltv }, history: { ...C.history } })];
    const first = soscoScore(input, w, t, c, 3);
    for (let i = 0; i < 5; i++) expect(soscoScore(input, w, t, c, 3)).toEqual(first);
    expect(JSON.stringify(soscoScore(input, w, t, c, 3))).toBe(JSON.stringify(first));
  });

  it('жингийн объектын түлхүүрийн дараалал үр дүнд нөлөөлөхгүй; бүрэлдэхүүн үргэлж SOSCO_COMPONENTS дарааллаар', () => {
    const shuffled: SoscoWeights = { ltv: W.ltv, history: W.history, suspicious: W.suspicious, reliability: W.reliability, dti: W.dti, fico: W.fico };
    const r = soscoScore(FULL, shuffled, T, C, 1);
    expect(r).toEqual(score(FULL));
    expect(r.components.map((c) => c.key)).toEqual([...SOSCO_COMPONENTS]);
  });

  it('үр дүн SoscoScoreResult zod гэрээнд таарна (SCORED ба INSUFFICIENT_DATA)', () => {
    for (const r of [score(FULL), score({ ...FULL, ficoScore: null }), score(NONE), score(inp({ ficoScore: 575, incomeReliability: 60 }))]) {
      expect(SoscoScoreResult.parse(r)).toEqual(r);
    }
  });

  it('-0 үүсэхгүй (JSON.stringify(-0) = "0" боловч Object.is-аар ялгагдана)', () => {
    const r = score({ ...FULL, ltv: 1, ficoScore: 300 });
    for (const c of r.components) {
      expect(Object.is(c.points, -0)).toBe(false);
      expect(Object.is(c.effectiveWeight, -0)).toBe(false);
      expect(c.normalized === null || !Object.is(c.normalized, -0)).toBe(true);
    }
  });
});
