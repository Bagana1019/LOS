import { describe, expect, it } from 'vitest';
import { averageMonthlySalary, periodMonths } from './income';

const year2025 = (salary: number) => Array.from({ length: 12 }, (_, i) => ({ year: 2025, month: i + 1, salary }));

describe('periodMonths', () => {
  it('counts calendar months inclusively, across year boundaries', () => {
    expect(periodMonths({ year: 2025, month: 1 }, { year: 2025, month: 12 })).toBe(12);
    expect(periodMonths({ year: 2025, month: 11 }, { year: 2026, month: 2 })).toBe(4);
    expect(periodMonths({ year: 2025, month: 5 }, { year: 2025, month: 5 })).toBe(1);
  });
  it('rejects bad months, reversed and too-long periods', () => {
    expect(() => periodMonths({ year: 2025, month: 0 }, { year: 2025, month: 1 })).toThrow(RangeError);
    expect(() => periodMonths({ year: 2025, month: 1 }, { year: 2025, month: 13 })).toThrow(RangeError);
    expect(() => periodMonths({ year: 2025.5, month: 1 }, { year: 2026, month: 1 })).toThrow(RangeError);
    expect(() => periodMonths({ year: 2025, month: 6 }, { year: 2025, month: 5 })).toThrow(/before/);
    expect(() => periodMonths({ year: 2020, month: 1 }, { year: 2025, month: 1 })).toThrow(/longer/);
  });
});

describe('averageMonthlySalary (FR-4.1, M4 AC)', () => {
  it('12 months of salary → exact monthly average', () => {
    const r = averageMonthlySalary(year2025(1_500_000), { year: 2025, month: 1 }, { year: 2025, month: 12 });
    expect(r).toEqual({ months: 12, monthsWithSalary: 12, total: 18_000_000, average: 1_500_000 });
  });
  it('varying salaries average correctly and round to 2 dp', () => {
    const rows = [{ year: 2025, month: 1, salary: 1_000_000 }, { year: 2025, month: 2, salary: 1_000_000 }, { year: 2025, month: 3, salary: 1_000_001 }];
    const r = averageMonthlySalary(rows, { year: 2025, month: 1 }, { year: 2025, month: 3 });
    expect(r.total).toBe(3_000_001);
    expect(r.average).toBe(1_000_000.33);
  });
  it('months without salary are ignored: the average is over months that have salary', () => {
    const rows = year2025(1_200_000).slice(6); // Jul..Dec only
    const r = averageMonthlySalary(rows, { year: 2025, month: 1 }, { year: 2025, month: 12 });
    expect(r).toMatchObject({ months: 12, monthsWithSalary: 6, total: 7_200_000, average: 1_200_000 });
  });
  it('several employers in one month are summed; out-of-period and non-positive rows ignored', () => {
    const rows = [
      { year: 2025, month: 1, salary: 800_000 }, { year: 2025, month: 1, salary: 200_000 },
      { year: 2024, month: 12, salary: 9_999_999 }, { year: 2025, month: 2, salary: 0 }, { year: 2025, month: 2, salary: -5 }, { year: 2025, month: 2, salary: Number.NaN },
    ];
    const r = averageMonthlySalary(rows, { year: 2025, month: 1 }, { year: 2025, month: 2 });
    expect(r).toEqual({ months: 2, monthsWithSalary: 1, total: 1_000_000, average: 1_000_000 });
  });
  it('no rows → zero average', () => {
    expect(averageMonthlySalary([], { year: 2025, month: 1 }, { year: 2025, month: 3 })).toEqual({ months: 3, monthsWithSalary: 0, total: 0, average: 0 });
  });
});
