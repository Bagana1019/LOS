import { describe, expect, it } from 'vitest';
import { PlanCreate, Rate, RateInput, MerchantCreate, PosPolicy, POS_POLICY_DEFAULTS } from './merchant';

// Оролтын хувь DB-ийн numeric(7,4)-тэй нийцнэ (4 орон); хариуны Rate нь тооцоолсон утга (жишээ 1/3) хүлээн авна.
describe('RateInput', () => {
  it('accepts up to four decimals within [0, 1]', () => {
    for (const v of [0, 0.2399, 0.0001, 0.55, 1]) expect(RateInput.safeParse(v).success).toBe(true);
  });
  it('rejects more than four decimals and out-of-range values', () => {
    for (const v of [0.23991, 0.00001, 1 / 3, -0.0001, 1.0001, Number.NaN, Infinity]) expect(RateInput.safeParse(v).success).toBe(false);
  });
  it('the output Rate stays lenient so computed ratios still parse', () => {
    expect(Rate.safeParse(1 / 3).success).toBe(true);
  });
  it('is enforced by the input DTOs and the policy', () => {
    expect(PosPolicy.safeParse({ ...POS_POLICY_DEFAULTS, maxDti: 0.55555 }).success).toBe(false);
    expect(PosPolicy.safeParse({ ...POS_POLICY_DEFAULTS }).success).toBe(true);
    const plan = PlanCreate.safeParse({
      code: 'PLAN1', name: 'x', goodsCategories: ['COMPUTER'], minAmount: 100_000, maxAmount: 5_000_000, termOptions: [6, 12], annualRate: 0.23999, feeRate: 0.01,
    });
    expect(plan.success).toBe(false);
    expect(MerchantCreate.shape.commissionRate.safeParse(0.0123).success).toBe(true);
    expect(MerchantCreate.shape.commissionRate.safeParse(0.01234).success).toBe(false);
  });
});
