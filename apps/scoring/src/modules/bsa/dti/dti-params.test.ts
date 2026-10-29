// toDtiParams: BsaSettings → BsaDtiParams (бизнесийн утга settings-ээс, hardcode байхгүй).
import { describe, expect, it } from 'vitest';
import { toDtiParams } from './dti-params';
import { TEST_SETTINGS } from './testing/fixtures';

describe('toDtiParams', () => {
  const run = { periodFrom: '2026-03-10', periodTo: '2026-09-10', proposedMonthlyPayment: 500_000 };

  it('takes every business value from the settings', () => {
    expect(toDtiParams(TEST_SETTINGS, run)).toEqual({
      periodFrom: '2026-03-10', periodTo: '2026-09-10', proposedMonthlyPayment: 500_000, costOfGoodsRate: 0.1, maxDti: 0.55,
      levelThresholds: { lowMax: 0.35, mediumMax: 0.55 }, businessIncomeCodes: ['BUSINESS_INCOME'],
      irregularIncomeCodes: ['IRREGULAR_INCOME', 'ABNORMAL_INCOME', 'SUSPICIOUS_INCOME'], reliabilityWeights: { frequency: 0.4, consistency: 0.4, cleanliness: 0.2 },
    });
  });

  it('a product-level cost-of-goods rate overrides the setting (BSA-BR-1), including 0', () => {
    expect(toDtiParams(TEST_SETTINGS, { ...run, costOfGoodsRate: 0.25 }).costOfGoodsRate).toBe(0.25);
    expect(toDtiParams(TEST_SETTINGS, { ...run, costOfGoodsRate: 0 }).costOfGoodsRate).toBe(0);
  });

  it('copies arrays and objects (later edits of the result do not touch the settings)', () => {
    const p = toDtiParams(TEST_SETTINGS, run);
    p.businessIncomeCodes.push('X');
    p.levelThresholds.lowMax = 9;
    p.reliabilityWeights.frequency = 9;
    expect(TEST_SETTINGS.businessIncomeCodes).toEqual(['BUSINESS_INCOME']);
    expect(TEST_SETTINGS.dtiLevelThresholds.lowMax).toBe(0.35);
    expect(TEST_SETTINGS.reliabilityWeights.frequency).toBe(0.4);
  });
});
