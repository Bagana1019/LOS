import { describe, expect, it } from 'vitest';
import { dti, dtiIncome, weightedIncome, type CategoryTotal } from './dti';
import { checkLtv, collateralValue, ltv, totalCollateralValue } from './ltv';

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
    // хагас цент: бодит хагас дээрээ дээш бөөрөнхийлнө (float-оор .84/.17 гарч байсан)
    expect(collateralValue(12_345_678.35, 0.7)).toBe(8_641_974.85);
    expect(collateralValue(45_000_000.25, 0.7)).toBe(31_500_000.18);
  });
  it('LTV = loan / total collateral value; unbounded without collateral', () => {
    expect(ltv(35_000_000, 70_000_000)).toBe(0.5);
    expect(ltv(1, 0)).toBe(Infinity);
  });
});

describe('LTV check for the collateral gate (FR-14.4, G0)', () => {
  it('sums only valued, positive collateral values', () => {
    expect(totalCollateralValue([21_000_000, null, undefined, NaN, -5, 0, 4_000_000.555])).toBe(25_000_000.56);
    expect(totalCollateralValue([])).toBe(0);
  });
  it('docs/04 M6 AC: 50M loan against 21M collateral is 238% and fails the 70% limit', () => {
    const r = checkLtv(50_000_000, [collateralValue(30_000_000, 0.7)], 0.7);
    expect(r.totalCollateralValue).toBe(21_000_000);
    expect(r.ltv).toBeCloseTo(2.38095, 4);
    expect(r.pass).toBe(false);
  });
  it('passes at or below the limit', () => {
    expect(checkLtv(14_700_000, [21_000_000], 0.7)).toEqual({ ltv: 0.7, limit: 0.7, pass: true, totalCollateralValue: 21_000_000 });
    expect(checkLtv(10_000_000, [21_000_000, 9_000_000], 0.7).pass).toBe(true);
  });
  it('cannot be checked without a loan amount', () => {
    for (const amount of [null, undefined, NaN, Infinity, -1]) expect(checkLtv(amount, [21_000_000], 0.7)).toEqual({ ltv: null, limit: 0.7, pass: null, totalCollateralValue: 21_000_000 });
  });
  it('without any collateral value a positive loan fails with a null ratio; a zero loan passes', () => {
    expect(checkLtv(1_000_000, [null], 0.7)).toEqual({ ltv: null, limit: 0.7, pass: false, totalCollateralValue: 0 });
    expect(checkLtv(0, [], 0.7).pass).toBe(true);
  });
});
