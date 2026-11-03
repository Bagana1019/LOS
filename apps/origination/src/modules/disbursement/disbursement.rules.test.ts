import { describe, expect, it } from 'vitest';
import { amountWithinApproved, evaluateGate, maskAccount, reconcile, type GateInput } from './disbursement.rules';

const base: GateInput = {
  applicationStatus: 'APPROVED', disburseAmount: 30_000_000, approvedAmount: 30_000_000, disburseDate: '2026-11-05', contractSigned: true, hasDecision: true, hasLetter: true,
  account: { bankCode: 'KHAN', accountNo: '5012345678', holderName: 'Б Дорж', ownerType: 'SELF' }, nameCheckMatched: true, reconDiffs: [], scheduleCurrent: true,
  requiresCollateral: true, collaterals: [{ registryNo: 'ЭБ-1', releasedAt: null }],
};
const failed = (g: GateInput) => evaluateGate(g).filter((c) => !c.ok).map((c) => c.key);

describe('disbursement rules (BR-10, G4)', () => {
  it('amount must be positive and <= approved', () => {
    expect(amountWithinApproved(30_000_000, 30_000_000)).toBe(true);
    expect(amountWithinApproved(30_000_000.01, 30_000_000)).toBe(false);
    expect(amountWithinApproved(0, 1)).toBe(false);
  });
  it('reconcile lists every differing term', () => {
    const dec = { amount: 30_000_000, termMonths: 36, interestRate: 23.99, repaymentType: 'ANNUITY', firstPaymentDate: '2026-12-05' };
    expect(reconcile(dec, { approvedAmount: 30_000_000, termMonths: 36, interestRate: 23.99, repaymentType: 'ANNUITY', firstPaymentDate: '2026-12-05' })).toEqual([]);
    expect(reconcile(dec, { approvedAmount: 25_000_000, termMonths: 24, interestRate: 23.99, repaymentType: 'BULLET', firstPaymentDate: '2026-12-05' }).map((d) => d.field)).toEqual(['approvedAmount', 'termMonths', 'repaymentType']);
  });
  it('passes when everything is in place', () => expect(failed(base)).toEqual([]));
  it.each<[string, Partial<GateInput>, string]>([
    ['unsigned contract', { contractSigned: false }, 'CONTRACT_SIGNED'],
    ['over approved', { disburseAmount: 31_000_000 }, 'AMOUNT_WITHIN_APPROVED'],
    ['no letter', { hasLetter: false }, 'OFFICIAL_LETTER'],
    ['no decision', { hasDecision: false }, 'DECISION_DOCUMENT'],
    ['name mismatch', { nameCheckMatched: false }, 'ACCOUNT_NAME_CHECK'],
    ['no account', { account: { bankCode: null, accountNo: null, holderName: null, ownerType: null } }, 'ACCOUNT_COMPLETE'],
    ['recon diff', { reconDiffs: [{ field: 'termMonths', decision: 1, disbursement: 2 }] }, 'RECONCILIATION'],
    ['stale schedule', { scheduleCurrent: false }, 'RECONCILIATION'],
    ['collateral not in registry', { collaterals: [{ registryNo: null, releasedAt: null }] }, 'COLLATERAL_REGISTERED'],
    ['collateral required but none', { collaterals: [] }, 'COLLATERAL_REGISTERED'],
    ['wrong status', { applicationStatus: 'IN_APPROVAL' }, 'APPLICATION_APPROVED'],
  ])('blocks on %s', (_n, patch, key) => expect(failed({ ...base, ...patch })).toContain(key));
  it('collateral-free product passes with no collateral', () => expect(failed({ ...base, requiresCollateral: false, collaterals: [] })).toEqual([]));
  it('masks account numbers', () => { expect(maskAccount('5012345678')).toBe('******5678'); expect(maskAccount(null)).toBeNull(); });
});
