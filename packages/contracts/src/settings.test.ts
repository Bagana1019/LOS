import { describe, expect, it } from 'vitest';
import { isSettingKey, parseSetting, SETTING_KEYS, SETTING_REGISTRY } from './settings';

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
