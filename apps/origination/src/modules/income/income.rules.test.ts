import { describe, expect, it } from 'vitest';
import {
  dateToYearMonth, formatYearMonth, hasIncome, incomeBlockers, incomeStepTarget, isFutureMonth, manualSalaryConflict, monthEnd, monthStart, normalizeEmployer, parseYearMonth,
  SALARY_CONFLICT_CODE, salaryConflictMessage, summaryView, supersededManualIds, type IncomeParticipant, type SalaryRef,
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

// F2-14 · Нэг (хүсэлт, зээлдэгч, сар)-д гар цалингийн нэг мөр; НДШ-д байгаа сард гараар давхар оруулахгүй (ажил олгогч нь өөр бол «нэмэлт ажил»).
describe('manualSalaryConflict / supersededManualIds (F2-14)', () => {
  const EMP = 'Монгол Шуудан ХХК';
  const row = (year: number, month: number, source: SalaryRef['source'], employer: string | null = null): SalaryRef => ({ year, month, source, employer });
  const candidate = (month: number, employer: string | null = null) => ({ year: 2026, month, employer });

  it('normalizeEmployer: trims, collapses spaces, ignores case; null / blank are the same empty value', () => {
    expect(normalizeEmployer('  Монгол   ШУУДАН ХХК ')).toBe('монгол шуудан ххк');
    expect(normalizeEmployer(null)).toBe('');
    expect(normalizeEmployer('   ')).toBe('');
    expect(normalizeEmployer(undefined)).toBe('');
  });
  it('no existing rows, or only other months → no conflict', () => {
    expect(manualSalaryConflict(candidate(10), [])).toBeNull();
    expect(manualSalaryConflict(candidate(10), [row(2026, 9, 'MANUAL'), row(2025, 10, 'MANUAL'), row(2026, 9, 'NDSH', EMP)])).toBeNull();
  });
  it('manual vs manual, same month: the same employer (any case / spacing) → MANUAL_MONTH_EXISTS', () => {
    expect(manualSalaryConflict(candidate(10, EMP), [row(2026, 10, 'MANUAL', EMP)])).toBe('MANUAL_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10, ' монгол  шуудан ххк'), [row(2026, 10, 'MANUAL', EMP)])).toBe('MANUAL_MONTH_EXISTS');
  });
  it('manual vs manual, same month: a blank employer is a wildcard on either side (blank+blank, blank+named, named+blank)', () => {
    expect(manualSalaryConflict(candidate(10), [row(2026, 10, 'MANUAL')])).toBe('MANUAL_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10, EMP), [row(2026, 10, 'MANUAL')])).toBe('MANUAL_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10), [row(2026, 10, 'MANUAL', EMP)])).toBe('MANUAL_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10, '   '), [row(2026, 10, 'MANUAL', EMP)])).toBe('MANUAL_MONTH_EXISTS');
  });
  it('manual vs manual, same month: two different named employers are both allowed; a repeat of either one is not', () => {
    expect(manualSalaryConflict(candidate(10, 'Б ХХК'), [row(2026, 10, 'MANUAL', 'А ХХК')])).toBeNull();
    const both = [row(2026, 10, 'MANUAL', 'А ХХК'), row(2026, 10, 'MANUAL', 'Б ХХК')];
    expect(manualSalaryConflict(candidate(10, 'В ХХК'), both)).toBeNull();
    expect(manualSalaryConflict(candidate(10, 'а ххк'), both)).toBe('MANUAL_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10, 'Б ХХК'), both)).toBe('MANUAL_MONTH_EXISTS');
  });
  it('manual rows of other months or other employers in other months never conflict', () => {
    expect(manualSalaryConflict(candidate(10, EMP), [row(2026, 9, 'MANUAL', EMP), row(2025, 10, 'MANUAL', EMP)])).toBeNull();
  });
  it('same month in НДШ with a blank or the same employer (any case / spacing) → NDSH_MONTH_EXISTS', () => {
    expect(manualSalaryConflict(candidate(10), [row(2026, 10, 'NDSH', EMP)])).toBe('NDSH_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10, ' монгол  шуудан ххк'), [row(2026, 10, 'NDSH', EMP)])).toBe('NDSH_MONTH_EXISTS');
    expect(manualSalaryConflict(candidate(10), [row(2026, 10, 'NDSH', null)])).toBe('NDSH_MONTH_EXISTS');
  });
  it('same month in НДШ but a different, named employer → allowed (second job, summed by the calc)', () => {
    expect(manualSalaryConflict(candidate(10, 'Хоёр дахь ажил'), [row(2026, 10, 'NDSH', EMP)])).toBeNull();
  });
  it('both a manual and an НДШ row exist → the manual duplicate is reported', () => {
    expect(manualSalaryConflict(candidate(10), [row(2026, 10, 'NDSH', EMP), row(2026, 10, 'MANUAL', 'X')])).toBe('MANUAL_MONTH_EXISTS');
  });
  it('supersededManualIds: manual rows that repeat an НДШ month (blank / same employer) are returned; others stay', () => {
    const manual = [
      { id: 'blank', ...row(2026, 10, 'MANUAL') },
      { id: 'same', ...row(2026, 9, 'MANUAL', 'МОНГОЛ ШУУДАН ХХК') },
      { id: 'second-job', ...row(2026, 8, 'MANUAL', 'Хоёр дахь ажил') },
      { id: 'other-month', ...row(2025, 1, 'MANUAL') },
    ];
    const ndsh = [row(2026, 10, 'NDSH', EMP), row(2026, 9, 'NDSH', EMP), row(2026, 8, 'NDSH', EMP)];
    expect(supersededManualIds(manual, ndsh)).toEqual(['blank', 'same']);
    expect(supersededManualIds(manual, [])).toEqual([]);
  });
  it('stable error codes and Mongolian messages that name the month', () => {
    expect(SALARY_CONFLICT_CODE).toEqual({ MANUAL_MONTH_EXISTS: 'SALARY_MONTH_DUPLICATE', NDSH_MONTH_EXISTS: 'SALARY_MONTH_IN_NDSH' });
    const dup = salaryConflictMessage('MANUAL_MONTH_EXISTS', { year: 2026, month: 3 });
    expect(dup).toMatch(/2026-03.*ижил ажил олгогч.*ажил олгогчгүй.*нэрийг заан/);
    expect(dup).not.toMatch(/нийлбэр|нэг мөрөөр/); // хоёр ажил олгогчийг нэг мөрөөр нийлүүлэх зөвлөгөөг хассан
    expect(salaryConflictMessage('NDSH_MONTH_EXISTS', { year: 2026, month: 11 })).toMatch(/2026-11.*НДШ/);
  });
});
