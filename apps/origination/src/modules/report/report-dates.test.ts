import { describe, expect, it } from 'vitest';
import { YMD, addMonths, lastDayOfMonth, lastMonths, monthStart, nextMonthStart, ubDayStartUtc } from './report-dates';

describe('report-dates (Asia/Ulaanbaatar, UTC+8)', () => {
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
