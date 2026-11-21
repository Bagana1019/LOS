import { describe, expect, it } from 'vitest';
import { BsaResolveSuspicionsResponse } from './bsa';

// F6-10 follow-up: the resolve response reports what REALLY changed, so the web never re-derives it from the rows on screen.

const SUMMARY = {
  analysisId: 'a-1', loanApplicationId: 'app-1', borrowerId: 'b-1', status: 'DRAFT', version: 1, periodMonths: 3, periodFrom: '2026-04-01', periodTo: '2026-06-30',
  transactionCount: 12, totalMonthlyIncome: 3_600_000, verifiedMonthlyIncome: 3_600_000, dtiIncome: 3_600_000, businessIncomeMonthly: 0, businessExpenseMonthly: 0,
  netCashFlowMonthly: 1_000_000, existingDebtServiceMonthly: 0, incomeReliability: 80, dtiPercent: 12.5, dtiLevel: 'LOW', pendingSuspiciousCount: 0, reportPdfUrl: null,
};
const OK = { resolved: 2, skipped: 1, pending: 3, changedTransactions: 4, unchangedTransactions: 1, summary: null, repushRequired: false };

describe('BsaResolveSuspicionsResponse', () => {
  it('accepts the server shape and keeps both transaction counts', () => {
    expect(BsaResolveSuspicionsResponse.parse(OK)).toEqual(OK);
  });

  it('accepts a recalculated summary and a re-push flag', () => {
    const body = { ...OK, summary: SUMMARY, repushRequired: true };
    expect(BsaResolveSuspicionsResponse.parse(body)).toEqual(body);
  });

  it.each(['resolved', 'skipped', 'pending', 'changedTransactions', 'unchangedTransactions', 'summary', 'repushRequired'] as const)('requires %s', (field) => {
    const { [field]: _omitted, ...rest } = OK;
    expect(BsaResolveSuspicionsResponse.safeParse(rest).success).toBe(false);
  });

  it('accepts zero counts (approve, or nothing to change)', () => {
    expect(BsaResolveSuspicionsResponse.safeParse({ ...OK, changedTransactions: 0, unchangedTransactions: 0 }).success).toBe(true);
  });

  it.each([-1, 1.5, '2', null])('rejects %j as a transaction count', (bad) => {
    expect(BsaResolveSuspicionsResponse.safeParse({ ...OK, changedTransactions: bad }).success).toBe(false);
    expect(BsaResolveSuspicionsResponse.safeParse({ ...OK, unchangedTransactions: bad }).success).toBe(false);
  });

  it('rejects a body of the old shape (the web must not guess the counts)', () => {
    expect(BsaResolveSuspicionsResponse.safeParse({ resolved: 2, skipped: 1, pending: 3, summary: null, repushRequired: false }).success).toBe(false);
  });
});
