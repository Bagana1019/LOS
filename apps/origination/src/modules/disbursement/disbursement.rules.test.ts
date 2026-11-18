import { describe, expect, it } from 'vitest';
import { amountWithinApproved, evaluateGate, isNotFoundDefinitive, maskAccount, parseSettleSeconds, reconcile, recordNotFound, type CoreSettlePolicy, type NotFoundEvidence, type GateInput } from './disbursement.rules';

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

// H1: "Core-д олдсонгүй" нь тодорхойгүй үр дүнгийн дараа зөвхөн settle цонх + N зайтай лавлагааны дараа л баталгаатай.
describe('H1 settle rule (isNotFoundDefinitive / recordNotFound)', () => {
  const P: CoreSettlePolicy = { settleMs: 900_000, minLookups: 2, lookupSpacingMs: 120_000 };
  const T0 = new Date('2026-11-18T00:00:00Z');
  const at = (s: number) => new Date(T0.getTime() + s * 1000);
  const ev = (o: Partial<NotFoundEvidence> = {}): NotFoundEvidence => ({ unknownAt: T0, notFoundCount: 0, lastNotFoundAt: null, ...o });

  it.each<[string, NotFoundEvidence, number, boolean]>([
    ['never had an unknown outcome → definitive at once', ev({ unknownAt: null }), 0, true],
    ['right after the unknown outcome', ev(), 1, false],
    ['window not elapsed even with N lookups', ev({ notFoundCount: 5 }), 899, false],
    ['window elapsed, 0 lookups', ev(), 900, false],
    ['window elapsed, N-1 lookups', ev({ notFoundCount: 1 }), 5_000, false],
    ['window elapsed exactly, N lookups (boundary)', ev({ notFoundCount: 2 }), 900, true],
    ['window elapsed, more than N lookups', ev({ notFoundCount: 3 }), 10_000, true],
  ])('%s', (_n, e, sec, want) => expect(isNotFoundDefinitive(e, at(sec), P)).toBe(want));

  it('does not count lookups inside the settle window', () => {
    expect(recordNotFound(ev(), at(899), P)).toEqual(ev());
  });
  it('counts a post-window lookup and stamps it (immutable input)', () => {
    const before = ev();
    const after = recordNotFound(before, at(900), P);
    expect(after).toEqual(ev({ notFoundCount: 1, lastNotFoundAt: at(900) }));
    expect(before.notFoundCount).toBe(0);
  });
  it('does not count lookups closer than the spacing (no burst of rejects/reconciles)', () => {
    const one = recordNotFound(ev(), at(900), P);
    expect(recordNotFound(one, at(1019), P)).toEqual(one);
    expect(recordNotFound(one, at(1020), P)).toEqual(ev({ notFoundCount: 2, lastNotFoundAt: at(1020) }));
  });
  it('earliest definitive moment = window + (N-1) × spacing', () => {
    let e = ev();
    for (const s of [100, 900, 1000, 1020]) e = recordNotFound(e, at(s), P);
    expect(e.notFoundCount).toBe(2);
    expect(isNotFoundDefinitive(e, at(1020), P)).toBe(true);
  });
  it('rows without an unknown outcome are left untouched', () => {
    const e = ev({ unknownAt: null });
    expect(recordNotFound(e, at(10_000), P)).toBe(e);
  });
  it.each<[string | undefined, number]>([
    [undefined, 900], ['', 900], ['abc', 900], ['-5', 900], ['0', 120], ['60', 120], ['1800', 1800], ['999999', 86_400],
  ])('DISBURSEMENT_CORE_SETTLE_SECONDS=%s → %i', (raw, want) => expect(parseSettleSeconds(raw)).toBe(want));
});
