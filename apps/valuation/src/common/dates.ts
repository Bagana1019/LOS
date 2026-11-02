import { ulaanbaatarDate } from '@los/calc';

// Asia/Ulaanbaatar is a fixed UTC+8 (no DST since 2017), the same convention as the other services. Dates the officer types
// (YYYY-MM-DD) are calendar days in that zone; stored timestamps are UTC instants.
const UB_OFFSET = '+08:00';
const MS_PER_DAY = 86_400_000;

/** A shape check (`IsoDate`) lets 2026-02-31 through; this accepts only real calendar days. */
export function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's calendar day in Ulaanbaatar (`YYYY-MM-DD`). */
export const todayUb = (now: Date): string => ulaanbaatarDate(now);

/** First instant of an Ulaanbaatar calendar day. */
export const ubDayStart = (date: string): Date => new Date(`${date}T00:00:00.000${UB_OFFSET}`);

/** Last millisecond of an Ulaanbaatar calendar day: "valid until 2026-12-31" still holds during 31 December. */
export const ubDayEnd = (date: string): Date => new Date(ubDayStart(date).getTime() + MS_PER_DAY - 1);

/** `@db.Date` columns are read back as UTC midnight. */
export const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** A `@db.Date` column value for an ISO day. */
export const dbDate = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
