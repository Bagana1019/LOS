import { addDays } from '@los/calc';
import type { CollateralMonitoringItem } from '@los/contracts';

// FR-6.9, FR-14.6 мониторинг: идэвхтэй зээлийн барьцааг дахин үнэлэх / даатгал дуусах / LTV хэтэрсэн. ЦЭВЭР функц.

export type MonitoringReason = CollateralMonitoringItem['reasons'][number];

export function monitoringReasons(args: {
  /** УБ-ын өнөөдөр (YYYY-MM-DD). */
  today: string;
  withinDays: number;
  nextRevaluationAt: string | null;
  insuranceExpiresAt: string | null;
  /** Хүсэлтийн LTV дээд хязгаарыг хангаж буй эсэх; тооцох боломжгүй бол null. */
  ltvPass: boolean | null;
}): MonitoringReason[] {
  const end = addDays(args.today, args.withinDays);
  const out: MonitoringReason[] = [];
  if (args.nextRevaluationAt && args.nextRevaluationAt <= end) out.push('REVALUATION_DUE');
  if (args.insuranceExpiresAt) {
    if (args.insuranceExpiresAt < args.today) out.push('INSURANCE_EXPIRED');
    else if (args.insuranceExpiresAt <= end) out.push('INSURANCE_EXPIRING');
  }
  if (args.ltvPass === false) out.push('LTV_BREACH');
  return out;
}

/** Мониторингийн жагсаалтын эрэмбэ: дахин үнэлэх огноо ойр нь эхэнд (огноогүй нь сүүлд), дараа нь хүсэлтийн дугаар. */
export function compareMonitoring(a: Pick<CollateralMonitoringItem, 'nextRevaluationAt' | 'appNo' | 'collateralId'>, b: Pick<CollateralMonitoringItem, 'nextRevaluationAt' | 'appNo' | 'collateralId'>): number {
  if (a.nextRevaluationAt !== b.nextRevaluationAt) {
    if (a.nextRevaluationAt == null) return 1;
    if (b.nextRevaluationAt == null) return -1;
    return a.nextRevaluationAt < b.nextRevaluationAt ? -1 : 1;
  }
  return a.appNo.localeCompare(b.appNo) || a.collateralId.localeCompare(b.collateralId);
}
