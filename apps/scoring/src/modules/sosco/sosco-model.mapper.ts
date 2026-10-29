// scoring.sosco_model мөр ⇄ SoscoModelView / @los/calc оролт. Цэвэр функцүүд.
import type { SoscoModel } from '.prisma/client-scoring';
import { DEFAULT_SOSCO_CURVES } from '@los/calc';
import type { SoscoCurves, SoscoGradeThresholds, SoscoModelView, SoscoWeights } from '@los/contracts';

export interface ModelParams { weights: SoscoWeights; gradeThresholds: SoscoGradeThresholds; curves: SoscoCurves }

/**
 * Муруй (`params_json`). null — Модуль 0-ийн хуучин v1 мөр (муруй хадгалагдаагүй байсан): тэр үед ажиллаж байсан DEMO муруй
 * (`DEFAULT_SOSCO_CURVES`)-ийг хэрэглэнэ. Шинэ хувилбар үргэлж муруйг тодорхой хадгална.
 */
export const curvesOf = (row: Pick<SoscoModel, 'paramsJson'>): SoscoCurves => (row.paramsJson as SoscoCurves | null) ?? structuredClone(DEFAULT_SOSCO_CURVES);

export const paramsOf = (row: Pick<SoscoModel, 'weightsJson' | 'gradeThresholdsJson' | 'paramsJson'>): ModelParams => ({
  weights: row.weightsJson as unknown as SoscoWeights,
  gradeThresholds: row.gradeThresholdsJson as unknown as SoscoGradeThresholds,
  curves: curvesOf(row),
});

export const toModelView = (row: SoscoModel): SoscoModelView => ({
  id: row.id,
  version: row.version,
  isActive: row.isActive,
  ...paramsOf(row),
  createdAt: row.createdAt.toISOString(),
  createdBy: row.createdBy,
});
