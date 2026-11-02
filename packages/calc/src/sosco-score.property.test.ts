// Sosco Score — seeded (LCG) property test. Шинэ dependency-гүй; seed тогтмол тул алдаа бүрэн давтагдана.
// Өгөгдөл: 3,000 санамсаргүй ХҮЧИНТЭЙ (оролт, жин, босго, муруй). Шалгах: 0..1000 бүхэл оноо, зэрэг = gradeFor(оноо),
// effectiveWeight нийлбэр 1, SoscoScoreResult zod, ганц бүрэлдэхүүн сайжрахад оноо буурахгүй (монотон), давтагдах чанар.
import { describe, expect, it } from 'vitest';
import { SOSCO_COMPONENTS, SoscoScoreResult, type SoscoComponentKey } from '@los/contracts';
import {
  DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS, gradeFor, normalizeDti, normalizeFico, normalizeHistory, normalizeLtv, normalizeReliability, normalizeSuspicious, soscoScore, validateSoscoModel,
  type SoscoCurves, type SoscoGradeThresholds, type SoscoInput, type SoscoWeights,
} from './sosco-score';

const CASES = 3000;

/** Numerical Recipes LCG (32 бит). Math.imul нь float нарийвчлалын алдаагүй үржвэр өгнө */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const rng = makeRng(20261029);
const between = (lo: number, hi: number): number => lo + (hi - lo) * rng();
const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const fixed = (x: number, digits: number): number => Number(x.toFixed(digits));
/** Магадлал p-ээр null */
const orNull = (p: number, make: () => number): number | null => (rng() < p ? null : make());

function genWeights(): SoscoWeights {
  const raw = SOSCO_COMPONENTS.map(() => (rng() < 0.15 ? 0 : rng()));
  const total = raw.reduce((a, b) => a + b, 0);
  const norm = total === 0 ? [1, 0, 0, 0, 0, 0] : raw.map((x) => x / total);
  return Object.fromEntries(SOSCO_COMPONENTS.map((k, i) => [k, norm[i]])) as SoscoWeights;
}

function genThresholds(): SoscoGradeThresholds {
  const picked = new Set<number>();
  while (picked.size < 4) picked.add(int(1, 1000));
  const [A, B, C, D] = [...picked].sort((a, b) => b - a);
  return { A, B, C, D, E: 0 };
}

function genCurves(): SoscoCurves {
  const ficoMin = int(0, 400);
  const dtiBest = int(0, 50);
  const ltvBest = fixed(between(0, 0.6), 2);
  return {
    fico: { min: ficoMin, max: ficoMin + int(1, 700) },
    dti: { bestPercent: dtiBest, worstPercent: dtiBest + int(1, 150) },
    ltv: { best: ltvBest, worst: fixed(ltvBest + between(0.05, 1.5), 2) },
    suspiciousPenaltyPerFlag: fixed(between(0, 1), 2),
    history: { overdueMonthsWorst: fixed(between(0.5, 36), 1), activeLoanPenalty: fixed(between(0, 0.5), 2) },
    minCoverage: fixed(between(0, 0.9), 2),
  };
}

function genInput(): SoscoInput {
  return {
    ficoScore: orNull(0.2, () => fixed(between(0, 1100), int(0, 1))),
    dtiPercent: orNull(0.2, () => fixed(between(0, 150), 1)),
    incomeReliability: orNull(0.2, () => fixed(between(0, 100), 1)),
    pendingSuspiciousCount: orNull(0.2, () => int(0, 8)),
    activeLoanCount: orNull(0.2, () => int(0, 8)),
    overdueHistoryMonths: orNull(0.2, () => int(0, 40)),
    ltv: orNull(0.2, () => fixed(between(0, 2), 2)),
  };
}

