import { describe, expect, it } from 'vitest';
import { YMD, addMonths, formatUbDateTime, lastDayOfMonth, lastMonths, monthStart, nextMonthStart, ubDayStartUtc } from './report-dates';

describe('report-dates (Asia/Ulaanbaatar, UTC+8)', () => {
  it('formatUbDateTime (F11-4a): ISO UTC агшин → UB "YYYY-MM-DD HH:mm"; миллисекунд/секундийг хасна, өдөр/сар/жил шилжинэ', () => {
    expect(formatUbDateTime('2026-11-20T06:19:04.927Z')).toBe('2026-11-20 14:19');
    expect(formatUbDateTime('2026-10-28T02:00:00.000Z')).toBe('2026-10-28 10:00');
    expect(formatUbDateTime('2026-11-20T17:30:00.000Z')).toBe('2026-11-21 01:30');
    expect(formatUbDateTime('2026-12-31T16:00:00.000Z')).toBe('2027-01-01 00:00');
    expect(formatUbDateTime('2026-02-28T16:00:00.000Z')).toBe('2026-03-01 00:00');
    expect(formatUbDateTime('2026-11-20T15:59:59.999Z')).toBe('2026-11-20 23:59'); // минут нь доош бөөрөнхийлөгдөнө
  });

  it('formatUbDateTime: цагийн бүстэй оролт ч ижил агшин (+09:00 → UB)', () => {
    expect(formatUbDateTime('2026-11-20T15:19:04+09:00')).toBe('2026-11-20 14:19');
  });

  it('formatUbDateTime: хүчинтэй бус агшин → оролтыг өөрчлөхгүй (тайлан унахгүй)', () => {
    expect(formatUbDateTime('not-a-date')).toBe('not-a-date');
    expect(formatUbDateTime('')).toBe('');
  });

  it('ubDayStartUtc: UB өдрийн 00:00 = өмнөх өдрийн 16:00 UTC (timestamp(3) харьцуулалт)', () => {
    expect(ubDayStartUtc('2026-10-28')).toBe('2026-10-27T16:00:00.000');
    expect(ubDayStartUtc('2026-01-01')).toBe('2025-12-31T16:00:00.000'); // жилийн хил
    expect(ubDayStartUtc('2028-03-01')).toBe('2028-02-29T16:00:00.000'); // високос
    expect(ubDayStartUtc('2026-10-28')).toHaveLength(23);
  });

  it('monthStart / nextMonthStart', () => {
    expect(monthStart('2026-10-28')).toBe('2026-10-01');
    expect(nextMonthStart('2026-10-28')).toBe('2026-11-01');
    expect(nextMonthStart('2026-12-31')).toBe('2027-01-01');
  });

  it('addMonths: жилийн хил, сөрөг, олон жил', () => {
    expect(addMonths('2026-10', 0)).toBe('2026-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', -11)).toBe('2025-11');
    expect(addMonths('2026-03', -14)).toBe('2025-01');
    expect(addMonths('2026-03', 24)).toBe('2028-03');
    expect(addMonths('2026-01', -12)).toBe('2025-01');
  });

  it('lastDayOfMonth: 28/29/30/31', () => {
    expect(lastDayOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-04-01')).toBe('2026-04-30');
    expect(lastDayOfMonth('2026-12-31')).toBe('2026-12-31');
    expect(lastDayOfMonth('2026-10-28')).toBe('2026-10-31');
  });

  it('lastMonths: asOf-ийг агуулсан n сар, эртнээс сүүлчийнх рүү', () => {
    expect(lastMonths('2026-10-28', 12)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(lastMonths('2026-01-15', 3)).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(lastMonths('2026-01-15', 1)).toEqual(['2026-01']);
  });

  it('YMD', () => {
    expect(YMD.test('2026-10-28')).toBe(true);
    for (const bad of ['2026-1-28', '20261028', '2026-10-28T00:00', '', 'abc']) expect(YMD.test(bad), bad).toBe(false);
  });
});
