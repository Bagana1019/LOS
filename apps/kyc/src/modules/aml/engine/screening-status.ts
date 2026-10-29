import type { AmlHit, ScreeningStatus } from '@los/contracts';

/**
 * Hit-үүдийн төлвөөс screening-ийн төлөв. Зөвхөн BLOCKING severity-тэй hit л REVIEW_REQUIRED / CONFIRMED_MATCH үүсгэнэ,
 * severity нь бодлогоос (AmlPolicy.block*) хамаарна — BR-9: дотоод хар жагсаалт анхдагчаар зөвхөн WARNING.
 */
export function deriveScreeningStatus(hits: Pick<AmlHit, 'severity' | 'status'>[]): ScreeningStatus {
  if (hits.length === 0) return 'CLEAR';
  if (hits.some((h) => h.severity === 'BLOCKING' && h.status === 'CONFIRMED')) return 'CONFIRMED_MATCH';
  if (hits.some((h) => h.severity === 'BLOCKING' && h.status === 'OPEN')) return 'REVIEW_REQUIRED';
  if (hits.some((h) => h.status !== 'FALSE_POSITIVE')) return 'WARNING';
  return 'CLEARED_AFTER_REVIEW';
}

/** Origination энэ утгаар хүсэлтийг үргэлжлүүлэхийг хаана (BR-9 нь зөвхөн дотоод хар жагсаалтад хамаарна). */
export function isBlocking(status: ScreeningStatus): boolean {
  return status === 'REVIEW_REQUIRED' || status === 'CONFIRMED_MATCH';
}
