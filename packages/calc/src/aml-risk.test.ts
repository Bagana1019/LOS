import { describe, it, expect } from 'vitest';
import type { AmlPolicy } from '@los/contracts';
import { amlRisk, type AmlRiskInput, type AmlRiskPolicy } from './aml-risk';

// calc нь contracts-ийн runtime-д найдахгүй (alias/build байхгүй) тул анхдагч бодлогыг (docs/05 §4) зөвхөн төрлөөр шалгана.
const DEFAULT_RISK: AmlPolicy['risk'] = {
  weights: {
    pep: 25, relatedParty: 10, fatfIncreasedMonitoring: 15, fatfCallForAction: 40,
    internalBlacklist: 20, sanctionsPossible: 60, sanctionsConfirmed: 100,
  },
  mediumFrom: 30,
  highFrom: 60,
};
const accept = (p: AmlPolicy['risk']): AmlRiskPolicy => p;

const none: AmlRiskInput = { isPep: false, isRelatedParty: false, fatfCategory: null, internalBlacklistHit: false, sanctions: 'NONE' };
const run = (over: Partial<AmlRiskInput>, policy: AmlRiskPolicy = accept(DEFAULT_RISK)) => amlRisk({ ...none, ...over }, policy);
const withWeights = (w: Partial<AmlRiskPolicy['weights']>, t: Partial<Pick<AmlRiskPolicy, 'mediumFrom' | 'highFrom'>> = {}): AmlRiskPolicy =>
  ({ ...DEFAULT_RISK, ...t, weights: { ...DEFAULT_RISK.weights, ...w } });

describe('amlRisk scoring (defaults: medium 30, high 60)', () => {
  it('no flags -> 0 LOW with no factors', () => {
    expect(run({})).toEqual({ score: 0, level: 'LOW', factors: [] });
  });

  it.each([
    ['PEP only', { isPep: true }, 25, 'LOW', ['PEP']],
    ['PEP + related party', { isPep: true, isRelatedParty: true }, 35, 'MEDIUM', ['PEP', 'RELATED_PARTY']],
    ['FATF increased monitoring', { fatfCategory: 'INCREASED_MONITORING' }, 15, 'LOW', ['FATF_INCREASED_MONITORING']],
    ['FATF call for action', { fatfCategory: 'CALL_FOR_ACTION' }, 40, 'MEDIUM', ['FATF_CALL_FOR_ACTION']],
    ['internal blacklist', { internalBlacklistHit: true }, 20, 'LOW', ['INTERNAL_BLACKLIST']],
    ['sanctions possible', { sanctions: 'POSSIBLE' }, 60, 'HIGH', ['SANCTIONS_POSSIBLE']],
    ['sanctions confirmed', { sanctions: 'CONFIRMED' }, 100, 'HIGH', ['SANCTIONS_CONFIRMED']],
    ['call for action + blacklist', { fatfCategory: 'CALL_FOR_ACTION', internalBlacklistHit: true }, 60, 'HIGH', ['FATF_CALL_FOR_ACTION', 'INTERNAL_BLACKLIST']],
  ] as const)('%s -> %d %s', (_name, over, score, level, codes) => {
    const r = run(over);
    expect(r.score).toBe(score);
    expect(r.level).toBe(level);
    expect(r.factors.map((f) => f.code)).toEqual(codes);
  });

  it('all flags are capped at 100 but the factors keep their raw weights', () => {
    const r = run({ isPep: true, isRelatedParty: true, fatfCategory: 'CALL_FOR_ACTION', internalBlacklistHit: true, sanctions: 'CONFIRMED' });
    expect(r.score).toBe(100);
    expect(r.level).toBe('HIGH');
    expect(r.factors).toEqual([
      { code: 'PEP', weight: 25 },
      { code: 'RELATED_PARTY', weight: 10 },
      { code: 'FATF_CALL_FOR_ACTION', weight: 40 },
      { code: 'INTERNAL_BLACKLIST', weight: 20 },
      { code: 'SANCTIONS_CONFIRMED', weight: 100 },
    ]);
  });

  it('returns factors in the fixed order regardless of how the input is built', () => {
    const r = amlRisk(
      { sanctions: 'POSSIBLE', internalBlacklistHit: true, fatfCategory: 'INCREASED_MONITORING', isRelatedParty: true, isPep: true },
      accept(DEFAULT_RISK),
    );
    expect(r.factors.map((f) => f.code)).toEqual(['PEP', 'RELATED_PARTY', 'FATF_INCREASED_MONITORING', 'INTERNAL_BLACKLIST', 'SANCTIONS_POSSIBLE']);
  });

  it('a FATF category contributes exactly one factor', () => {
    expect(run({ fatfCategory: 'INCREASED_MONITORING' }).factors).toHaveLength(1);
    expect(run({ fatfCategory: 'CALL_FOR_ACTION' }).factors).toHaveLength(1);
  });

  it('sanctions POSSIBLE and CONFIRMED are mutually exclusive: one factor each', () => {
    expect(run({ sanctions: 'POSSIBLE' }).factors.map((f) => f.code)).toEqual(['SANCTIONS_POSSIBLE']);
    expect(run({ sanctions: 'CONFIRMED' }).factors.map((f) => f.code)).toEqual(['SANCTIONS_CONFIRMED']);
  });

  it('factors do not carry a detail (the engine adds list evidence separately)', () => {
    expect(run({ isPep: true }).factors[0]).toEqual({ code: 'PEP', weight: 25 });
  });
});

