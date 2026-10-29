import { describe, it, expect } from 'vitest';
import { annuityPayment } from './schedule';
import { findTier, quoteRiskPricing, validateTierSet, RiskPricingError, type RiskPricingTier } from './risk-pricing';

// DEMO-ийн жишээ шатлал (бодит утга admin-аас)
const TIERS: RiskPricingTier[] = [
  { code: 'A', name: 'Маш сайн', band: 'GREEN', minScore: 800, interestRate: 18, feeRate: 0.005, isDefault: false },
  { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650, interestRate: 22, feeRate: 0.01, isDefault: false },
  { code: 'C', name: 'Дунд', band: 'YELLOW', minScore: 500, interestRate: 28, feeRate: 0.015, isDefault: true },
  { code: 'D', name: 'Эрсдэлтэй', band: 'RED', minScore: 350, interestRate: 34, feeRate: 0.02, isDefault: false },
  { code: 'E', name: 'Өндөр эрсдэлтэй', band: 'RED', minScore: 0, interestRate: 42, feeRate: 0.03, isDefault: false },
];
const BOUNDS = { minRate: 18, maxRate: 42 };

const errorCode = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as RiskPricingError).code; } return undefined; };

describe('findTier', () => {
  it('picks the tier whose minScore is the highest one not above the score', () => {
    expect(findTier(900, TIERS).code).toBe('A');
    expect(findTier(700, TIERS).code).toBe('B');
    expect(findTier(520, TIERS).code).toBe('C');
    expect(findTier(400, TIERS).code).toBe('D');
    expect(findTier(10, TIERS).code).toBe('E');
  });
  it('treats minScore as an inclusive lower bound and covers fractional scores without gaps', () => {
    expect(findTier(800, TIERS).code).toBe('A');
    expect(findTier(799.99, TIERS).code).toBe('B');
    expect(findTier(0, TIERS).code).toBe('E');
    expect(findTier(1000, TIERS).code).toBe('A');
  });
  it('does not depend on the order tiers are given in and does not mutate them', () => {
    const shuffled = [TIERS[2], TIERS[4], TIERS[0], TIERS[3], TIERS[1]];
    const copy = [...shuffled];
    expect(findTier(655, shuffled).code).toBe('B');
    expect(shuffled).toEqual(copy);
  });
  it.each([-1, 1000.01, NaN, Infinity])('rejects out of range score %s', (score) => {
    expect(errorCode(() => findTier(score, TIERS))).toBe('INVALID_SCORE');
  });
  it('fails when no tier starts at 0 and the score is below every tier', () => {
    expect(errorCode(() => findTier(100, TIERS.slice(0, 3)))).toBe('NO_MATCHING_TIER');
  });
});

describe('quoteRiskPricing', () => {
  it('green score gets lower rate and fee than red score (FR-5.5)', () => {
    const green = quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: BOUNDS });
    const red = quoteRiskPricing({ soscoScore: 200, tiers: TIERS, bounds: BOUNDS });
    expect(green).toMatchObject({ basis: 'SCORE', soscoScore: 850, tier: { code: 'A', band: 'GREEN', minScore: 800 }, interestRate: 18, feeRate: 0.005, rateBound: null });
    expect(red).toMatchObject({ tier: { code: 'E', band: 'RED' }, interestRate: 42, feeRate: 0.03, rateBound: null });
    expect(green.interestRate).toBeLessThan(red.interestRate);
    expect(green.feeRate).toBeLessThan(red.feeRate);
  });
  it('uses the default tier when Sosco Score is not available yet', () => {
    expect(quoteRiskPricing({ soscoScore: null, tiers: TIERS, bounds: BOUNDS })).toMatchObject({ basis: 'DEFAULT_TIER', soscoScore: null, tier: { code: 'C', band: 'YELLOW' }, interestRate: 28, feeRate: 0.015 });
  });
  it('clamps the tier rate into the product bounds and reports which side (BR-6)', () => {
    const narrow = { minRate: 20, maxRate: 36 };
    expect(quoteRiskPricing({ soscoScore: 900, tiers: TIERS, bounds: narrow })).toMatchObject({ tierInterestRate: 18, interestRate: 20, rateBound: 'MIN' });
    expect(quoteRiskPricing({ soscoScore: 0, tiers: TIERS, bounds: narrow })).toMatchObject({ tierInterestRate: 42, interestRate: 36, rateBound: 'MAX' });
    expect(quoteRiskPricing({ soscoScore: 700, tiers: TIERS, bounds: narrow })).toMatchObject({ interestRate: 22, rateBound: null });
  });
  it('does not clamp a rate that sits exactly on a bound', () => {
    expect(quoteRiskPricing({ soscoScore: 900, tiers: TIERS, bounds: BOUNDS }).rateBound).toBeNull();
    expect(quoteRiskPricing({ soscoScore: 0, tiers: TIERS, bounds: BOUNDS }).rateBound).toBeNull();
  });
  it('accepts legitimate bounds: a fixed-rate product (min = max) and a product without a minimum', () => {
    expect(quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: { minRate: 30, maxRate: 30 } })).toMatchObject({ interestRate: 30, rateBound: 'MIN' });
    expect(quoteRiskPricing({ soscoScore: 10, tiers: TIERS, bounds: { minRate: 30, maxRate: 30 } })).toMatchObject({ interestRate: 30, rateBound: 'MAX' });
    expect(quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: { minRate: 0, maxRate: 42 } })).toMatchObject({ interestRate: 18, rateBound: null });
  });
  it('returns the rate in annual percent — usable by annuityPayment as it is (docs/04 M07 AC: 30,000,000 @ 23.99% / 36 ≈ 1,176,828)', () => {
    const q = quoteRiskPricing({ soscoScore: 500, tiers: [{ ...TIERS[2], minScore: 0, interestRate: 23.99 }], bounds: { minRate: 18, maxRate: 42 } });
    expect(q.interestRate).toBe(23.99);
    expect(Math.abs(annuityPayment(30_000_000, q.interestRate, 36) - 1_176_828)).toBeLessThan(2);
  });
  it('rounds the fee half up on an exact tie (12,345 × 0.5% = 61.725 → 61.73)', () => {
    expect(quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: BOUNDS, amount: 12_345 }).feeAmount).toBe(61.73);
  });
  it('computes the one-off fee amount rounded to 2 decimals when an amount is given', () => {
    expect(quoteRiskPricing({ soscoScore: 200, tiers: TIERS, bounds: BOUNDS, amount: 30_000_000 }).feeAmount).toBe(900_000);
    expect(quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: BOUNDS, amount: 1_234_567.89 }).feeAmount).toBe(6172.84);
    expect(quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: BOUNDS, amount: null }).feeAmount).toBeNull();
    expect(quoteRiskPricing({ soscoScore: 850, tiers: TIERS, bounds: BOUNDS }).feeAmount).toBeNull();
  });
  it('rejects empty tier sets, missing default tier and invalid bounds', () => {
    expect(errorCode(() => quoteRiskPricing({ soscoScore: 500, tiers: [], bounds: BOUNDS }))).toBe('NO_TIERS');
    expect(errorCode(() => quoteRiskPricing({ soscoScore: null, tiers: TIERS.map((t) => ({ ...t, isDefault: false })), bounds: BOUNDS }))).toBe('NO_DEFAULT_TIER');
    expect(errorCode(() => quoteRiskPricing({ soscoScore: 500, tiers: TIERS, bounds: { minRate: 40, maxRate: 20 } }))).toBe('INVALID_BOUNDS');
    expect(errorCode(() => quoteRiskPricing({ soscoScore: 500, tiers: TIERS, bounds: { minRate: -10, maxRate: 20 } }))).toBe('INVALID_BOUNDS');
    expect(errorCode(() => quoteRiskPricing({ soscoScore: 5000, tiers: TIERS, bounds: BOUNDS }))).toBe('INVALID_SCORE');
  });
});

