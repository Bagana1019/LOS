import { describe, expect, it } from 'vitest';
import { PricingQuoteRequest, PricingTierInput, PricingTiersQuery, SavePricingTiersRequest } from './pricing';

const tier = { code: 'A', name: 'Маш сайн', band: 'GREEN', minScore: 800, interestRate: 18, feeRate: 0.005, isDefault: false };
const issuePaths = (r: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) => (r.error?.issues ?? []).map((i) => i.path.join('.'));

describe('PricingTierInput', () => {
  it('accepts a well formed tier', () => { expect(PricingTierInput.parse(tier)).toEqual(tier); });
  it('takes the interest rate as annual percent (0..100) and the fee as a fraction (0..1)', () => {
    expect(PricingTierInput.parse({ ...tier, interestRate: 23.99, feeRate: 0.015 })).toMatchObject({ interestRate: 23.99, feeRate: 0.015 });
    expect(PricingTierInput.safeParse({ ...tier, interestRate: 100, feeRate: 1 }).success).toBe(true);
    for (const bad of [{ interestRate: 100.01 }, { interestRate: -0.1 }, { feeRate: 1.5 }, { feeRate: 1.01 }, { feeRate: -0.01 }, { interestRate: NaN }]) expect(PricingTierInput.safeParse({ ...tier, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
  it('rejects more than 4 decimals but snaps floating point noise onto the 4-decimal grid', () => {
    expect(PricingTierInput.safeParse({ ...tier, interestRate: 23.12345 }).success).toBe(false);
    expect(PricingTierInput.safeParse({ ...tier, feeRate: 0.12345 }).success).toBe(false);
    expect(PricingTierInput.parse({ ...tier, interestRate: 0.1 + 0.2 }).interestRate).toBe(0.3);
    expect(PricingTierInput.parse({ ...tier, interestRate: 99.9999 }).interestRate).toBe(99.9999);
    expect(PricingTierInput.parse({ ...tier, feeRate: 0.0575 }).feeRate).toBe(0.0575);
    expect(PricingTierInput.parse({ ...tier, interestRate: 5e-11 }).interestRate).toBe(0);
  });
  it('validates code, band, score range and text', () => {
    for (const bad of [{ code: 'a-1' }, { code: '' }, { code: 'X'.repeat(17) }, { band: 'BLUE' }, { minScore: -1 }, { minScore: 1001 }, { minScore: 10.5 }, { name: '' }, { name: 'x'.repeat(65) }, { name: 'a\u0000b' }, { name: 'a\ud800b' }, { isDefault: 'yes' }]) expect(PricingTierInput.safeParse({ ...tier, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(PricingTierInput.safeParse({ ...tier, name: 'Өндөр эрсдэл 🔴' }).success).toBe(true);
  });
});

describe('SavePricingTiersRequest', () => {
  it('defaults productId to null (org-wide set) and limits the set to 1..10 tiers', () => {
    expect(SavePricingTiersRequest.parse({ tiers: [tier] }).productId).toBeNull();
    expect(SavePricingTiersRequest.safeParse({ tiers: [] }).success).toBe(false);
    expect(SavePricingTiersRequest.safeParse({ tiers: Array.from({ length: 11 }, (_, i) => ({ ...tier, code: `T${i}` })) }).success).toBe(false);
    expect(issuePaths(SavePricingTiersRequest.safeParse({ productId: '', tiers: [tier] }))).toEqual(['productId']);
  });
});

describe('PricingQuoteRequest', () => {
  const ok = { productId: 'consumer', soscoScore: 700 };
  it('accepts score 0..1000 and null (score not available yet)', () => {
    for (const soscoScore of [0, 1000, 512.5, null]) expect(PricingQuoteRequest.safeParse({ ...ok, soscoScore }).success).toBe(true);
    for (const soscoScore of [-0.1, 1000.1, '700', undefined]) expect(PricingQuoteRequest.safeParse({ ...ok, soscoScore }).success).toBe(false);
  });
  it('requires a finite, positive, bounded amount (JSON 1e999 parses to Infinity)', () => {
    expect(PricingQuoteRequest.safeParse({ ...ok, amount: 30_000_000 }).success).toBe(true);
    for (const amount of [0, -1, Infinity, JSON.parse('1e999'), 1e14, NaN]) expect(issuePaths(PricingQuoteRequest.safeParse({ ...ok, amount }))).toEqual(['amount']);
  });
  it('requires a safe productId', () => {
    for (const productId of ['', undefined, 'a\u0000b', 'x'.repeat(65), 5]) expect(PricingQuoteRequest.safeParse({ ...ok, productId }).success).toBe(false);
  });
});

describe('PricingTiersQuery', () => {
  it('treats an empty productId as absent and rejects arrays / objects from the query string', () => {
    expect(PricingTiersQuery.parse({}).productId).toBeUndefined();
    expect(PricingTiersQuery.parse({ productId: '' }).productId).toBeUndefined();
    expect(PricingTiersQuery.parse({ productId: 'consumer' }).productId).toBe('consumer');
    for (const productId of [['a', 'b'], { x: 'b' }, 'a\u0000b']) expect(PricingTiersQuery.safeParse({ productId }).success).toBe(false);
  });
});