describe('amlRisk thresholds and policy-driven values', () => {
  it('level boundaries are inclusive: medium at 30, high at 60', () => {
    const p = withWeights({ pep: 29.99, relatedParty: 30, internalBlacklist: 59.99, fatfCallForAction: 60 });
    expect(run({ isPep: true }, p).level).toBe('LOW');
    expect(run({ isRelatedParty: true }, p).level).toBe('MEDIUM');
    expect(run({ internalBlacklistHit: true }, p).level).toBe('MEDIUM');
    expect(run({ fatfCategory: 'CALL_FOR_ACTION' }, p).level).toBe('HIGH');
  });

  it('uses the weights from the policy, not constants', () => {
    const r = run({ isPep: true, isRelatedParty: true }, withWeights({ pep: 1, relatedParty: 2 }));
    expect(r.score).toBe(3);
    expect(r.factors).toEqual([{ code: 'PEP', weight: 1 }, { code: 'RELATED_PARTY', weight: 2 }]);
  });

  it('rounds the score to 2 decimals', () => {
    expect(run({ isPep: true, isRelatedParty: true }, withWeights({ pep: 0.1, relatedParty: 0.2 })).score).toBe(0.3);
    expect(run({ isPep: true }, withWeights({ pep: 12.3456 })).score).toBe(12.35);
  });

  it('zero weights still list the factor with weight 0', () => {
    const r = run({ isPep: true }, withWeights({ pep: 0 }));
    expect(r).toEqual({ score: 0, level: 'LOW', factors: [{ code: 'PEP', weight: 0 }] });
  });

  it('confirmed sanctions force HIGH even with odd policy values', () => {
    const odd = withWeights({ sanctionsConfirmed: 0 }, { mediumFrom: 100, highFrom: 100 });
    const r = run({ sanctions: 'CONFIRMED' }, odd);
    expect(r.score).toBe(0);
    expect(r.level).toBe('HIGH');
  });

  it('possible sanctions do not force HIGH when the policy says otherwise', () => {
    expect(run({ sanctions: 'POSSIBLE' }, withWeights({ sanctionsPossible: 10 })).level).toBe('LOW');
  });

  it('accepts equal thresholds and the 0 / 100 limits', () => {
    expect(run({}, withWeights({}, { mediumFrom: 0, highFrom: 0 })).level).toBe('HIGH');
    expect(run({ isPep: true }, withWeights({}, { mediumFrom: 50, highFrom: 50 })).level).toBe('LOW');
    expect(run({ isPep: true }, withWeights({ pep: 100 }, { mediumFrom: 100, highFrom: 100 })).level).toBe('HIGH');
  });
});

describe('amlRisk policy validation', () => {
  it.each(Object.keys(DEFAULT_RISK.weights))('rejects a negative %s weight', (key) => {
    expect(() => run({}, withWeights({ [key]: -1 }))).toThrow(RangeError);
  });

  it('rejects a NaN weight', () => {
    expect(() => run({}, withWeights({ pep: Number.NaN }))).toThrow(RangeError);
  });

  it('rejects mediumFrom above highFrom', () => {
    expect(() => run({}, withWeights({}, { mediumFrom: 61, highFrom: 60 }))).toThrow(/mediumFrom/);
  });

  it.each([
    ['mediumFrom below 0', { mediumFrom: -1 }],
    ['mediumFrom above 100', { mediumFrom: 101, highFrom: 101 }],
    ['highFrom below 0', { mediumFrom: 0, highFrom: -1 }],
    ['highFrom above 100', { highFrom: 100.5 }],
    ['NaN threshold', { mediumFrom: Number.NaN }],
  ])('rejects thresholds outside 0..100: %s', (_name, t) => {
    expect(() => run({}, withWeights({}, t))).toThrow(/0\.\.100/);
  });

  it('validates the policy before looking at the input', () => {
    expect(() => run({ sanctions: 'CONFIRMED' }, withWeights({ sanctionsConfirmed: -1 }))).toThrow(RangeError);
  });
});
