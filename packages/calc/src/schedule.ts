import Decimal from 'decimal.js';
// FR-7: ЭТХ. I/O-гүй, 100% unit test. Хоног тооцох арга: setting `schedule.day_count` (30/360 эсвэл ACT/365) — параметрээр ирнэ.
// Нэгж: annualRate = ЖИЛИЙН ХУВЬ (23.99); мөнгө = 2 оронтой (₮), half-up.

export const SCHEDULE_TYPES = ['ANNUITY', 'EQUAL_PRINCIPAL', 'QUARTERLY', 'BULLET'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];
export type DayCount = '30/360' | 'ACT/365';

export interface ScheduleParams {
  principal: number;
  annualRate: number;
  termMonths: number;
  type: ScheduleType;
  /** Олгох (зээл эхлэх) огноо, YYYY-MM-DD */
  startDate: string;
  /** Эхний төлбөрийн огноо, YYYY-MM-DD. Дараагийн төлбөрүүд ижил өдрөөр (сар дуусвал сарын сүүлийн өдрөөр) */
  firstPaymentDate: string;
  /** Үндсэн зээлээс чөлөөлөх сар — энэ хугацаанд зөвхөн хүү төлнө (FR-7.1) */
  graceMonths?: number;
  dayCount?: DayCount;
}
export interface ScheduleRow { seq: number; dueDate: string; days: number; disbursement: number; principal: number; interest: number; total: number; balance: number; }
export interface ScheduleSummary { installments: number; totalPrincipal: number; totalInterest: number; totalPayment: number; firstDueDate: string; endDate: string; }

export type ScheduleErrorCode = 'INVALID_PRINCIPAL' | 'INVALID_RATE' | 'INVALID_TERM' | 'INVALID_GRACE' | 'INVALID_DATE' | 'FIRST_PAYMENT_BEFORE_START';
export class ScheduleError extends Error {
  constructor(readonly code: ScheduleErrorCode, message: string) { super(message); this.name = 'ScheduleError'; }
}

const money = (d: Decimal.Value): Decimal => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function annuityPayment(principal: number, annualRate: number, n: number): number {
  const r = new Decimal(annualRate).div(100).div(12); if (r.isZero()) return new Decimal(principal).div(n).toNumber();
  const p = new Decimal(principal).mul(r).div(new Decimal(1).minus(new Decimal(1).plus(r).pow(-n)));
  return p.toDecimalPlaces(2).toNumber();
}

// ── огноо (UTC, YYYY-MM-DD) ──────────────────────────────────────────────────────────────────────
interface Ymd { y: number; m: number; d: number }
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
function parseYmd(s: string, field: string): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  if (!match || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new ScheduleError('INVALID_DATE', `${field}: YYYY-MM-DD огноо байх ёстой`);
  return { y, m, d };
}
const fmt = ({ y, m, d }: Ymd): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const epochDay = ({ y, m, d }: Ymd): number => Date.UTC(y, m - 1, d) / 86_400_000;
/** Нэрлэсэн огноо: сарыг шилжүүлж, өдрийг хэвээр (31 гэх мэт) үлдээнэ — 30/360-д тогтмол 30 хоног өгнө. */
function addMonthsNominal(base: Ymd, months: number): Ymd {
  const t = base.y * 12 + (base.m - 1) + months;
  return { y: Math.floor(t / 12), m: (t % 12) + 1, d: base.d };
}
/** Бодит огноо: сар богино бол сарын сүүлийн өдөр. */
const clampToMonth = (x: Ymd): Ymd => ({ ...x, d: Math.min(x.d, daysInMonth(x.y, x.m)) });
/** 30/360: өдөр 31 → 30. */
function days360(a: Ymd, b: Ymd): number {
  return 360 * (b.y - a.y) + 30 * (b.m - a.m) + (Math.min(b.d, 30) - Math.min(a.d, 30));
}

function validate(p: ScheduleParams): void {
  if (!Number.isFinite(p.principal) || p.principal <= 0) throw new ScheduleError('INVALID_PRINCIPAL', 'Зээлийн дүн 0-ээс их байх ёстой');
  if (!Number.isFinite(p.annualRate) || p.annualRate < 0 || p.annualRate > 100) throw new ScheduleError('INVALID_RATE', 'Хүү 0–100 хооронд байх ёстой');
  if (!Number.isInteger(p.termMonths) || p.termMonths < 1) throw new ScheduleError('INVALID_TERM', 'Хугацаа 1-ээс их бүхэл сар байх ёстой');
  if (p.type === 'QUARTERLY' && p.termMonths % 3 !== 0) throw new ScheduleError('INVALID_TERM', 'Улирлын төлөлттэй хуваарийн хугацаа 3 сарын үржвэр байх ёстой');
  const grace = p.graceMonths ?? 0;
  if (!Number.isInteger(grace) || grace < 0 || grace >= p.termMonths) throw new ScheduleError('INVALID_GRACE', 'Чөлөөлөх сар 0-ээс хугацаанаас бага бүхэл тоо байх ёстой');
}