/** Бүрэлдэхүүнийг ХАТУУ сайжруулсан оролт; сайжруулах боломжгүй (аль хэдийн хамгийн сайн/мэдэгдэхгүй) бол null */
function improve(i: SoscoInput, key: SoscoComponentKey): SoscoInput | null {
  switch (key) {
    case 'fico':
      return i.ficoScore === null ? null : { ...i, ficoScore: i.ficoScore + 0.5 + rng() * 200 };
    case 'dti':
      return i.dtiPercent === null || i.dtiPercent === 0 ? null : { ...i, dtiPercent: Math.max(0, i.dtiPercent - 0.1 - rng() * 50) };
    case 'reliability':
      return i.incomeReliability === null || i.incomeReliability === 100 ? null : { ...i, incomeReliability: Math.min(100, i.incomeReliability + 0.1 + rng() * 50) };
    case 'suspicious':
      return i.pendingSuspiciousCount === null || i.pendingSuspiciousCount === 0 ? null : { ...i, pendingSuspiciousCount: i.pendingSuspiciousCount - 1 };
    case 'history':
      if (i.overdueHistoryMonths === null) return null;
      if (i.overdueHistoryMonths > 0) return { ...i, overdueHistoryMonths: i.overdueHistoryMonths - 1 };
      return (i.activeLoanCount ?? 0) > 0 ? { ...i, activeLoanCount: (i.activeLoanCount ?? 0) - 1 } : null;
    case 'ltv':
      return i.ltv === null || i.ltv === 0 ? null : { ...i, ltv: Math.max(0, i.ltv - 0.01 - rng() * 0.5) };
  }
}

