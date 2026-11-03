// FR-3 · Цэвэр дүрмүүд (DB-гүй, unit тесттэй).
import { INQUIRY_SOURCES, type CreditHistorySummary, type InquiryBlacklistResult, type InquiryRecord, type InquiryWarningLevel, type UnregisteredLoan } from '@los/contracts';
import type { ProviderResult } from '../../integrations/inquiry/inquiry.provider';

const DAY_MS = 86_400_000;

/** FR-3.5 · expires_at = fetched_at + stale_days. */
export const expiresAt = (fetchedAt: Date, staleDays: number): Date => new Date(fetchedAt.getTime() + staleDays * DAY_MS);

/** FR-3.4 · хар жагсаалт: олдвол RED анхааруулга (хориг БИШ — BR-9). */
export function blacklistInquiry(bl: InquiryBlacklistResult): ProviderResult {
  const warningLevel: InquiryWarningLevel = bl.hit ? 'RED' : 'NONE';
  return { summary: { hit: bl.hit, reason_codes: [...new Set(bl.reasons.map((r) => r.reasonCode))] }, detail: { hit: bl.hit, reasons: bl.reasons }, warningLevel };
}

type Keyed = Pick<InquiryRecord, 'customerId' | 'source' | 'fetchedAt'>;

/** (харилцагч × эх сурвалж) бүрийн хамгийн сүүлийн мөр. Оролтын дарааллыг хадгална. */
export function latestPerSource<T extends Keyed>(rows: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.customerId}\u0000${r.source}`;
    const cur = best.get(key);
    if (!cur || r.fetchedAt > cur.fetchedAt) best.set(key, r);
  }
  const order = new Map<string, number>(INQUIRY_SOURCES.map((s, i) => [s, i]));
  return [...best.values()].sort((a, b) => a.customerId.localeCompare(b.customerId) || (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Тооцоололд (underwriting, Sosco) хэрэгтэй хураангуй. ЗМС татаагүй бол өрийн төлбөр `null`; бүртгэлгүй зээлийн сарын төлбөр нэмэгдэнэ.
 * Зөвхөн бүртгэлгүй зээлтэй, ЗМС татаагүй бол өрийн төлбөр = бүртгэлгүй зээлийн нийлбэр (мэдэгдэж буй доод хэмжээ).
 */
export function creditHistoryFrom(latest: ReadonlyArray<Pick<InquiryRecord, 'source' | 'summary'>>, loans: ReadonlyArray<Pick<UnregisteredLoan, 'monthlyPayment'>>): CreditHistorySummary {
  const cib = latest.find((r) => r.source === 'CIB')?.summary;
  const fico = latest.find((r) => r.source === 'FICO')?.summary;
  const unregistered = loans.reduce((s, l) => s + l.monthlyPayment, 0);
  const cibMonthly = num(cib?.monthly_payment);
  return {
    ficoScore: num(fico?.fico_score),
    activeLoanCount: num(cib?.active_loan_count),
    overdueHistoryMonths: num(cib?.overdue_months),
    existingDebtServiceMonthly: cibMonthly === null && loans.length === 0 ? null : Math.round(((cibMonthly ?? 0) + unregistered) * 100) / 100,
  };
}