describe('validateTierSet', () => {
  const codes = (tiers: RiskPricingTier[]) => validateTierSet(tiers).map((i) => i.code);
  it('accepts a well formed set', () => { expect(validateTierSet(TIERS)).toEqual([]); });
  it('treats equal rates as valid (rates may stay flat between neighbours)', () => {
    expect(validateTierSet(TIERS.map((t) => ({ ...t, interestRate: 30, feeRate: 0.01 })))).toEqual([]);
  });
  it('accepts a single catch-all default tier and equal rates between neighbours', () => {
    expect(validateTierSet([{ ...TIERS[2], minScore: 0 }])).toEqual([]);
    expect(validateTierSet([{ ...TIERS[1], isDefault: true }, { ...TIERS[4], interestRate: 22, feeRate: 0.01 }])).toEqual([]);
  });
  it('rejects an empty set', () => { expect(validateTierSet([])).toEqual([{ code: 'EMPTY', tiers: [] }]); });
  it('requires the lowest tier to start at 0 so every score is priced', () => {
    expect(validateTierSet(TIERS.slice(0, 4))).toEqual([{ code: 'FIRST_TIER_NOT_ZERO', tiers: ['D'] }]);
  });
  it('requires exactly one default tier', () => {
    expect(validateTierSet(TIERS.map((t) => ({ ...t, isDefault: false })))).toEqual([{ code: 'DEFAULT_TIER_COUNT', tiers: [] }]);
    expect(validateTierSet(TIERS.map((t) => ({ ...t, isDefault: t.code === 'A' || t.code === 'E' })))).toEqual([{ code: 'DEFAULT_TIER_COUNT', tiers: ['E', 'A'] }]);
  });
  it('rejects duplicate codes (reported once) and duplicate minScore', () => {
    const dupCode = [...TIERS, { ...TIERS[0], minScore: 900 }, { ...TIERS[0], minScore: 950, interestRate: 18 }].sort((a, b) => a.minScore - b.minScore);
    expect(validateTierSet(dupCode).filter((i) => i.code === 'DUPLICATE_CODE')).toEqual([{ code: 'DUPLICATE_CODE', tiers: ['A'] }]);
    expect(validateTierSet([...TIERS, { ...TIERS[1], code: 'B2' }]).find((i) => i.code === 'DUPLICATE_MIN_SCORE')).toEqual({ code: 'DUPLICATE_MIN_SCORE', tiers: ['B', 'B2'] });
  });
  it('rejects a higher score that is priced above a lower score', () => {
    const rateInverted = TIERS.map((t) => (t.code === 'A' ? { ...t, interestRate: 25 } : t));
    expect(validateTierSet(rateInverted)).toEqual([{ code: 'INTEREST_RATE_NOT_MONOTONIC', tiers: ['B', 'A'] }]);
    const feeInverted = TIERS.map((t) => (t.code === 'D' ? { ...t, feeRate: 0.05 } : t));
    expect(codes(feeInverted)).toEqual(['FEE_RATE_NOT_MONOTONIC']);
    expect(validateTierSet(feeInverted)[0].tiers).toEqual(['E', 'D']);
  });
  it('does not depend on input order', () => {
    expect(validateTierSet([...TIERS].reverse())).toEqual([]);
  });
});
