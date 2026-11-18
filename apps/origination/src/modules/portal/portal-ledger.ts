import { installmentState } from '@los/calc';
import type { PortalLoanBalance, PortalNextInstallment, PortalSchedule, PortalScheduleRow, PortalScheduleRowStatus } from '@los/contracts';
import { Prisma } from '.prisma/client-origination';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
const sum = (xs: number[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));
const pos = (d: Decimal) => Decimal.max(d, 0);

/** ЭТХ-ийн мөр (олголтын мөргүй) + payment_allocation-ын нийлбэр. Огноо `YYYY-MM-DD`. */
export interface LedgerRow {
  seq: number; dueDate: string; days: number; principal: number; interest: number; total: number; balance: number;
  paidPrincipal: number; paidInterest: number; paidAt: string | null;
}

export interface Ledger {
  rows: PortalScheduleRow[];
  totals: PortalSchedule['totals'];
  outstandingPrincipal: number;
  accruedInterest: number;
  accruedPenalty: number;
  overdue: PortalLoanBalance['overdue'];
  nextInstallment: PortalNextInstallment | null;
  payoff: PortalLoanBalance['payoff'];
  maturityDate: string | null;
}

const STATUS: Record<ReturnType<typeof installmentState>['status'], PortalScheduleRowStatus> = {
  PAID: 'PAID', OVERDUE: 'OVERDUE', PARTIAL: 'PARTIALLY_PAID', DUE: 'DUE', UPCOMING: 'UPCOMING',
};

const remainingPrincipal = (r: LedgerRow) => pos(new Decimal(r.principal).minus(r.paidPrincipal));
const remainingInterest = (r: LedgerRow) => pos(new Decimal(r.interest).minus(r.paidInterest));
const remaining = (r: LedgerRow) => remainingPrincipal(r).plus(remainingInterest(r));

/**
 * PRT-FR-2.1/2.2/3.1. Мөрийн төлөв `@los/calc` installmentState-ээс (staff ЭТХ-тэй ижил эх сурвалж).
 * Core интеграцигүй (DECISIONS.md H8): хүү хуваарийн дагуу — payoff = үлдсэн үндсэн + хуваарийн үлдсэн хүү (хугацаанаас өмнөх хаалтын
 * хүүгийн хөнгөлөлтгүй), торгууль 0. Тэр нь төлбөрийн хуваарилалт (мөр бүрийн хүү→үндсэн) зээлийг яг хаах дүн.
 * CLOSED зээл: үлдэгдэлгүй гэж харуулна (хуваарьт үлдсэн дүн нь хаалтаар/ хасалтаар цэвэрлэгдсэн).
 */
export function buildLedger(input: LedgerRow[], asOf: string, opts: { closed: boolean }): Ledger {
  const ordered = [...input].sort((a, b) => a.seq - b.seq);
  const states = ordered.map((r) => installmentState({ id: String(r.seq), seq: r.seq, dueDate: r.dueDate, principal: r.principal, interest: r.interest, paidPrincipal: r.paidPrincipal, paidInterest: r.paidInterest }, asOf));
  const rows: PortalScheduleRow[] = ordered.map((r, i) => ({
    seq: r.seq, dueDate: r.dueDate, days: r.days, principal: r.principal, interest: r.interest, total: r.total, balance: r.balance,
    paidAmount: money(new Decimal(r.paidPrincipal).plus(r.paidInterest)), paidAt: r.paidAt, status: STATUS[states[i].status],
  }));
  const totals = {
    principal: money(sum(ordered.map((r) => r.principal))), interest: money(sum(ordered.map((r) => r.interest))),
    total: money(sum(ordered.map((r) => r.total))), paid: money(sum(rows.map((r) => r.paidAmount))),
  };
  const maturityDate = ordered.length ? ordered[ordered.length - 1].dueDate : null;
  const zeroOverdue = { principal: 0, interest: 0, penalty: 0, total: 0, days: 0 };

  if (opts.closed) {
    return { rows, totals, maturityDate, outstandingPrincipal: 0, accruedInterest: 0, accruedPenalty: 0, overdue: zeroOverdue, nextInstallment: null, payoff: { amount: 0, validUntil: asOf } };
  }

  const open = ordered.filter((r) => remaining(r).gt(0));
  const late = open.filter((r) => r.dueDate < asOf);
  const overduePrincipal = sum(late.map((r) => remainingPrincipal(r).toNumber()));
  const overdueInterest = sum(late.map((r) => remainingInterest(r).toNumber()));
  const outstandingPrincipal = sum(open.map((r) => remainingPrincipal(r).toNumber()));
  const accruedInterest = sum(open.map((r) => remainingInterest(r).toNumber()));
  const next = open[0];

  return {
    rows, totals, maturityDate,
    outstandingPrincipal: money(outstandingPrincipal),
    accruedInterest: money(accruedInterest),
    accruedPenalty: 0,
    overdue: {
      principal: money(overduePrincipal), interest: money(overdueInterest), penalty: 0,
      total: money(overduePrincipal.plus(overdueInterest)), days: Math.max(0, ...states.map((s) => s.daysOverdue)),
    },
    nextInstallment: next
      ? { seq: next.seq, dueDate: next.dueDate, principal: next.principal, interest: next.interest, total: next.total, amountDue: money(remaining(next)) }
      : null,
    payoff: { amount: money(outstandingPrincipal.plus(accruedInterest)), validUntil: asOf },
  };
}
