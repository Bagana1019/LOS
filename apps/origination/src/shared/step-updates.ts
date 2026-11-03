import type { Tx } from '../prisma.service';

// Wizard-ийн алхмын төлөв шинэчлэх нийтлэг тусламж (inquiry, income модуль). LOCKED мөрийг хэзээ ч хөндөхгүй.

export interface StepRow { id: string; stepKey: string; status: string; staleReason: string | null }
export interface StepUpdate { id: string; stepKey: string; status: 'PENDING' | 'COMPLETED' | 'STALE'; staleReason: string | null; /** undefined — өөрчлөхгүй */ completedAt?: Date | null }

/** `stepKey` алхмын хүссэн төлөв ба шалтгаан одоогийнхтой ялгаатай үед л шинэчлэл гаргана (идемпотент). COMPLETED хэвээр бол `completedAt`-ийг хөндөхгүй. */
export function planStepTarget(steps: readonly StepRow[], stepKey: string, target: { status: 'PENDING' | 'COMPLETED'; reason: string | null }, now: Date): StepUpdate[] {
  const step = steps.find((s) => s.stepKey === stepKey && s.status !== 'LOCKED');
  if (!step) return [];
  const reason = target.status === 'COMPLETED' ? null : target.reason;
  if (step.status === target.status && step.staleReason === reason) return [];
  return [{ id: step.id, stepKey, status: target.status, staleReason: reason, completedAt: target.status === 'COMPLETED' ? (step.status === 'COMPLETED' ? undefined : now) : null }];
}

/** `score` алхам COMPLETED бол STALE болгоно (оролт өөрчлөгдсөн — FR-7.3-тэй адил). */
export function planScoreStale(steps: readonly StepRow[], reason: string): StepUpdate[] {
  const score = steps.find((s) => s.stepKey === 'score' && s.status === 'COMPLETED');
  return score ? [{ id: score.id, stepKey: 'score', status: 'STALE', staleReason: reason }] : [];
}

export async function loadSteps(tx: Tx, applicationId: string): Promise<StepRow[]> {
  return tx.loanApplicationStep.findMany({ where: { applicationId }, select: { id: true, stepKey: true, status: true, staleReason: true } });
}

export async function applyStepUpdates(tx: Tx, updates: readonly StepUpdate[], actorId: string | null): Promise<void> {
  for (const u of updates) {
    await tx.loanApplicationStep.updateMany({
      where: { id: u.id, status: { not: 'LOCKED' } },
      data: { status: u.status, staleReason: u.staleReason, ...(u.completedAt !== undefined ? { completedAt: u.completedAt } : {}), updatedBy: actorId },
    });
  }
}
