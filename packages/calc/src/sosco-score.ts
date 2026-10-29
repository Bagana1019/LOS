// Sosco Score — дотоод зээлжих чадварын оноо (0–1000). Логик нь энэ monorepo-д бичигдэнэ (шийдвэр 2026-10-28).
// Жин, босго, муруй — scoring.sosco_model хүснэгтээс (admin). Дэлгэрэнгүй: docs/05-scoring-sosco.md §3.
import type { SoscoCurves, SoscoGradeThresholds, SoscoInput, SoscoScoreResult, SoscoWeights } from '@los/contracts';

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

export function soscoScore(
  _input: SoscoInput, _weights: SoscoWeights, _thresholds: SoscoGradeThresholds, _curves: SoscoCurves, _modelVersion: number,
): SoscoScoreResult {
  throw new Error('TODO(M08b): normalise components, renormalise missing weights, grade by thresholds');
}
