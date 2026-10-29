import { describe, expect, it } from 'vitest';
import { MASK_MAX_STARS, maskForLog } from './mask';

describe('maskForLog', () => {
  it.each([
    ['', ''],
    ['a', '*'],
    ['ab', '**'],
    ['abc', '***'],
    ['abcd', '***d'],
    ['abcdefg', '******g'],
    ['abcdefgh', '******gh'],
    ['УБ90010203', '********03'],
    ['MN580050099123456789', '********89'],
    ['5011234567', '********67'],
  ])('%j -> %j', (input, expected) => {
    expect(maskForLog(input)).toBe(expected);
  });

  it('never reveals more than the last 2 characters, whatever the input', () => {
    const samples = ['x', 'xy', 'xyz', 'wxyz', 'vwxyz12', 'УБ90010203', 'Батаа Болд', 'a'.repeat(1000), '1234567890123456'];
    for (const s of samples) {
      const masked = maskForLog(s);
      const revealed = masked.replace(/\*/g, '');
      expect(revealed.length).toBeLessThanOrEqual(2);
      expect(s.endsWith(revealed)).toBe(true);
      expect(masked.length).toBeLessThanOrEqual(MASK_MAX_STARS + 2);
      if (s.length > 4) expect(masked).not.toContain(s.slice(0, 4));
    }
  });

  it('does not leak the length of long values and stays small', () => {
    expect(maskForLog('1'.repeat(10))).toHaveLength(MASK_MAX_STARS + 2);
    expect(maskForLog('1'.repeat(100_000))).toHaveLength(MASK_MAX_STARS + 2);
  });

  it('does not split surrogate pairs', () => {
    expect(maskForLog('\u{1F600}'.repeat(8))).toBe(`${'*'.repeat(6)}\u{1F600}\u{1F600}`);
    expect(maskForLog('\u{1F600}'.repeat(12))).toBe(`${'*'.repeat(MASK_MAX_STARS)}\u{1F600}\u{1F600}`);
    expect(maskForLog(`${'x'.repeat(100)}\u{1F600}`)).toBe(`${'*'.repeat(MASK_MAX_STARS)}x\u{1F600}`);
    expect(maskForLog('abcdefg\u{1F600}')).toBe('******g\u{1F600}');
    expect(maskForLog('abc\u{1F600}')).toBe('***\u{1F600}');
  });

  it('returns an empty string for non-strings', () => {
    expect(maskForLog(undefined as unknown as string)).toBe('');
    expect(maskForLog(null as unknown as string)).toBe('');
    expect(maskForLog(12345 as unknown as string)).toBe('');
  });
});
