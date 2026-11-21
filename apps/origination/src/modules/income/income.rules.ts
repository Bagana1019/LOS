// FR-4 · Цэвэр дүрмүүд (DB-гүй, unit тесттэй).
import { averageMonthlySalary, type YearMonth } from '@los/calc';
import type { IncomeBlocker, IncomeBorrowerView, IncomeSummaryView } from '@los/contracts';

export const BSA_PENDING_MESSAGE = 'Бизнесийн орлого оруулаагүй байна. BSA (банкны хуулгын шинжилгээ) хийж «Системрүү татах» товчийг дарна уу';
export const BSA_PULLED_MESSAGE = 'Бизнесийн орлого BSA шинжилгээнээс татагдсан';

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

/** Ажил олгогчийн нэрийг харьцуулах хэлбэр: зай/том жижиг үсгийг үл тооно; null = хоосон. */
export const normalizeEmployer = (e: string | null | undefined): string => (e ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export interface SalaryRef { year: number; month: number; employer: string | null; source: 'NDSH' | 'MANUAL' }
export type SalaryConflict = 'MANUAL_MONTH_EXISTS' | 'NDSH_MONTH_EXISTS';
export const SALARY_CONFLICT_CODE: Record<SalaryConflict, string> = { MANUAL_MONTH_EXISTS: 'SALARY_MONTH_DUPLICATE', NDSH_MONTH_EXISTS: 'SALARY_MONTH_IN_NDSH' };

export function salaryConflictMessage(conflict: SalaryConflict, ym: YearMonth): string {
  const month = formatYearMonth(ym);
  return conflict === 'MANUAL_MONTH_EXISTS'
    ? `${month} сард ижил ажил олгогчийн (эсвэл ажил олгогчгүй) цалингийн мөр аль хэдийн байна. Буруу бол өмнөх мөрийг устгаад дахин оруулна уу; өөр ажил олгогчийн цалин бол ажил олгогчийн нэрийг заан оруулна уу`
    : `${month} сарын цалин НДШ-ээс аль хэдийн татагдсан байна. Өөр ажил олгогчийн цалин бол ажил олгогчийн нэрийг заан оруулна уу`;
}

/** Гар мөр хоорондын ижил ажил олгогч: нэр нь тэнцүү, эсвэл аль нэг нь хоосон (хоосон = тодорхойгүй, дурын ажил олгогчтой давхцаж болзошгүй). */
const sameEmployerOrBlank = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = normalizeEmployer(a);
  const y = normalizeEmployer(b);
  return x === '' || y === '' || x === y;
};

/** НДШ-ийн мөр тухайн сард, ижил (эсвэл хоосон = тодорхойгүй) ажил олгогчийг хамарч байгаа эсэх. */
const ndshCovers = (ndsh: readonly SalaryRef[], ym: YearMonth, employer: string | null | undefined): boolean => {
  const emp = normalizeEmployer(employer);
  return ndsh.some((n) => n.source === 'NDSH' && n.year === ym.year && n.month === ym.month && (emp === '' || normalizeEmployer(n.employer) === emp));
};

/**
 * F2-14 · Гар цалин нэмэх давхардал. Нэг (хүсэлт, зээлдэгч, сар, ажил олгогч)-д гар (`MANUAL`) цалингийн нэг мөр: ижил нэртэй ажил олгогч, эсвэл
 * аль нэг талд ажил олгогч хоосон бол давхардал. Өөр өөр НЭРТЭЙ хоёр ажил олгогч нэг сард зөвшөөрөгдөж дундаж нийлбэрлэгдэнэ (DECISIONS 2026-11-03).
 * НДШ-д тэр сар байвал гар мөр нь ТОДОРХОЙ, өөр ажил олгогчийн (нэмэлт ажил) байх ёстой — хоосон/ижил ажил олгогч нь НДШ-ийн мөрийг давхарлана.
 * `existing` нь ижил хүсэлт, зээлдэгчийн одоогийн мөрүүд. Давхардахгүй бол null.
 */
export function manualSalaryConflict(candidate: { year: number; month: number; employer?: string | null }, existing: readonly SalaryRef[]): SalaryConflict | null {
  const sameMonth = existing.filter((r) => r.year === candidate.year && r.month === candidate.month);
  if (sameMonth.some((r) => r.source === 'MANUAL' && sameEmployerOrBlank(r.employer, candidate.employer))) return 'MANUAL_MONTH_EXISTS';
  return ndshCovers(sameMonth, candidate, candidate.employer) ? 'NDSH_MONTH_EXISTS' : null;
}

/** НДШ-ийг (дахин) татсаны дараа НДШ-ийн мөрөөр давхардсан болсон гар цалингийн мөрүүдийн id (НДШ эх сурвалжийн үнэн тул гар мөрийг хасна). */
export const supersededManualIds = (manual: ReadonlyArray<SalaryRef & { id: string }>, ndsh: readonly SalaryRef[]): string[] =>
  manual.filter((m) => m.source === 'MANUAL' && ndshCovers(ndsh, m, m.employer)).map((m) => m.id);

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
