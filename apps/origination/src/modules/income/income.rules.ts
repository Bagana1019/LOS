// FR-4 · Цэвэр дүрмүүд (DB-гүй, unit тесттэй).
import { averageMonthlySalary, type YearMonth } from '@los/calc';
import type { IncomeBlocker, IncomeBorrowerView, IncomeSummaryView } from '@los/contracts';

export const BSA_INACTIVE_MESSAGE = 'BSA дэд модуль хараахан идэвхгүй (Модуль 12 ирэх хүртэл бизнесийн орлого тооцогдохгүй)';

export const parseYearMonth = (s: string): YearMonth => ({ year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) });
export const formatYearMonth = (ym: YearMonth): string => `${ym.year}-${String(ym.month).padStart(2, '0')}`;
const ordinal = (ym: YearMonth): number => ym.year * 12 + (ym.month - 1);

/** Сонгосон дундаж хугацаа ирээдүй сар агуулж болохгүй. */
export const isFutureMonth = (ym: YearMonth, now: Date): boolean => ordinal(ym) > now.getUTCFullYear() * 12 + now.getUTCMonth();

/** `income_summary.period_from/to` (DATE) → "YYYY-MM". */
export const dateToYearMonth = (d: Date): YearMonth => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
export const monthStart = (ym: YearMonth): Date => new Date(Date.UTC(ym.year, ym.month - 1, 1));
export const monthEnd = (ym: YearMonth): Date => new Date(Date.UTC(ym.year, ym.month, 0));

export interface SalaryRow { year: number; month: number; salary: number }
export interface SummaryRow {
  periodFrom: Date | null; periodTo: Date | null; avgSalaryMonthly: number | null; businessNcfMonthly: number | null;
  householdExpenseMonthly: number | null; businessExpenseMonthly: number | null;
}

/** Хадгалагдсан хугацааны цалингийн нийт ба дундаж (харуулахад). Хугацаа байхгүй бол null-ууд. */
export function summaryView(row: SummaryRow | null, salaries: readonly SalaryRow[]): IncomeSummaryView {
  const empty: IncomeSummaryView = { periodFrom: null, periodTo: null, months: null, salaryTotal: null, avgSalaryMonthly: null, businessNcfMonthly: null, householdExpenseMonthly: null, businessExpenseMonthly: null };
  if (!row) return empty;
  const base = { ...empty, businessNcfMonthly: row.businessNcfMonthly, householdExpenseMonthly: row.householdExpenseMonthly, businessExpenseMonthly: row.businessExpenseMonthly, avgSalaryMonthly: row.avgSalaryMonthly };
  if (!row.periodFrom || !row.periodTo) return base;
  const from = dateToYearMonth(row.periodFrom);
  const to = dateToYearMonth(row.periodTo);
  const calc = averageMonthlySalary(salaries, from, to);
  return { ...base, periodFrom: formatYearMonth(from), periodTo: formatYearMonth(to), months: calc.months, salaryTotal: calc.total };
}

/** Орлого тогтоогдсон эсэх: цалингийн дундаж > 0, гар орлого > 0, эсвэл (BSA-аас ирсэн) бизнесийн ЦМУ > 0. */
export const hasIncome = (summary: Pick<IncomeSummaryView, 'avgSalaryMonthly' | 'businessNcfMonthly'>, manualMonthlyTotal: number): boolean =>
  (summary.avgSalaryMonthly ?? 0) > 0 || manualMonthlyTotal > 0 || (summary.businessNcfMonthly ?? 0) > 0;

export interface IncomeParticipant { customerId: string; role: 'PRIMARY' | 'CO_BORROWER'; included: boolean; displayName: string }

/**
 * FR-8.6-д ашиглах шалтгаан: орлогыг нэгтгэдэг (үндсэн + `income_included` хамтран зээлдэгч) оролцогч бүрт орлого байх ёстой.
 * Үндсэн зээлдэгч байхгүй бол `NO_PRIMARY_BORROWER`.
 */
export function incomeBlockers(participants: readonly IncomeParticipant[], views: ReadonlyMap<string, Pick<IncomeBorrowerView, 'hasIncome'>>): IncomeBlocker[] {
  if (!participants.some((p) => p.role === 'PRIMARY')) {
    return [{ code: 'NO_PRIMARY_BORROWER', step: 'income', customerId: null, message: 'Үндсэн зээлдэгч сонгогдоогүй байна. 1-р алхамд сонгоно уу' }];
  }
  return participants
    .filter((p) => p.included && !views.get(p.customerId)?.hasIncome)
    .map((p) => ({ code: 'INCOME_MISSING' as const, step: 'income' as const, customerId: p.customerId, message: `${p.displayName}: цалин, гар орлого эсвэл бизнесийн орлого оруулаагүй байна` }));
}

/** `income` алхам: блокергүй бол COMPLETED; үгүй бол PENDING + шалтгаан. */
export function incomeStepTarget(blockers: readonly IncomeBlocker[]): { status: 'PENDING' | 'COMPLETED'; reason: IncomeBlocker['code'] | null } {
  return blockers.length ? { status: 'PENDING', reason: blockers[0]!.code } : { status: 'COMPLETED', reason: null };
}