/** Төлбөр бүрийн эхний төлбөрөөс хойших сарын зөрүү. Улирлын: 0,3,6…; бусад: 0,1,2… */
const offsets = (p: ScheduleParams): number[] => {
  const step = p.type === 'QUARTERLY' ? 3 : 1;
  return Array.from({ length: p.termMonths / step | 0 }, (_, i) => i * step);
};

/** FR-7.1/7.2: ЭТХ үүсгэх. `seq 0` = олголтын мөр (disbursement=principal, төлбөр 0); `seq 1…` = төлбөрийн мөр. Сүүлийн мөрөнд үлдэгдэл 0. */
export function buildSchedule(p: ScheduleParams): ScheduleRow[] {
  validate(p);
  const start = parseYmd(p.startDate, 'startDate');
  const first = parseYmd(p.firstPaymentDate, 'firstPaymentDate');
  if (epochDay(first) <= epochDay(start)) throw new ScheduleError('FIRST_PAYMENT_BEFORE_START', 'Эхний төлбөрийн огноо олголтын огнооноос хойш байх ёстой');

  const dayCount = p.dayCount ?? '30/360';
  const grace = p.graceMonths ?? 0;
  const principal = money(p.principal);
  const rate = new Decimal(p.annualRate).div(100);
  const offs = offsets(p);
  const graceCount = offs.filter((o) => o < grace).length;
  const amortCount = offs.length - graceCount;
  // Үндсэн төлбөрийн төрөл: ANNUITY — тогтмол нийт төлбөр; EQUAL_PRINCIPAL/QUARTERLY — тэнцүү үндсэн; BULLET — сүүлд нь бүгд.
  const annuity = p.type === 'ANNUITY' ? money(annuityPayment(principal.toNumber(), p.annualRate, amortCount)) : null;
  const equalShare = p.type === 'EQUAL_PRINCIPAL' || p.type === 'QUARTERLY' ? money(principal.div(amortCount)) : null;

  const rows: ScheduleRow[] = [{ seq: 0, dueDate: fmt(start), days: 0, disbursement: principal.toNumber(), principal: 0, interest: 0, total: 0, balance: principal.toNumber() }];
  let balance = principal;
  let prev = start;
  offs.forEach((off, i) => {
    const nominal = addMonthsNominal(first, off);
    const due = clampToMonth(nominal);
    const days = dayCount === '30/360' ? days360(prev, nominal) : epochDay(due) - epochDay(clampToMonth(prev));
    const interest = money(balance.mul(rate).mul(days).div(dayCount === '30/360' ? 360 : 365));
    const isLast = i === offs.length - 1;
    let part = new Decimal(0);
    if (isLast) part = balance;
    else if (i >= graceCount) part = annuity ? Decimal.min(Decimal.max(annuity.minus(interest), 0), balance) : equalShare ? Decimal.min(equalShare, balance) : part;
    balance = balance.minus(part);
    rows.push({ seq: i + 1, dueDate: fmt(due), days, disbursement: 0, principal: part.toNumber(), interest: interest.toNumber(), total: part.plus(interest).toNumber(), balance: balance.toNumber() });
    prev = nominal;
  });
  return rows;
}

/** Нийлбэр, эхний/сүүлийн төлбөрийн огноо (төлбөрийн мөрүүдээс; олголтын мөрийг тооцохгүй). */
export function summarizeSchedule(rows: readonly ScheduleRow[]): ScheduleSummary {
  const pay = rows.filter((r) => r.seq > 0);
  const sum = (f: (r: ScheduleRow) => number): number => pay.reduce((a, r) => a.plus(f(r)), new Decimal(0)).toNumber();
  return {
    installments: pay.length, totalPrincipal: sum((r) => r.principal), totalInterest: sum((r) => r.interest), totalPayment: sum((r) => r.total),
    firstDueDate: pay[0]?.dueDate ?? '', endDate: pay[pay.length - 1]?.dueDate ?? '',
  };
}
