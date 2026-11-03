import { describe, expect, it } from 'vitest';
import {
  dateToYearMonth, formatYearMonth, hasIncome, incomeBlockers, incomeStepTarget, isFutureMonth, monthEnd, monthStart, parseYearMonth, summaryView, type IncomeParticipant,
} from './income.rules';

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = new Date('2026-11-03T02:00:00Z');

describe('year-month helpers', () => {
  it('parse / format / month bounds / future', () => {
    expect(parseYearMonth('2026-02')).toEqual({ year: 2026, month: 2 });
    expect(formatYearMonth({ year: 2026, month: 2 })).toBe('2026-02');
    expect(monthStart({ year: 2026, month: 2 }).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(monthEnd({ year: 2028, month: 2 }).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(monthEnd({ year: 2026, month: 12 }).toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(dateToYearMonth(d('2026-03-31'))).toEqual({ year: 2026, month: 3 });
    expect(isFutureMonth({ year: 2026, month: 11 }, NOW)).toBe(false);
    expect(isFutureMonth({ year: 2026, month: 12 }, NOW)).toBe(true);
    expect(isFutureMonth({ year: 2025, month: 12 }, NOW)).toBe(false);
  });
});

describe('summaryView (FR-4.1)', () => {
  const salaries = Array.from({ length: 12 }, (_, i) => ({ year: 2025, month: i + 1, salary: 1_000_000 + i * 100_000 }));
  const row = { periodFrom: d('2025-01-01'), periodTo: d('2025-12-31'), avgSalaryMonthly: 1_550_000, businessNcfMonthly: null, householdExpenseMonthly: 400_000, businessExpenseMonthly: null };
  it('no row → everything null', () => {
    expect(summaryView(null, salaries)).toMatchObject({ periodFrom: null, avgSalaryMonthly: null, salaryTotal: null, months: null });
  });
  it('12 months of salary → total and monthly average (M4 AC)', () => {
    expect(summaryView(row, salaries)).toMatchObject({ periodFrom: '2025-01', periodTo: '2025-12', months: 12, salaryTotal: 18_600_000, avgSalaryMonthly: 1_550_000, householdExpenseMonthly: 400_000 });
  });
  it('a row without a period (only expenses saved) keeps the expense fields and no totals', () => {
    expect(summaryView({ ...row, periodFrom: null, periodTo: null, avgSalaryMonthly: null }, salaries)).toMatchObject({ periodFrom: null, months: null, salaryTotal: null, householdExpenseMonthly: 400_000 });
  });
});

describe('hasIncome', () => {
  it('salary average, manual income or BSA business cash flow each count; zero / null / negative do not', () => {
    expect(hasIncome({ avgSalaryMonthly: 1, businessNcfMonthly: null }, 0)).toBe(true);
    expect(hasIncome({ avgSalaryMonthly: null, businessNcfMonthly: null }, 1)).toBe(true);
    expect(hasIncome({ avgSalaryMonthly: 0, businessNcfMonthly: 1 }, 0)).toBe(true);
    expect(hasIncome({ avgSalaryMonthly: 0, businessNcfMonthly: null }, 0)).toBe(false);
    expect(hasIncome({ avgSalaryMonthly: null, businessNcfMonthly: -500 }, 0)).toBe(false);
  });
});

describe('incomeBlockers / incomeStepTarget (FR-8.6)', () => {
  const primary: IncomeParticipant = { customerId: 'p', role: 'PRIMARY', included: true, displayName: 'Овог Нэр' };
  const co: IncomeParticipant = { customerId: 'c', role: 'CO_BORROWER', included: true, displayName: 'Хамтран' };
  const coExcluded: IncomeParticipant = { customerId: 'x', role: 'CO_BORROWER', included: false, displayName: 'Орлого нэгтгээгүй' };
  const views = (m: Record<string, boolean>) => new Map(Object.entries(m).map(([k, v]) => [k, { hasIncome: v }]));

  it('no primary → NO_PRIMARY_BORROWER', () => {
    const b = incomeBlockers([co], views({}));
    expect(b).toEqual([expect.objectContaining({ code: 'NO_PRIMARY_BORROWER', step: 'income', customerId: null })]);
    expect(incomeStepTarget(b)).toEqual({ status: 'PENDING', reason: 'NO_PRIMARY_BORROWER' });
  });
  it('a contributor without income blocks with INCOME_MISSING naming them; the excluded co-borrower never blocks', () => {
    const b = incomeBlockers([primary, co, coExcluded], views({ p: true, c: false, x: false }));
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ code: 'INCOME_MISSING', customerId: 'c' });
    expect(b[0]!.message).toContain('Хамтран');
    expect(incomeStepTarget(b)).toEqual({ status: 'PENDING', reason: 'INCOME_MISSING' });
  });
  it('everyone included has income → COMPLETED', () => {
    expect(incomeStepTarget(incomeBlockers([primary, co], views({ p: true, c: true })))).toEqual({ status: 'COMPLETED', reason: null });
  });
  it('a participant missing from the views map counts as no income', () => {
    expect(incomeBlockers([primary], views({}))).toHaveLength(1);
  });
});
