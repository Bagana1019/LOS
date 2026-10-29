// ReDoS хамгаалалт: admin-ийн REGEX дүрэм (BSA-FR-3.5). Цагийн төсвөөр "гацахгүй" гэдгийг нотолно.
import { describe, expect, it } from 'vitest';
import { REGEX_LIMITS } from './classify.defaults';
import { compileSafeRegex, findUnsafeRegexReason, testSafeRegex } from './regex-guard';

const TIME_BUDGET_MS = 250;
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

describe('compileSafeRegex — static rejection', () => {
  const unsafe = [
    '(a+)+$', '(a*)*b', '(a|aa)+$', '(a|b)*c', '(x+x+)+y', '(.*)*', '(.+)+', '(a+)*', '(?:a+)+', '(\\w+\\s?)+$', '^(a?){30}a{30}$',
    '((a+)+)+', '(a)\\1', '(?<n>a)\\k<n>', 'a{1,1000}', '.*.*.*x', 'a*a*a*a*b', '\\d+\\d+\\d+', '(?:(?:a+)b)+',
  ];
  it.each(unsafe)('rejects %s as REGEX_UNSAFE', (pattern) => {
    const r = compileSafeRegex(pattern);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('REGEX_UNSAFE');
  });

  it('rejects a pattern that matches the empty text (would tag every transaction)', () => {
    for (const pattern of ['a*', '^', '(?:x)?', '$']) {
      const r = compileSafeRegex(pattern);
      expect(r.ok, pattern).toBe(false);
      if (!r.ok) expect(r.code).toBe('REGEX_UNSAFE');
    }
  });

  it('rejects syntax errors, empty and over-long patterns with distinct codes', () => {
    expect(compileSafeRegex('(')).toMatchObject({ ok: false, code: 'REGEX_INVALID' });
    expect(compileSafeRegex('[a-')).toMatchObject({ ok: false, code: 'REGEX_INVALID' });
    expect(compileSafeRegex('*a')).toMatchObject({ ok: false, code: 'REGEX_INVALID' });
    expect(compileSafeRegex('\\1')).toMatchObject({ ok: false, code: 'REGEX_INVALID' });
    expect(compileSafeRegex('')).toMatchObject({ ok: false, code: 'REGEX_EMPTY' });
    expect(compileSafeRegex('   ')).toMatchObject({ ok: false, code: 'REGEX_EMPTY' });
    expect(compileSafeRegex(undefined as unknown as string)).toMatchObject({ ok: false, code: 'REGEX_EMPTY' });
    expect(compileSafeRegex('a'.repeat(REGEX_LIMITS.maxPatternLength))).toMatchObject({ ok: true });
    expect(compileSafeRegex('a'.repeat(REGEX_LIMITS.maxPatternLength + 1))).toMatchObject({ ok: false, code: 'REGEX_TOO_LONG' });
  });

  it('reasons never echo the pattern text', () => {
    const r = compileSafeRegex('(секрет+)+$');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('секрет');
  });
});

describe('compileSafeRegex — accepted shapes', () => {
  const safe: Array<[string, string, boolean]> = [
    ['цалин\\s*\\d+', 'Цалин 2026', true],
    ['^qpay', 'QPay төлбөр', true],
    ['(qpay|pos)\\s', 'POS 123', true],
    ['шилжүүлэг\\s+\\d{4,8}', 'Шилжүүлэг 123456', true],
    ['(ab)+c', 'xababc', true],
    ['[a-z]+\\d*', 'abc12', true],
    ['\\p{L}+\\d', 'Цалин5', true],
    ['x{2,3}y', 'xxy', true],
    ['цалин(?:гийн)?', 'ЦАЛИНГИЙН', true],
  ];
  it.each(safe)('accepts %s', (pattern, sample, matches) => {
    const r = compileSafeRegex(pattern);
    expect(r.ok).toBe(true);
    if (r.ok) expect(testSafeRegex(r.regex, sample)).toBe(matches);
  });

  it('compiles case-insensitively with the unicode flag and never with g/y (no lastIndex state)', () => {
    const r = compileSafeRegex('цалин');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.regex.flags).toBe('iu');
      expect(testSafeRegex(r.regex, 'ЦАЛИН')).toBe(true);
      expect(testSafeRegex(r.regex, 'ЦАЛИН')).toBe(true); // давтан дуудахад ижил
    }
  });
});

describe('ReDoS time budget', () => {
  const EVIL_INPUT = `${'a'.repeat(50_000)}!`;

  it('the classic (a+)+$ is rejected at compile time, in well under the budget, and no regex is ever built for it', () => {
    const { value, ms } = timed(() => compileSafeRegex('(a+)+$'));
    expect(value.ok).toBe(false);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it('every static check is linear in the (≤200 char) pattern length', () => {
    const nasty = '('.repeat(80) + 'a+' + ')+'.repeat(80);
    const { value, ms } = timed(() => findUnsafeRegexReason(nasty));
    expect(value).not.toBeNull();
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it('input is length-capped: even an allowed quadratic pattern finishes fast on a 50k char adversarial text', () => {
    const r = compileSafeRegex('.*.*x'); // 2 хязгааргүй давталт — зөвшөөрөгдөнө (O(L²), L ≤ 300)
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { value, ms } = timed(() => testSafeRegex(r.regex, EVIL_INPUT));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it('truncation is documented behaviour: text beyond maxInputLength is not examined', () => {
    const r = compileSafeRegex('x$');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(testSafeRegex(r.regex, `${'a'.repeat(REGEX_LIMITS.maxInputLength + 10)}x`)).toBe(false);
    expect(testSafeRegex(r.regex, `${'a'.repeat(10)}x`)).toBe(true);
  });
});