describe('soscoScore — property test (seeded LCG)', () => {
  it(`${CASES} санамсаргүй хүчинтэй тохиолдол`, () => {
    let scored = 0;
    let insufficient = 0;
    let monotoneChecks = 0;
    const grades = new Set<string>();

    for (let n = 0; n < CASES; n++) {
      const [w, t, c, input, version] = [genWeights(), genThresholds(), genCurves(), genInput(), int(1, 50)];
      expect(() => validateSoscoModel(w, t, c)).not.toThrow();
      const r = soscoScore(input, w, t, c, version);

      // гэрээ + бүтэц
      expect(SoscoScoreResult.parse(r)).toEqual(r);
      expect(r.modelVersion).toBe(version);
      expect(r.components.map((x) => x.key)).toEqual([...SOSCO_COMPONENTS]);
      expect(r.coverage).toBeGreaterThanOrEqual(0);
      expect(r.coverage).toBeLessThanOrEqual(1);

      // availability: null оролт ↔ available=false (history нь overdueHistoryMonths-оор)
      const expectedAvailable = [input.ficoScore, input.dtiPercent, input.incomeReliability, input.pendingSuspiciousCount, input.overdueHistoryMonths, input.ltv].map((v) => v !== null);
      expect(r.components.map((x) => x.available)).toEqual(expectedAvailable);
      for (const x of r.components) {
        expect(x.weight).toBe(w[x.key]);
        if (x.available) {
          expect(x.normalized).toBeGreaterThanOrEqual(0);
          expect(x.normalized).toBeLessThanOrEqual(1);
        } else {
          expect(x).toMatchObject({ input: null, normalized: null, effectiveWeight: 0, points: 0 });
        }
      }

      // normalized = экспортлогдсон normalizeXxx
      const byKey = Object.fromEntries(r.components.map((x) => [x.key, x]));
      if (input.ficoScore !== null) expect(byKey.fico.normalized).toBe(normalizeFico(input.ficoScore, c.fico));
      if (input.dtiPercent !== null) expect(byKey.dti.normalized).toBe(normalizeDti(input.dtiPercent, c.dti));
      if (input.incomeReliability !== null) expect(byKey.reliability.normalized).toBe(normalizeReliability(input.incomeReliability));
      if (input.pendingSuspiciousCount !== null) expect(byKey.suspicious.normalized).toBe(normalizeSuspicious(input.pendingSuspiciousCount, c.suspiciousPenaltyPerFlag));
      if (input.overdueHistoryMonths !== null) expect(byKey.history.normalized).toBe(normalizeHistory(input.overdueHistoryMonths, input.activeLoanCount ?? 0, c.history));
      if (input.ltv !== null) expect(byKey.ltv.normalized).toBe(normalizeLtv(input.ltv, c.ltv));

      // effectiveWeight нийлбэр 1 (мэдэгдсэн жин > 0 үед), эс бөгөөс 0
      const knownWeight = r.components.filter((x) => x.available).reduce((s, x) => s + x.weight, 0);
      const effectiveSum = r.components.reduce((s, x) => s + x.effectiveWeight, 0);
      if (knownWeight > 0) expect(effectiveSum).toBeCloseTo(1, 12);
      else expect(effectiveSum).toBe(0);
      expect(Math.abs(r.coverage - knownWeight)).toBeLessThanOrEqual(0.5e-4 + 1e-12); // 4 оронд бөөрөнхийлсөн

      // тодорхой статус
      const insufficientExpected = !(knownWeight > 0) || r.coverage < c.minCoverage;
      expect(r.status).toBe(insufficientExpected ? 'INSUFFICIENT_DATA' : 'SCORED');

      if (r.status === 'INSUFFICIENT_DATA') {
        insufficient++;
        expect(r.score).toBeNull();
        expect(r.grade).toBeNull();
        continue;
      }

      scored++;
      expect(Number.isInteger(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1000);
      expect(r.grade).toBe(gradeFor(r.score as number, t));
      grades.add(r.grade as string);
      // points нийлбэр ≈ оноо: 6 × 0.05 (points-ийн бөөрөнхийлөлт) + 0.5 (оноогийн бөөрөнхийлөлт)
      const pointsSum = r.components.reduce((s, x) => s + x.points, 0);
      expect(Math.abs(pointsSum - (r.score as number))).toBeLessThanOrEqual(0.8 + 1e-9);

      // давтагдах чанар
      expect(soscoScore(input, w, t, c, version)).toEqual(r);

      // монотон: нэг бүрэлдэхүүн ХАТУУ сайжирвал (ижил бүрэлдэхүүнүүд мэдэгдэх үед) оноо буурахгүй
      for (const key of SOSCO_COMPONENTS) {
        const better = improve(input, key);
        if (better === null) continue;
        const rb = soscoScore(better, w, t, c, version);
        monotoneChecks++;
        expect(rb.status).toBe('SCORED');
        expect(rb.coverage).toBe(r.coverage);
        expect(rb.score as number).toBeGreaterThanOrEqual(r.score as number);
        const before = r.components.find((x) => x.key === key)?.normalized as number;
        const after = rb.components.find((x) => x.key === key)?.normalized as number;
        expect(after).toBeGreaterThanOrEqual(before);
      }
    }

    // Тест хоосон биш гэдгийг баталгаажуулна (seed тогтмол → тоонууд тогтвортой)
    expect(CASES).toBeGreaterThanOrEqual(2000);
    expect(scored).toBeGreaterThan(1000);
    expect(insufficient).toBeGreaterThan(50);
    expect(monotoneChecks).toBeGreaterThan(5000);
    expect(grades.size).toBeGreaterThanOrEqual(4);
  }, 60_000); // ~4с (24k soscoScore + expect); зэрэгцээ ачаалалтай CI-д 5с-ийн анхдагч хугацаа хүрэлцэхгүй байж болно
});

// ───────────── Яг рациональ арифметикийн oracle (BigInt) ─────────────
// Decimal (40 орон)-ын үр дүнг ТОГТМОЛ бутархайн (BigInt) яг үр дүнтэй харьцуулна. Тусгайлан «яг .5» (tie) тохиолдлууд олон гарахаар
// дискрет сүлжээнээс (5 нэгж fico, 2.5% dti, 0.5 найдвар…) сонгоно: tie дээр float бол буруу бөөрөнхийлөх байсан.
class Q {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    const g = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : g(b, a % b));
    const sign = d < 0n ? -1n : 1n;
    const k = g(n, d) || 1n;
    this.n = (sign * n) / k;
    this.d = (sign * d) / k;
  }
  add(o: Q): Q { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Q): Q { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Q): Q { return new Q(this.n * o.n, this.d * o.d); }
  div(o: Q): Q { return new Q(this.n * o.d, this.d * o.n); }
  lt(o: Q): boolean { return this.n * o.d < o.n * this.d; }
  gt(o: Q): boolean { return this.n * o.d > o.n * this.d; }
}
/** Аравтын тэмдэгт мөрөөс ( ≤ 3 орон ) яг бутархай */
const q = (x: number): Q => {
  const [whole, frac = ''] = String(x).split('.');
  return new Q(BigInt(whole + frac), 10n ** BigInt(frac.length));
};
const Q0 = new Q(0n);
const Q1 = new Q(1n);
const clampQ = (x: Q): Q => (x.lt(Q0) ? Q0 : x.gt(Q1) ? Q1 : x);

