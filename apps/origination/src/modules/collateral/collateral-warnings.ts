import { addDays } from '@los/calc';
import type { CollateralWarning } from '@los/contracts';

// FR-6.6 (IN_OTHER_DRAFT), FR-6.9 (INSURANCE_EXPIRING, REVALUATION_DUE, RELEASED), FR-14.6. ЦЭВЭР функц — хориг биш, зөвхөн анхааруулга.

export interface WarningSubject {
  id: string;
  releasedAt: Date | null;
  /** YYYY-MM-DD */
  insuranceExpiresAt: string | null;
  /** YYYY-MM-DD */
  nextRevaluationAt: string | null;
}

export function computeCollateralWarnings(args: {
  subjects: readonly WarningSubject[];
  /** УБ-ын өнөөдөр (YYYY-MM-DD). */
  today: string;
  /** setting `collateral.insurance_reminder_days`. */
  insuranceReminderDays: number;
  /** collateralId → хөрөнгө бүртгэгдсэн ӨӨР ноорог/буцаасан хүсэлтүүдийн дугаар. */
  otherDrafts?: Readonly<Record<string, readonly string[]>>;
}): CollateralWarning[] {
  const out: CollateralWarning[] = [];
  const reminderEnd = addDays(args.today, args.insuranceReminderDays);
  for (const s of args.subjects) {
    if (s.releasedAt) {
      out.push({ code: 'RELEASED', collateralId: s.id, message: 'Барьцааг чөлөөлсөн' });
      continue;
    }
    const drafts = args.otherDrafts?.[s.id];
    if (drafts?.length) out.push({ code: 'IN_OTHER_DRAFT', collateralId: s.id, message: `Энэ хөрөнгө өөр ноорог хүсэлтэд (${drafts.join(', ')}) мөн бүртгэгдсэн байна. Хоёуланг нь илгээх боломжгүй` });
    if (s.insuranceExpiresAt) {
      if (s.insuranceExpiresAt < args.today) out.push({ code: 'INSURANCE_EXPIRING', collateralId: s.id, message: `Даатгалын хугацаа ${s.insuranceExpiresAt}-нд дууссан` });
      else if (s.insuranceExpiresAt <= reminderEnd) out.push({ code: 'INSURANCE_EXPIRING', collateralId: s.id, message: `Даатгалын хугацаа ${s.insuranceExpiresAt}-нд дуусна` });
    }
    if (s.nextRevaluationAt && s.nextRevaluationAt <= args.today) out.push({ code: 'REVALUATION_DUE', collateralId: s.id, message: `Дахин үнэлэх хугацаа (${s.nextRevaluationAt}) болсон` });
  }
  return out;
}
