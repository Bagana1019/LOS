// Орж ирсэн төлбөрийг ЭТХ-ийн мөрүүдэд хуваарилах (FR-7, эргэн төлөлт). Цэвэр функц, Decimal, 2 орон.
// Дүрэм (DECISIONS.md 2026-10-28): хугацаа нь хамгийн эрт (dueDate, seq) мөрөөс эхэлнэ; мөр доторх дараалал — хүү, дараа нь үндсэн зээл;
// бүх мөр бүрэн төлөгдсөний дараах илүү дүн `unallocated` (урьдчилсан төлөлт — Core-д шийдэгдэнэ).
import Decimal from 'decimal.js';
import type { InstallmentStatus } from '@los/contracts';
import { daysPastDue } from './aging';

export interface AllocatableInstallment {
  id: string; seq: number; dueDate: string; // YYYY-MM-DD
  interest: number; principal: number; paidInterest: number; paidPrincipal: number;
}
export interface AllocationLine { installmentId: string; interestPaid: number; principalPaid: number; totalPaid: number; }
export interface AllocationResult { lines: AllocationLine[]; allocated: number; unallocated: number; }

const d = (n: number) => new Decimal(n);
const ZERO = new Decimal(0);
const dp = (x: Decimal) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function outstandingInterest(i: AllocatableInstallment): number { return Decimal.max(ZERO, dp(d(i.interest).minus(i.paidInterest))).toNumber(); }
export function outstandingPrincipal(i: AllocatableInstallment): number { return Decimal.max(ZERO, dp(d(i.principal).minus(i.paidPrincipal))).toNumber(); }
export function outstandingOf(i: AllocatableInstallment): number { return dp(d(outstandingInterest(i)).plus(outstandingPrincipal(i))).toNumber(); }

const byDueDate = (xs: AllocatableInstallment[]) => [...xs].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.seq - b.seq));

export function allocatePayment(installments: AllocatableInstallment[], amount: number): AllocationResult {
  if (!(amount > 0)) throw new Error('Төлбөрийн дүн эерэг байх ёстой');
  const ordered = byDueDate(installments);
  let remaining = dp(d(amount));
  const lines: AllocationLine[] = [];
  for (const inst of ordered) {
    if (remaining.lte(0)) break;
    const interestPaid = Decimal.min(remaining, outstandingInterest(inst));
    remaining = remaining.minus(interestPaid);
    const principalPaid = Decimal.min(remaining, outstandingPrincipal(inst));
    remaining = remaining.minus(principalPaid);
    const total = interestPaid.plus(principalPaid);
    if (total.gt(0)) lines.push({ installmentId: inst.id, interestPaid: interestPaid.toNumber(), principalPaid: principalPaid.toNumber(), totalPaid: total.toNumber() });
  }
  const unallocated = remaining.toNumber();
  return { lines, allocated: dp(dp(d(amount)).minus(remaining)).toNumber(), unallocated };
}

export interface InstallmentState { status: InstallmentStatus; daysOverdue: number; outstanding: number; paidTotal: number; }

/** UPCOMING (төлөх өдөр болоогүй) · DUE (өнөөдөр) · OVERDUE (хэтэрсэн, үлдэгдэлтэй) · PARTIAL (хэсэгчлэн төлсөн, хэтрээгүй) · PAID. */
export function installmentState(i: AllocatableInstallment, asOf: string): InstallmentState {
  const outstanding = outstandingOf(i);
  const paidTotal = dp(d(i.paidInterest).plus(i.paidPrincipal)).toNumber();
  if (outstanding <= 0) return { status: 'PAID', daysOverdue: 0, outstanding: 0, paidTotal };
  const dpd = daysPastDue(i.dueDate, asOf);
  if (dpd > 0) return { status: 'OVERDUE', daysOverdue: dpd, outstanding, paidTotal };
  if (paidTotal > 0) return { status: 'PARTIAL', daysOverdue: 0, outstanding, paidTotal };
  return { status: i.dueDate === asOf ? 'DUE' : 'UPCOMING', daysOverdue: 0, outstanding, paidTotal };
}

/** "Одоо төлөх" дүн: хугацаа хэтэрсэн + өнөөдөр төлөх ёстой үлдэгдлийн нийлбэр; байхгүй бол дараагийн мөрийн үлдэгдэл; бүгд төлөгдсөн бол 0. */
export function payNowAmount(installments: AllocatableInstallment[], asOf: string): number {
  const ordered = byDueDate(installments);
  const dueNow = ordered.filter((i) => i.dueDate <= asOf).reduce((s, i) => s.plus(outstandingOf(i)), ZERO);
  if (dueNow.gt(0)) return dp(dueNow).toNumber();
  const next = ordered.find((i) => outstandingOf(i) > 0);
  return next ? outstandingOf(next) : 0;
}
