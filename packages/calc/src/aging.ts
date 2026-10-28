// Огнооны тооцоо (YYYY-MM-DD, Asia/Ulaanbaatar) ба зээлийн хугацаа хэтрэлтийн ангилал (DPD / PAR).
// Огноог UTC цагийн 00:00 гэж үзэж өдрөөр зөрүү бодно — DST асуудалгүй. I/O байхгүй (CLAUDE.md §2.2).
import type { AgingBucket } from '@los/contracts';
import Decimal from 'decimal.js';

const MS_PER_DAY = 86_400_000;
const UB_OFFSET_MS = 8 * 3_600_000; // Монгол DST-гүй (2017-оос), UTC+8

const parse = (d: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`Огноо YYYY-MM-DD форматтай байх ёстой: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/** Улаанбаатарын календарийн өдөр (YYYY-MM-DD). */
export function ulaanbaatarDate(now: Date): string {
  return new Date(now.getTime() + UB_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(parse(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** to − from (өдрөөр). */
export function diffDays(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / MS_PER_DAY);
}

/** Хугацаа хэтэрсэн өдөр (days past due). Төлөх өдөр өнгөрөөгүй бол 0. */
export function daysPastDue(dueDate: string, asOf: string): number {
  return Math.max(0, diffDays(dueDate, asOf));
}

export function agingBucket(dpd: number): AgingBucket {
  if (dpd <= 0) return 'CURRENT';
  if (dpd <= 30) return 'DPD_1_30';
  if (dpd <= 60) return 'DPD_31_60';
  if (dpd <= 90) return 'DPD_61_90';
  return 'DPD_90_PLUS';
}

/** PAR = хугацаа хэтэрсэн зээлийн үлдэгдэл ÷ нийт үлдэгдэл. Үлдэгдэл 0 бол null. */
export function parRatio(overduePrincipal: number, outstandingPrincipal: number): number | null {
  if (outstandingPrincipal <= 0) return null;
  return new Decimal(overduePrincipal).div(outstandingPrincipal).toDecimalPlaces(6).toNumber();
}
