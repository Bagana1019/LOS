// Parse anхааруулгын кодууд ба цуглуулагч. Тодорхойгүй шийдвэр бүр код + хуудас/мөртэй анхааруулга үлдээнэ (NFR-8).
import type { ParseWarning } from '../statement.types';

export const PARSE_WARNING = {
  /** Мөр шиг харагдсан ч уншигдаагүй (verifier-т ERROR болно) */
  UNPARSED_ROW: 'UNPARSED_ROW',
  /** Хуулга шинэ→хуучин дарааллаар байсан тул эргүүлсэн */
  REVERSED_ORDER: 'REVERSED_ORDER',
  /** Дебит/кредит багана системтэйгээр урвуу (үлдэгдлийн өөрчлөлттэй зөрсөн) тул сольсон */
  DIRECTION_SWAPPED: 'DIRECTION_SWAPPED',
  /** Чиглэлийг баганаас биш үлдэгдлийн өөрчлөлтөөс тодорхойлсон */
  DIRECTION_FROM_BALANCE: 'DIRECTION_FROM_BALANCE',
  /** Мөр толгойн баганатай таараагүй тул баруунаас token-оор уншсан */
  ROW_FALLBACK_LAYOUT: 'ROW_FALLBACK_LAYOUT',
  TABLE_HEADER_NOT_FOUND: 'TABLE_HEADER_NOT_FOUND',
  TABLE_HEADER_CHANGED: 'TABLE_HEADER_CHANGED',
  HEADER_FIELD_CONFLICT: 'HEADER_FIELD_CONFLICT',
  HEADER_FIELD_INVALID: 'HEADER_FIELD_INVALID',
  PERIOD_DERIVED: 'PERIOD_DERIVED',
  CURRENCY_ASSUMED: 'CURRENCY_ASSUMED',
  TIME_MISSING: 'TIME_MISSING',
  TIME_UNEXPECTED: 'TIME_UNEXPECTED',
  CONTINUATION_DROPPED: 'CONTINUATION_DROPPED',
  DATE_ONLY_LINE_MERGED: 'DATE_ONLY_LINE_MERGED',
  BALANCE_ROW_SKIPPED: 'BALANCE_ROW_SKIPPED',
  WARNINGS_TRUNCATED: 'WARNINGS_TRUNCATED',
} as const;
export type ParseWarningCode = typeof PARSE_WARNING[keyof typeof PARSE_WARNING];

/** Кодоор хязгаарлагдсан цуглуулагч: хэтэрсэн хэсэг WARNINGS_TRUNCATED-д тоологдоно. PII (утга, нэр, данс) мессежид бичихгүй. */
export class WarningCollector {
  private readonly items: ParseWarning[] = [];
  private readonly counts = new Map<string, number>();
  private readonly seenOnce = new Set<string>();

  constructor(private readonly maxPerCode: number) {}

  add(code: ParseWarningCode, message: string, page?: number, line?: number): void {
    const n = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, n);
    if (n > this.maxPerCode) return;
    const w: ParseWarning = { code, message };
    if (page !== undefined) w.page = page;
    if (line !== undefined) w.line = line;
    this.items.push(w);
  }

  /** Код тутамд нэг л удаа (системтэй шийдвэр: нэгтгэсэн мэдээлэл) */
  addOnce(code: ParseWarningCode, message: string, page?: number, line?: number): void {
    if (this.seenOnce.has(code)) return;
    this.seenOnce.add(code);
    this.add(code, message, page, line);
  }

  count(code: ParseWarningCode): number {
    return this.counts.get(code) ?? 0;
  }

  /** Эцсийн жагсаалт; хязгаар хэтэрсэн кодуудын нийт тоог нэмж бичнэ */
  finish(): ParseWarning[] {
    for (const [code, n] of this.counts) {
      if (n > this.maxPerCode) {
        this.items.push({ code: PARSE_WARNING.WARNINGS_TRUNCATED, message: `${code}: ${n} warnings in total, first ${this.maxPerCode} kept` });
      }
    }
    return this.items;
  }
}
