// FR-4.1 · Цалингийн сарын дундаж. Цэвэр функц (I/O байхгүй).

export interface SalaryMonth { year: number; month: number; salary: number }
export interface YearMonth { year: number; month: number }

export interface SalaryAverage {
  /** Сонгосон хугацааны календарийн сарын тоо (from..to, хоёр үзүүлэлт орно) */
  months: number;
  /** Цалин орсон сарын тоо */
  monthsWithSalary: number;
  total: number;
  /** total / months — цалин ороогүй сар 0 гэж тооцогдоно (консерватив). 2 орон хүртэл */
  average: number;
}

export const MAX_PERIOD_MONTHS = 60;

const ordinal = (ym: YearMonth): number => ym.year * 12 + (ym.month - 1);
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** from..to хугацаанд (хоёр үзүүлэлт орно) календарийн сарын тоо. */
export function periodMonths(from: YearMonth, to: YearMonth): number {
  for (const ym of [from, to]) {
    if (!Number.isInteger(ym.year) || !Number.isInteger(ym.month) || ym.month < 1 || ym.month > 12) throw new RangeError('Year/month is invalid');
  }
  const n = ordinal(to) - ordinal(from) + 1;
  if (n < 1) throw new RangeError('Period end is before period start');
  if (n > MAX_PERIOD_MONTHS) throw new RangeError(`Period is longer than ${MAX_PERIOD_MONTHS} months`);
  return n;
}

/**
 * Сонгосон хугацааны цалингийн нийт ба сарын дундаж. Нэг сард олон мөр (олон ажил олгогч) байвал нийлбэрлэнэ;
 * хугацаанаас гадуурх мөр, сөрөг/тоо биш цалинг тооцохгүй. Цалин ороогүй сар 0 гэж дундажид орно.
 */
export function averageMonthlySalary(rows: readonly SalaryMonth[], from: YearMonth, to: YearMonth): SalaryAverage {
  const months = periodMonths(from, to);
  const lo = ordinal(from);
  const hi = ordinal(to);
  const perMonth = new Map<number, number>();
  for (const r of rows) {
    const o = ordinal(r);
    if (o < lo || o > hi || !Number.isFinite(r.salary) || r.salary <= 0) continue;
    perMonth.set(o, (perMonth.get(o) ?? 0) + r.salary);
  }
  const total = round2([...perMonth.values()].reduce((s, v) => s + v, 0));
  return { months, monthsWithSalary: perMonth.size, total, average: round2(total / months) };
}
