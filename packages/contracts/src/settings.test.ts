import { describe, expect, it } from 'vitest';
import { FOUR_EYES_SETTING_KEYS, isFourEyesSettingKey } from './maker-checker';
import { isSettingKey, parseSetting, RISK_RATIO_RANGE, SETTING_KEYS, SETTING_RANGES, SETTING_REGISTRY } from './settings';

// F9-22: зээлийн эрсдэлийн босгыг нэг админ шууд өөрчилж, 0 болгож бүх A аргын хүсэлтийг хаадаг байсан
describe('F9-22 credit-risk thresholds', () => {
  const RATIO_KEYS = ['br1.dti_max', 'br3.ltv_max', 'br4.method_weight_threshold'] as const;
  it.each(RATIO_KEYS)('%s accepts 0.05…1 and rejects 0, below 0.05, above 1 and non-numbers', (key) => {
    for (const ok of [0.05, 0.55, 1]) expect(parseSetting(key, ok)).toBe(ok);
    for (const bad of [0, 0.04, -0.1, 1.01, 55, '0.5', null]) expect(() => parseSetting(key, bad), String(bad)).toThrow();
  });
  it('the exported range is the one the schemas enforce, listed for exactly those keys', () => {
    expect(RISK_RATIO_RANGE).toEqual({ min: 0.05, max: 1 });
    expect(Object.keys(SETTING_RANGES).sort()).toEqual([...RATIO_KEYS].sort());
    for (const k of RATIO_KEYS) expect(SETTING_RANGES[k]).toEqual(RISK_RATIO_RANGE);
  });
  it('the five credit-risk keys need four eyes, next to the two existing ones; br9 (single allowed value) does not', () => {
    for (const k of ['br1.dti_max', 'br2.dscr_min', 'br3.ltv_max', 'br4.method_weight_threshold', 'br10.disburse_not_exceed_approved', 'contract.branch_codes', 'approval.default_sla_hours']) expect(isFourEyesSettingKey(k), k).toBe(true);
    expect(isFourEyesSettingKey('br9.blacklist_mode')).toBe(false);
    expect(isFourEyesSettingKey('inquiry.stale_days')).toBe(false);
    for (const k of FOUR_EYES_SETTING_KEYS) expect(isSettingKey(k), k).toBe(true);
  });
});

describe('setting registry', () => {
  it('every default satisfies its own schema', () => {
    for (const k of SETTING_KEYS) expect(() => SETTING_REGISTRY[k].schema.parse(SETTING_REGISTRY[k].default), k).not.toThrow();
  });
  it('BR defaults match docs/01 §8', () => {
    expect(SETTING_REGISTRY['br1.dti_max'].default).toBe(0.55);
    expect(SETTING_REGISTRY['br2.dscr_min'].default).toBe(1.25);
    expect(SETTING_REGISTRY['br3.ltv_max'].default).toBe(0.7);
    expect(SETTING_REGISTRY['br4.method_weight_threshold'].default).toBe(0.7);
  });
  it('BR-7 / FR-9.2: required steps include the document checklist step (8)', () => {
    expect(SETTING_REGISTRY['br7.required_steps'].default).toEqual(['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score', 'document']);
  });
  it('G1 AML: screening reuse window is a non-negative integer of hours (0 = always rescreen)', () => {
    expect(SETTING_REGISTRY['aml.screening_reuse_hours'].default).toBe(24);
    expect(parseSetting('aml.screening_reuse_hours', 0)).toBe(0);
    expect(() => parseSetting('aml.screening_reuse_hours', -1)).toThrow();
    expect(() => parseSetting('aml.screening_reuse_hours', 1.5)).toThrow();
  });
  it('rejects bad values and unknown keys', () => {
    expect(() => parseSetting('br1.dti_max', 1.5)).toThrow();
    expect(parseSetting('br1.dti_max', 0.5)).toBe(0.5);
    expect(isSettingKey('nope')).toBe(false);
    expect(isSettingKey('br1.dti_max')).toBe(true);
  });
  it('keys are unique lowercase dotted identifiers', () => {
    for (const k of SETTING_KEYS) expect(k).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
  });
});
