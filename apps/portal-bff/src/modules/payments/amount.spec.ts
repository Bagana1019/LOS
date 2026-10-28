import type { PortalCreatePayment, PortalLoanBalance } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { checkMethodLimit, resolveAmount } from './amount';

const balance = (over: Partial<PortalLoanBalance> = {}): PortalLoanBalance => ({
  loanId: 'l1',
  currency: 'MNT',
  asOf: '2026-10-28T04:00:00.000Z',
  outstandingPrincipal: 5_000_000,
  accruedInterest: 100_000,
  accruedPenalty: 0,
  overdue: { principal: 0, interest: 0, penalty: 0, total: 0, days: 0 },
  nextInstallment: { seq: 3, dueDate: '2026-11-01', principal: 400_000, interest: 100_000, total: 500_000, amountDue: 480_000 },
  payoff: { amount: 5_100_000, validUntil: '2026-10-28' },
  ...over,
});
const body = (amountType: PortalCreatePayment['amountType'], amount?: number): PortalCreatePayment => ({ amountType, method: 'QPAY', ...(amount === undefined ? {} : { amount }) });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return null;
};

describe('resolveAmount', () => {
  it('INSTALLMENT pays the remaining amount due of the oldest unpaid installment', () => {
    expect(resolveAmount(body('INSTALLMENT'), balance())).toBe(480_000);
  });
  it('INSTALLMENT is capped by the payoff amount (last installment with accrual below schedule)', () => {
    expect(resolveAmount(body('INSTALLMENT'), balance({ payoff: { amount: 300_000, validUntil: '2026-10-28' } }))).toBe(300_000);
  });
  it('OVERDUE uses the overdue total, refuses when nothing is overdue', () => {
    expect(resolveAmount(body('OVERDUE'), balance({ overdue: { principal: 800_000, interest: 200_000, penalty: 5_000, total: 1_005_000, days: 12 } }))).toBe(1_005_000);
    expect(code(() => resolveAmount(body('OVERDUE'), balance()))).toBe('NO_OVERDUE');
  });
  it('PAYOFF uses the payoff amount', () => {
    expect(resolveAmount(body('PAYOFF'), balance())).toBe(5_100_000);
  });
  it('CUSTOM accepts up to the payoff amount, never more', () => {
    expect(resolveAmount(body('CUSTOM', 5_100_000), balance())).toBe(5_100_000);
    expect(resolveAmount(body('CUSTOM', 1234.56), balance())).toBe(1234.56);
    expect(code(() => resolveAmount(body('CUSTOM', 5_100_000.01), balance()))).toBe('AMOUNT_OUT_OF_RANGE');
  });
  it('refuses closed or fully paid loans for every type', () => {
    const closed = balance({ payoff: { amount: 0, validUntil: '2026-10-28' }, nextInstallment: null });
    for (const t of ['INSTALLMENT', 'OVERDUE', 'PAYOFF', 'CUSTOM'] as const) {
      expect(code(() => resolveAmount(body(t, t === 'CUSTOM' ? 100 : undefined), closed)), t).toBe('LOAN_NOT_PAYABLE');
    }
    expect(code(() => resolveAmount(body('INSTALLMENT'), balance({ nextInstallment: null })))).toBe('LOAN_NOT_PAYABLE');
  });
});

describe('checkMethodLimit', () => {
  const limits = [{ method: 'QPAY' as const, minAmount: 100, maxAmount: 1000 }];
  it('allows amounts within [min, max] inclusive', () => {
    expect(code(() => checkMethodLimit('QPAY', 100, limits))).toBeNull();
    expect(code(() => checkMethodLimit('QPAY', 1000, limits))).toBeNull();
  });
  it('rejects out-of-range amounts and methods that are not offered', () => {
    expect(code(() => checkMethodLimit('QPAY', 99.99, limits))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(code(() => checkMethodLimit('QPAY', 1000.01, limits))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(code(() => checkMethodLimit('SOCIALPAY', 500, limits))).toBe('METHOD_NOT_AVAILABLE');
  });
});