/** DEFAULT муруйн (docs/05 §3) яг томьёо; round-half-up(1000 × Σ жин×утга ÷ Σ мэдэгдсэн жин) */
function exactDefaultScore(i: SoscoInput): { score: number; tie: boolean } {
  const w = DEFAULT_SOSCO_WEIGHTS;
  const parts: Array<[number, Q]> = [];
  if (i.ficoScore !== null) parts.push([w.fico, clampQ(q(i.ficoScore).sub(q(300)).div(q(550)))]);
  if (i.dtiPercent !== null) parts.push([w.dti, clampQ(q(80).sub(q(i.dtiPercent)).div(q(60)))]);
  if (i.incomeReliability !== null) parts.push([w.reliability, clampQ(q(i.incomeReliability).div(q(100)))]);
  if (i.pendingSuspiciousCount !== null) parts.push([w.suspicious, clampQ(Q1.sub(q(0.2).mul(q(i.pendingSuspiciousCount))))]);
  if (i.overdueHistoryMonths !== null) {
    parts.push([w.history, clampQ(Q1.sub(q(i.overdueHistoryMonths).div(q(12))).sub(q(0.05).mul(q(i.activeLoanCount ?? 0))))]);
  }
  if (i.ltv !== null) parts.push([w.ltv, clampQ(Q1.sub(q(i.ltv)).div(q(0.7)))]);
  const num = parts.reduce((s, [wt, u]) => s.add(q(wt).mul(u)), Q0);
  const den = parts.reduce((s, [wt]) => s.add(q(wt)), Q0);
  const half = num.div(den).mul(q(1000)).add(new Q(1n, 2n)); // floor(raw + 1/2)
  return { score: Number(half.n / half.d), tie: half.d === 1n };
}

describe('soscoScore — яг рациональ oracle (BigInt), DEFAULT загвар', () => {
  it('20,000 сүлжээний тохиолдол, tie-үүд ороод oracle-той яг таарна', () => {
    const grid = makeRng(424242);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(grid() * xs.length)];
    const range = (count: number, from: number, step: number): number[] => Array.from({ length: count }, (_, k) => Number((from + k * step).toFixed(3)));
    const ficos = range(111, 300, 5);
    const dtis = range(25, 20, 2.5);
    const reliabilities = range(201, 0, 0.5);
    const ltvs = range(29, 0.3, 0.025);
    const maybe = (v: number): number | null => (grid() < 0.25 ? null : v);

    let compared = 0;
    let ties = 0;
    for (let n = 0; n < 20000; n++) {
      const input: SoscoInput = {
        ficoScore: maybe(pick(ficos)),
        dtiPercent: maybe(pick(dtis)),
        incomeReliability: maybe(pick(reliabilities)),
        pendingSuspiciousCount: maybe(pick([0, 1, 2, 3, 4, 5, 6])),
        activeLoanCount: maybe(pick([0, 1, 2, 3, 4])),
        overdueHistoryMonths: maybe(pick(range(14, 0, 1))),
        ltv: maybe(pick(ltvs)),
      };
      // minCoverage 0: аль болох олон тохиолдол оноотой (бүрэн тохиолдол л хасагдана)
      const r = soscoScore(input, DEFAULT_SOSCO_WEIGHTS, DEFAULT_SOSCO_GRADE_THRESHOLDS, { ...DEFAULT_SOSCO_CURVES, minCoverage: 0 }, 1);
      if (r.status !== 'SCORED') continue;
      const exact = exactDefaultScore(input);
      compared++;
      if (exact.tie) ties++;
      if (r.score !== exact.score) expect.fail(`score ${r.score} != exact ${exact.score} (tie=${exact.tie}) for ${JSON.stringify(input)}`);
    }
    expect(compared).toBeGreaterThan(15000);
    expect(ties).toBeGreaterThan(50); // ~0.5% тохиолдол яг .5
  }, 60_000);
});
