import type { ApplicationDetail, StepKey, StepStatus } from '@los/contracts';
import { t } from '../../lib/i18n';

export interface BlockedStep { key: StepKey; status: StepStatus }

/**
 * F2-3 / F3-6: «Илгээх»-ийг хаасан алхмууд. Дүрмийг (заавал алхам бүрдсэн эсэх, STALE = бүрдээгүй) сервер шийднэ:
 * `transitions[SUBMITTED].blockedBy` нь submit-ийн G1 хаалттай ижил `missingRequiredSteps`-ээс гарна — энд дахин тооцохгүй, зөвхөн алхам бүрийн төлөвийг (бүрдээгүй/хуучирсан) нэмнэ.
 */
export function blockedSubmitSteps(app: Pick<ApplicationDetail, 'steps' | 'transitions'>): readonly BlockedStep[] {
  const blockedBy = app.transitions.find((x) => x.to === 'SUBMITTED')?.blockedBy ?? [];
  return blockedBy.map((key) => ({ key, status: app.steps.find((s) => s.stepKey === key)?.status ?? 'PENDING' }));
}

/** Дутуу алхам бүрийг зүүн самбартай ижил нэр, төлвөөр нэрлэсэн тайлбар; хаалт байхгүй бол null. */
export function blockedSubmitHint(blocked: readonly BlockedStep[]): string | null {
  if (blocked.length === 0) return null;
  const steps = blocked.map((b) => `${t(`application.step.${b.key}`)} (${t(`application.stepStatus.${b.status}`)})`).join(', ');
  return t('application.submit.blocked', { steps });
}
