import { DomainError } from '@los/nest-common';
import { describe, expect, it } from 'vitest';
import { checkSetting } from './settings.service';

// F9-22: хүрээнээс гарсан утга "Оруулсан өгөгдөл буруу" гэсэн ерөнхий 400 биш, түлхүүр + зөвшөөрөгдсөн хүрээг нэрлэсэн 422 өгнө.
describe('checkSetting — credit-risk ratio range (F9-22)', () => {
  const outOfRange = (key: Parameters<typeof checkSetting>[0], value: unknown) => {
    try { checkSetting(key, value); } catch (e) { return e; }
    return null;
  };

  it.each([['br1.dti_max', 0], ['br1.dti_max', 1.01], ['br3.ltv_max', 55], ['br4.method_weight_threshold', 0.04], ['br1.dti_max', -0.1]] as const)(
    '%s = %s → 422 SETTING_OUT_OF_RANGE naming the key and the allowed range',
    (key, value) => {
      const e = outOfRange(key, value);
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toMatchObject({ code: 'SETTING_OUT_OF_RANGE', details: { key, min: 0.05, max: 1 } });
      expect((e as DomainError).getStatus()).toBe(422);
      expect((e as DomainError).message).toContain(key);
      expect((e as DomainError).message).toContain('5%');
      expect((e as DomainError).message).toContain('100%');
    },
  );

  it.each([0.05, 0.55, 1])('br1.dti_max = %s is accepted and returned as is', (v) => {
    expect(checkSetting('br1.dti_max', v)).toBe(v);
  });

  it('a non-number is still a schema error (not the range error), so the generic 400 path is unchanged', () => {
    const e = outOfRange('br1.dti_max', 'high');
    expect(e).not.toBeNull();
    expect(e).not.toBeInstanceOf(DomainError);
  });

  it('keys without a registered range are untouched (br2 DSCR stays "any positive number")', () => {
    expect(checkSetting('br2.dscr_min', 1.25)).toBe(1.25);
    expect(checkSetting('br2.dscr_min', 0.01)).toBe(0.01);
    expect(outOfRange('br2.dscr_min', 0)).not.toBeInstanceOf(DomainError);
  });
});
