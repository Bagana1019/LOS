// Огнооны туслахууд — бүх "өдөр" нь Asia/Ulaanbaatar (UTC+8, DST-гүй) календарийн өдөр, YYYY-MM-DD (packages/calc/aging.ts-тэй ижил).
import { addDays } from '@los/calc';

/**
 * UB өдрийн эхлэл → DB-ийн `timestamp(3)` (UTC, цагийн бүсгүй) баганатай харьцуулах утга. Жишээ: '2026-10-28' → '2026-10-27T16:00:00.000'.
 * SQL-д `${x}::timestamp` гэж cast хийж ашиглана.
 */
export function ubDayStartUtc(day: string): string {
  return new Date(`${day}T00:00:00+08:00`).toISOString().slice(0, 23);
}

/** 'YYYY-MM-DD' → 'YYYY-MM-01'. */
export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;

/** 'YYYY-MM' + n сар → 'YYYY-MM'. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Дараагийн сарын 1-ний өдөр. */
export const nextMonthStart = (day: string): string => `${addMonths(day.slice(0, 7), 1)}-01`;

/** Тухайн сарын сүүлийн өдөр. */
export const lastDayOfMonth = (day: string): string => addDays(nextMonthStart(day), -1);

/** asOf-ийг агуулсан сүүлийн n сар (эртнээс сүүлчийнх рүү), 'YYYY-MM'. */
export function lastMonths(asOf: string, n: number): string[] {
  const cur = asOf.slice(0, 7);
  return Array.from({ length: n }, (_, i) => addMonths(cur, i - (n - 1)));
}

export const YMD = /^\d{4}-\d{2}-\d{2}$/;
