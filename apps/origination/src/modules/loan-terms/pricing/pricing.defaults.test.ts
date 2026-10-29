import { validateTierSet } from '@los/calc';
import { SavePricingTiersRequest } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING_TIERS } from './pricing.defaults';

describe('DEFAULT_PRICING_TIERS (seeded DEMO rate card, FR-5.5)', () => {
  it('is a valid card: starts at 0, one default tier, no rate or fee that rises with the score (BR-14)', () => {
    expect(validateTierSet(DEFAULT_PRICING_TIERS)).toEqual([]);
  });
  it('passes the same request schema the admin API uses (unit ranges, 4 decimals)', () => {
    expect(SavePricingTiersRequest.parse({ tiers: DEFAULT_PRICING_TIERS }).tiers).toEqual(DEFAULT_PRICING_TIERS);
  });
  it('fits the seeded products (BR-6: 18–42 % consumer card), rate in annual percent', () => {
    const rates = DEFAULT_PRICING_TIERS.map((t) => t.interestRate);
    expect([Math.min(...rates), Math.max(...rates)]).toEqual([18, 42]);
  });
});
