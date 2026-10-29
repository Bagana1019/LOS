import { Clock } from '../ports';

// Asia/Ulaanbaatar = тогтмол UTC+8 (DST байхгүй). POS-BR-9 "өнөөдөр" гэдэг нь Улаанбаатарын өдөр.
export const MN_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

/** `YYYY-MM-DD` (Улаанбаатарын огноо). */
export function mnDateKey(date: Date): string {
  return new Date(date.getTime() + MN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Улаанбаатарын өдрийн эхлэл (UTC момент). */
export function mnStartOfDay(date: Date): Date {
  return new Date(Date.parse(`${mnDateKey(date)}T00:00:00.000Z`) - MN_OFFSET_MS);
}

/** Улаанбаатарын өдрийн [эхлэл, төгсгөл) — UTC моментоор. */
export function mnDayRange(date: Date): [Date, Date] {
  const start = mnStartOfDay(date);
  return [start, new Date(start.getTime() + DAY_MS)];
}

/** `from`-оос `to` хүртэлх (хоёр захыг оруулан) Улаанбаатарын огнооны жагсаалт. */
export function mnDaysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const last = Date.parse(`${mnDateKey(to)}T00:00:00.000Z`);
  for (let t = Date.parse(`${mnDateKey(from)}T00:00:00.000Z`); t <= last; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Лизингийн дугаарын огнооны хэсэг `YYMMDD` (Улаанбаатарын огноо). */
export function mnYYMMDD(date: Date): string {
  return mnDateKey(date).slice(2).replace(/-/g, '');
}

export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
export const addSeconds = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);
export const addHours = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
