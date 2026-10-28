import Decimal from 'decimal.js';
// FR-7: ЭТХ. I/O-гүй, 100% unit test. Хоног тооцох арга: setting (30/360 эсвэл actual/365) — параметрээр ирнэ.
export interface ScheduleParams { principal: number; annualRate: number; termMonths: number; type: 'ANNUITY'|'EQUAL_PRINCIPAL'|'QUARTERLY'|'BULLET'; startDate: string; firstPaymentDate: string; graceMonths?: number; dayCount?: '30/360'|'ACT/365'; }
export interface ScheduleRow { seq: number; dueDate: string; days: number; principal: number; interest: number; total: number; balance: number; }
export function annuityPayment(principal: number, annualRate: number, n: number): number {
  const r = new Decimal(annualRate).div(100).div(12); if (r.isZero()) return new Decimal(principal).div(n).toNumber();
  const p = new Decimal(principal).mul(r).div(new Decimal(1).minus(new Decimal(1).plus(r).pow(-n)));
  return p.toDecimalPlaces(2).toNumber();
}
export function buildSchedule(_p: ScheduleParams): ScheduleRow[] {
  throw new Error('TODO(M07): implement per FR-7.1 — see docs/04-build-plan.md Модуль 7 AC');
}
