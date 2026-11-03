import { describe, expect, it } from 'vitest';
import { checkLimits, planTermsSteps, scheduleOutdated, termsChanged, type TermsCore } from './loan-terms.rules';

const limits = { minAmount: 100_000, maxAmount: 50_000_000, minTermMonths: 1, maxTermMonths: 36, minRate: 18, maxRate: 42, defaultFeeRate: 0.01 };
const core: TermsCore = { productId: 'p', currency: 'MNT', amount: 1_000_000, termMonths: 12, interestRate: 24, feeRate: 0.01 };

describe('checkLimits (FR-5.1)', () => {
  it('багтвал хоосон', () => expect(checkLimits({ amount: 1_000_000, termMonths: 36, interestRate: 18 }, limits)).toEqual([]));
  it('AC: 60 сар → termMonths зөрчил', () => expect(checkLimits({ amount: 1_000_000, termMonths: 60, interestRate: 24 }, limits)).toEqual([{ field: 'termMonths', value: 60, min: 1, max: 36 }]));
  it('бүх талбарын зөрчил', () => expect(checkLimits({ amount: 1, termMonths: 0, interestRate: 50 }, limits).map((v) => v.field)).toEqual(['amount', 'termMonths', 'interestRate']));
});

describe('termsChanged (FR-7.3)', () => {
  it('ижил бол false', () => expect(termsChanged(core, { ...core })).toBe(false));
  it.each([['productId', 'q'], ['currency', 'USD'], ['amount', 2_000_000], ['termMonths', 24], ['interestRate', 30], ['feeRate', 0.02]] as const)('%s өөрчлөгдвөл true', (k, v) => expect(termsChanged(core, { ...core, [k]: v })).toBe(true));
});

describe('planTermsSteps', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const steps = (loan: string, inst: string) => [{ id: 'l', stepKey: 'loan', status: loan }, { id: 'i', stepKey: 'installment', status: inst }, { id: 'x', stepKey: 'score', status: 'COMPLETED' }];
  it('loan PENDING → COMPLETED', () => expect(planTermsSteps(steps('PENDING', 'PENDING'), false, now)).toEqual([{ id: 'l', stepKey: 'loan', status: 'COMPLETED', staleReason: null, completedAt: now }]));
  it('AC: өөрчлөлт + installment COMPLETED → STALE', () => expect(planTermsSteps(steps('COMPLETED', 'COMPLETED'), true, now)).toEqual([{ id: 'i', stepKey: 'installment', status: 'STALE', staleReason: 'LOAN_TERMS_CHANGED' }]));
  it('өөрчлөлтгүй бол installment-д хүрэхгүй; loan COMPLETED бол алгасна', () => expect(planTermsSteps(steps('COMPLETED', 'COMPLETED'), false, now)).toEqual([]));
  it('PENDING/LOCKED installment-ийг STALE болгохгүй', () => {
    expect(planTermsSteps(steps('COMPLETED', 'PENDING'), true, now)).toEqual([]);
    expect(planTermsSteps(steps('LOCKED', 'LOCKED'), true, now)).toEqual([]);
  });
  it('алхам байхгүй бол хоосон', () => expect(planTermsSteps([], true, now)).toEqual([]));
});

describe('scheduleOutdated', () => {
  const saved = { principal: 1_000_000, annualRate: 24, termMonths: 12 };
  it('ижил', () => expect(scheduleOutdated(saved, { amount: 1_000_000, interestRate: 24, termMonths: 12 })).toBe(false));
  it.each([[{ amount: 2, interestRate: 24, termMonths: 12 }], [{ amount: 1_000_000, interestRate: 25, termMonths: 12 }], [{ amount: 1_000_000, interestRate: 24, termMonths: 6 }], [{ amount: null, interestRate: null, termMonths: null }]])('%j зөрвөл true', (c) => expect(scheduleOutdated(saved, c)).toBe(true));
});
