import { describe, expect, it } from 'vitest';
import { fromMinor, MinorSum, toMinor, toMinorOrNull } from './money';

describe('toMinor', () => {
  it('converts to integer minor units without float drift', () => {
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(1234.56)).toBe(123456);
    expect(toMinor(-5.25)).toBe(-525);
    expect(Object.is(toMinor(-0), 0)).toBe(true);
  });

  it('throws RangeError for non-finite or unsafe-sized amounts', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e300]) expect(() => toMinor(bad)).toThrow(RangeError);
  });
});

describe('toMinorOrNull', () => {
  it('matches toMinor for valid amounts', () => {
    for (const v of [0, 1, 0.1 + 0.2, 1234.56, -5.25]) expect(toMinorOrNull(v)).toBe(toMinor(v));
  });

  it('returns null (never throws) for NaN, Infinity, huge and non-number input', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, '5' as never, null as never, undefined as never]) {
      expect(toMinorOrNull(bad), String(bad)).toBeNull();
    }
  });
});

describe('MinorSum', () => {
  it('sums beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const sum = new MinorSum();
    sum.add(Number.MAX_SAFE_INTEGER);
    sum.add(Number.MAX_SAFE_INTEGER);
    sum.add(1);
    expect(sum.value).toBe(BigInt(Number.MAX_SAFE_INTEGER) * 2n + 1n);
  });

  it('exposes the total as a 2-decimal amount', () => {
    const sum = new MinorSum();
    [10, 20, 5].forEach((m) => sum.add(m));
    expect(sum.amount).toBe(0.35);
    expect(fromMinor(123456n)).toBe(1234.56);
  });
});
