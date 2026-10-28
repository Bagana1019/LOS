import { describe, expect, it } from 'vitest';
import { dti, dtiIncome, weightedIncome, type CategoryTotal } from './dti';
import { collateralValue, ltv } from './ltv';

const cat = (code: string, monthlyAvg: number, weight: number, dtiRole: CategoryTotal['dtiRole']): CategoryTotal => ({ code, monthlyAvg, weight, dtiRole });

describe('DTI (docs/02 §4)', () => {
  it('weights only INCOME categories', () => {
    expect(weightedIncome([cat('SALES', 10_000_000, 0.8, 'INCOME'), cat('RENT', 1_000_000, 0.5, 'INCOME'), cat('FOOD', 2_000_000, 1, 'HOUSEHOLD'), cat('TRANSFER', 5_000_000, 1, 'EXCLUDE')])).toBe(8_500_000);
    expect(weightedIncome([])).toBe(0);
  });
  it('deducts the cost of goods from the weighted income', () => {
    expect(dtiIncome(8_000_000, 0.1)).toBeCloseTo(7_200_000);
    expect(dtiIncome(8_000_000, 0)).toBe(8_000_000);
  });
  it('DTI = (proposed payment + existing debt service) / income', () => {
    expect(dti(1_000_000, 500_000, 3_000_000)).toBe(0.5);
  });
  it('is unbounded when there is no income', () => {
    expect(dti(1, 0, 0)).toBe(Infinity);
    expect(dti(1, 0, -5)).toBe(Infinity);
  });
});

describe('collateral value and LTV (FR-14.2, FR-14.4)', () => {
  it('collateral value = market value × haircut, rounded to 2 decimals', () => {
    expect(collateralValue(100_000_000, 0.7)).toBe(70_000_000);
    expect(collateralValue(12_345.67, 0.333)).toBe(4_111.11);
  });
  it('LTV = loan / total collateral value; unbounded without collateral', () => {
    expect(ltv(35_000_000, 70_000_000)).toBe(0.5);
    expect(ltv(1, 0)).toBe(Infinity);
  });
});
