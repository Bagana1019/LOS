import { describe, it, expect } from 'vitest';
import { addDays, agingBucket, daysPastDue, diffDays, parRatio, ulaanbaatarDate } from './aging';

describe('aging', () => {
  it('ulaanbaatarDate: UTC+8', () => {
    expect(ulaanbaatarDate(new Date('2026-10-28T15:59:00Z'))).toBe('2026-10-28');
    expect(ulaanbaatarDate(new Date('2026-10-28T16:00:00Z'))).toBe('2026-10-29');
  });
  it('addDays / diffDays сар, жилийн хилээр', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-01-01', '2026-03-01')).toBe(59);
    expect(diffDays('2026-03-01', '2026-01-01')).toBe(-59);
    expect(() => diffDays('2026/01/01', '2026-01-02')).toThrow(/YYYY-MM-DD/);
  });
  it('daysPastDue: хугацаа өнгөрөөгүй бол 0', () => {
    expect(daysPastDue('2026-10-20', '2026-10-28')).toBe(8);
    expect(daysPastDue('2026-10-28', '2026-10-28')).toBe(0);
    expect(daysPastDue('2026-11-05', '2026-10-28')).toBe(0);
  });
  it('agingBucket хил', () => {
    expect([0, -3, 1, 30, 31, 60, 61, 90, 91, 400].map(agingBucket)).toEqual([
      'CURRENT', 'CURRENT', 'DPD_1_30', 'DPD_1_30', 'DPD_31_60', 'DPD_31_60', 'DPD_61_90', 'DPD_61_90', 'DPD_90_PLUS', 'DPD_90_PLUS',
    ]);
  });
  it('parRatio', () => {
    expect(parRatio(250, 1000)).toBe(0.25);
    expect(parRatio(1, 3)).toBe(0.333333);
    expect(parRatio(0, 1000)).toBe(0);
    expect(parRatio(10, 0)).toBeNull();
  });
});
