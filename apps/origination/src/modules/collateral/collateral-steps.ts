// 5-р алхам `collateral` ба `score` алхмын төлөв (docs/05 §6, FR-6.4, FR-14.4). Цэвэр функц.

export interface StepRow { id: string; stepKey: string; status: string; staleReason: string | null }
export interface StepUpdate { id: string; stepKey: string; status: 'PENDING' | 'COMPLETED' | 'STALE'; staleReason: string | null; /** undefined — өөрчлөхгүй */ completedAt?: Date | null }

export const COLLATERAL_STEP = 'collateral';
export const SCORE_STEP = 'score';
export const COLLATERAL_CHANGED = 'COLLATERAL_CHANGED';

export interface CollateralStepChange {
  /** G0 хангагдсан (`CollateralGate.complete`). */
  gateComplete: boolean;
  /**
   * Барьцааны бүрдэл / үнэлгээ өөрчлөгдсөн (нэмэх, хасах, үнэлгээ, тодорхойлолт/өмчлөгч засах) → `score` COMPLETED бол STALE.
   * Өмчлөл/ачаалал шалгалт, баримт, ЭБ бүртгэл, дахин тооцоолол (recheck) нь тооцооллыг өөрчлөхгүй → false.
   */
  scoreAffected: boolean;
}

/**
 * `collateral` алхам: gate.complete → COMPLETED (`completedAt`), үгүй → PENDING. COMPLETED хэвээр бол `completedAt`-ийг хөндөхгүй.
 * `score` алхам: `scoreAffected` ба COMPLETED бол STALE (`COLLATERAL_CHANGED`).
 * LOCKED алхамд хэзээ ч хүрэхгүй (Модуль 2 нээнэ); мөр байхгүй бол алгасна. Өөрчлөлтгүй бол хоосон жагсаалт (идемпотент).
 */
export function planCollateralStepUpdate(steps: readonly StepRow[], change: CollateralStepChange, now: Date): StepUpdate[] {
  const out: StepUpdate[] = [];
  const open = (key: string): StepRow | undefined => steps.find((s) => s.stepKey === key && s.status !== 'LOCKED');

  const collateral = open(COLLATERAL_STEP);
  if (collateral) {
    const target = change.gateComplete ? 'COMPLETED' : 'PENDING';
    if (collateral.status !== target) out.push({ id: collateral.id, stepKey: COLLATERAL_STEP, status: target, staleReason: null, completedAt: target === 'COMPLETED' ? now : null });
  }
  if (change.scoreAffected) {
    const score = open(SCORE_STEP);
    if (score && score.status === 'COMPLETED') out.push({ id: score.id, stepKey: SCORE_STEP, status: 'STALE', staleReason: COLLATERAL_CHANGED });
  }
  return out;
}
