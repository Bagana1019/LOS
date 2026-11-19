import { describe, expect, it } from 'vitest';
import { PortalScheduleRow } from '@los/contracts';
import { buildLedger, type LedgerRow } from './portal-ledger';
import { displayName, maskPhone } from './portal-mask';

// PRT-FR-2.1 / 2.2 / 3.1: ЭТХ + allocation-аас үлдэгдэл, хэтрэлт, дараагийн төлөлт, мөрийн төлөв.
const row = (seq: number, dueDate: string, o: Partial<LedgerRow> = {}): LedgerRow => ({
  seq, dueDate, days: 30, principal: 100, interest: 10, total: 110, balance: 300 - seq * 100, paidPrincipal: 0, paidInterest: 0, paidAt: null, ...o,
});

describe('buildLedger', () => {
  const rows = [
    row(1, '2026-09-28', { paidPrincipal: 100, paidInterest: 10, paidAt: '2026-09-27' }), // PAID
    row(2, '2026-10-10', { paidInterest: 10 }), // OVERDUE (partly paid, 18 days)
    row(3, '2026-10-28'), // DUE today
    row(4, '2026-11-27', { paidInterest: 5 }), // PARTIALLY_PAID (not due)
    row(5, '2026-12-27'), // UPCOMING
  ];
  const l = buildLedger(rows, '2026-10-28', { closed: false });

  it('maps every row status per PRT-FR-3.1 and keeps FR-7.2 columns', () => {
    expect(l.rows.map((r) => r.status)).toEqual(['PAID', 'OVERDUE', 'DUE', 'PARTIALLY_PAID', 'UPCOMING']);
    expect(l.rows[0]).toMatchObject({ seq: 1, days: 30, principal: 100, interest: 10, total: 110, balance: 200, paidAmount: 110, paidAt: '2026-09-27' });
    for (const r of l.rows) expect(PortalScheduleRow.safeParse(r).success).toBe(true);
  });

  it('computes overdue principal/interest/days from rows due before today', () => {
    expect(l.overdue).toEqual({ principal: 100, interest: 0, penalty: 0, total: 100, days: 18 });
  });

  it('outstanding principal is unpaid principal of all rows', () => {
    expect(l.outstandingPrincipal).toBe(400);
  });

  it('next installment is the first row with a remaining amount', () => {
    expect(l.nextInstallment).toEqual({ seq: 2, dueDate: '2026-10-10', principal: 100, interest: 10, total: 110, amountDue: 100 });
  });

  it('payoff equals principal + accrued interest + penalty, valid for today only', () => {
    expect(l.accruedInterest).toBe(25);
    expect(l.payoff).toEqual({ amount: 425, validUntil: '2026-10-28' });
    expect(l.payoff.amount).toBe(l.outstandingPrincipal + l.accruedInterest + l.accruedPenalty);
  });

  it('totals sum schedule and paid amounts', () => {
    expect(l.totals).toEqual({ principal: 500, interest: 50, total: 550, paid: 125 });
    expect(l.maturityDate).toBe('2026-12-27');
  });

  it('a fully paid schedule has nothing due', () => {
    const paid = buildLedger([row(1, '2026-09-28', { paidPrincipal: 100, paidInterest: 10 })], '2026-10-28', { closed: false });
    expect(paid.nextInstallment).toBeNull();
    expect(paid.payoff.amount).toBe(0);
    expect(paid.overdue.total).toBe(0);
  });

  it('a CLOSED loan reports zero balance even if the schedule has leftovers (written off)', () => {
    const closed = buildLedger([row(1, '2026-09-28')], '2026-10-28', { closed: true });
    expect(closed).toMatchObject({ outstandingPrincipal: 0, accruedInterest: 0, nextInstallment: null, payoff: { amount: 0 } });
    expect(closed.overdue).toEqual({ principal: 0, interest: 0, penalty: 0, total: 0, days: 0 });
  });

  it('empty schedule → zeros, no maturity', () => {
    const e = buildLedger([], '2026-10-28', { closed: false });
    expect(e).toMatchObject({ outstandingPrincipal: 0, nextInstallment: null, maturityDate: null, rows: [] });
  });

  it('keeps cents exact (no float drift)', () => {
    const r = buildLedger([row(1, '2026-11-01', { principal: 0.1, interest: 0.2, total: 0.3 }), row(2, '2026-12-01', { principal: 0.2, interest: 0.1, total: 0.3 })], '2026-10-28', { closed: false });
    expect(r.payoff.amount).toBe(0.6);
  });
});

describe('masking (PRT-NFR-3)', () => {
  it('shortens the name to "Б. Болд"', () => {
    expect(displayName({ lastName: 'Батболд', firstName: 'Болд' })).toBe('Б. Болд');
    expect(displayName({ lastName: null, firstName: 'Болд' })).toBe('Болд');
    expect(displayName({ lastName: '  ', firstName: 'Болд' })).toBe('Болд');
  });

  it('masks phones and never returns the full number', () => {
    expect(maskPhone('99112233')).toBe('99****33');
    expect(maskPhone('+976 9911-2233')).toBe('99****33');
    expect(maskPhone(null)).toBe('');
    expect(maskPhone('123')).toBe('***');
  });
});
