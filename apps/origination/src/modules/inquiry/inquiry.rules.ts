// FR-3 · Цэвэр дүрмүүд (DB-гүй, unit тесттэй).
import { INQUIRY_SOURCES, type InquiryBorrowerView, type InquiryItemView, type InquiryRecord, type InquirySource, type InquiryStatus, type UnregisteredLoan } from '@los/contracts';

const DAY_MS = 86_400_000;

/** FR-3.5 · fetchedAt + staleDays-ээс хойш бол хуучирсан. Хугацаа `inquiry.stale_days`-ийн ОДООГИЙН утгаар (admin өөрчилбөл шууд үйлчилнэ). */
export const expiryOf = (fetchedAt: Date, staleDays: number): Date => new Date(fetchedAt.getTime() + staleDays * DAY_MS);
export function inquiryStatus(fetchedAt: Date | null, staleDays: number, now: Date): InquiryStatus {
  if (!fetchedAt) return 'MISSING';
  return now.getTime() > expiryOf(fetchedAt, staleDays).getTime() ? 'STALE' : 'FRESH';
}

export interface Participant { customerId: string; role: 'PRIMARY' | 'CO_BORROWER' | 'GUARANTOR'; displayName: string; registerNoMasked: string }

/** Оролцогч бүрийн 11 эх сурвалжийн төлөв (дутуу = MISSING), хуучралт, бүртгэлгүй зээлтэй нийлсэн сарын өрийн төлбөр. */
export function buildBorrowerView(p: Participant, records: readonly InquiryRecord[], loans: readonly UnregisteredLoan[], staleDays: number, now: Date): InquiryBorrowerView {
  const mine = records.filter((r) => r.customerId === p.customerId);
  const items: InquiryItemView[] = INQUIRY_SOURCES.map((source) => {
    const r = mine.find((x) => x.source === source);
    const fetchedAt = r ? new Date(r.fetchedAt) : null;
    return {
      source,
      status: inquiryStatus(fetchedAt, staleDays, now),
      fetchedAt: r?.fetchedAt ?? null,
      expiresAt: fetchedAt ? expiryOf(fetchedAt, staleDays).toISOString() : null,
      warningLevel: r?.warningLevel ?? 'NONE',
      summary: r?.summary ?? {},
      detail: r?.detail ?? null,
    };
  });
  const myLoans = loans.filter((l) => l.customerId === p.customerId);
  const cibMonthly = items.find((i) => i.source === 'CIB')?.summary.monthly_payment;
  const monthly = (typeof cibMonthly === 'number' && Number.isFinite(cibMonthly) ? cibMonthly : 0) + myLoans.reduce((s, l) => s + l.monthlyPayment, 0);
  const missing = items.filter((i) => i.status === 'MISSING').map((i) => i.source as InquirySource);
  const hasStale = items.some((i) => i.status === 'STALE');
  return {
    customerId: p.customerId, role: p.role, displayName: p.displayName, registerNoMasked: p.registerNoMasked,
    complete: !missing.length && !hasStale, hasStale, missing, items, unregisteredLoans: myLoans, monthlyDebtPayment: Math.round(monthly * 100) / 100,
  };
}

export type InquiryStepReason = 'INQUIRY_MISSING' | 'INQUIRY_STALE' | 'NO_BORROWER';

/** `inquiry` алхам: оролцогч бүрт 11 лавлагаа байх ба хуучраагүй бол COMPLETED. Шалтгаан нь дутуу > хуучирсан. */
export function inquiryStepTarget(views: readonly Pick<InquiryBorrowerView, 'complete' | 'missing' | 'hasStale'>[]): { status: 'PENDING' | 'COMPLETED'; reason: InquiryStepReason | null } {
  if (!views.length) return { status: 'PENDING', reason: 'NO_BORROWER' };
  if (views.every((v) => v.complete)) return { status: 'COMPLETED', reason: null };
  return { status: 'PENDING', reason: views.some((v) => v.missing.length) ? 'INQUIRY_MISSING' : 'INQUIRY_STALE' };
}
