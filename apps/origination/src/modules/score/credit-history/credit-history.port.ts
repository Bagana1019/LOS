import type { RequestContext } from '@los/contracts';

/**
 * ЗМС / FICO-оос авах зээлийн түүх (FR-3, Sosco Score-ийн оролт, идэвхтэй өрийн төлбөр).
 * Талбар бүр `null` = "мэдэгдэхгүй": тооцоолол/оноо түүнийг оруулахгүй (шагнахгүй, шийтгэхгүй) — хэзээ ч зохиомол утга өгөхгүй.
 */
export interface CreditHistory {
  ficoScore: number | null;
  activeLoanCount: number | null;
  /** Сүүлийн хугацаанд хугацаа хэтэрсэн сарын тоо */
  overdueHistoryMonths: number | null;
  /** Идэвхтэй зээлүүдийн сарын нийт төлбөр (₮) */
  existingDebtServiceMonthly: number | null;
}

/** `null` = лавлагаа байхгүй / авах боломжгүй (бүх талбар мэдэгдэхгүй). */
export interface CreditHistoryPort {
  get(ctx: RequestContext, applicationId: string, customerId: string): Promise<CreditHistory | null>;
}
export const CREDIT_HISTORY = Symbol('CREDIT_HISTORY');
