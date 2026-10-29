import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, type RetryPolicy } from './retry-policy';

const policy: RetryPolicy = { baseDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitterRatio: 0.2, maxAttempts: 15 };
const mid = () => 0.5; // jitter multiplier exactly 1

afterEach(() => { vi.restoreAllMocks(); });

describe('backoffDelayMs', () => {
  describe('exponential growth', () => {
    it('doubles the delay with every failed attempt (jitter neutral)', () => {
      const delays = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayMs(policy, n, mid));
      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
    });

    it('honours a non-integer growth factor and rounds to whole milliseconds', () => {
      const p: RetryPolicy = { ...policy, baseDelayMs: 100, factor: 1.5, jitterRatio: 0 };
      expect([1, 2, 3, 4].map((n) => backoffDelayMs(p, n, mid))).toEqual([100, 150, 225, 338]); // 337.5 rounds up
      for (let n = 1; n <= 12; n++) expect(Number.isInteger(backoffDelayMs(p, n, () => 0.37))).toBe(true);
    });

    it('is constant when the factor is 1', () => {
      const p: RetryPolicy = { ...policy, factor: 1 };
      expect([1, 2, 5, 40].map((n) => backoffDelayMs(p, n, mid))).toEqual([1_000, 1_000, 1_000, 1_000]);
    });

    it('is non-decreasing in attemptsMade for a fixed random source', () => {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        let prev = 0;
        for (let n = 1; n <= 30; n++) {
          const d = backoffDelayMs(policy, n, () => r);
          expect(d).toBeGreaterThanOrEqual(prev);
          prev = d;
        }
      }
    });
  });

  describe('cap', () => {
    it('never exceeds maxDelayMs, with the cap reached at attempt 7 (1000 * 2^6 = 64000)', () => {
      expect(backoffDelayMs(policy, 6, mid)).toBe(32_000);
      expect(backoffDelayMs(policy, 7, mid)).toBe(60_000);
      expect(backoffDelayMs(policy, 8, mid)).toBe(60_000);
      expect(backoffDelayMs(policy, 100, mid)).toBe(60_000);
    });

    it('applies the cap after jitter too, so the maximum jitter cannot push the delay past maxDelayMs', () => {
      expect(backoffDelayMs(policy, 7, () => 1)).toBe(60_000);
      expect(backoffDelayMs(policy, 50, () => 1)).toBe(60_000);
      expect(backoffDelayMs(policy, 6, () => 1)).toBe(38_400); // 32000 * 1.2, below the cap
      expect(backoffDelayMs(policy, 6, () => 1)).toBeLessThanOrEqual(policy.maxDelayMs);
    });

    it('still jitters downwards at the cap', () => {
      expect(backoffDelayMs(policy, 50, () => 0)).toBe(48_000); // 60000 * 0.8
    });

    it('caps a base delay that is already larger than maxDelayMs', () => {
      const p: RetryPolicy = { ...policy, baseDelayMs: 120_000 };
      expect(backoffDelayMs(p, 1, mid)).toBe(60_000);
      expect(backoffDelayMs(p, 1, () => 1)).toBe(60_000);
    });

    it('does not overflow to NaN/Infinity for absurdly large attempt counts', () => {
      for (const n of [1_000, 100_000, Number.MAX_SAFE_INTEGER]) {
        expect(backoffDelayMs(policy, n, mid)).toBe(60_000);
        expect(Number.isFinite(backoffDelayMs(policy, n, () => 0))).toBe(true);
      }
    });
  });

  describe('jitter bounds', () => {
    it('maps random() = 0 / 0.5 / 1 to -jitterRatio / 0 / +jitterRatio', () => {
      expect(backoffDelayMs(policy, 3, () => 0)).toBe(3_200); // 4000 * 0.8
      expect(backoffDelayMs(policy, 3, () => 0.5)).toBe(4_000);
      expect(backoffDelayMs(policy, 3, () => 1)).toBe(4_800); // 4000 * 1.2
    });

    it('interpolates linearly between the bounds', () => {
      expect(backoffDelayMs(policy, 3, () => 0.25)).toBe(3_600);
      expect(backoffDelayMs(policy, 3, () => 0.75)).toBe(4_400);
    });

    it('keeps every delay within [exp * (1 - ratio), exp * (1 + ratio)] and within [0, maxDelayMs] for any random value', () => {
      for (let n = 1; n <= 12; n++) {
        const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (n - 1));
        for (let i = 0; i <= 100; i++) {
          const d = backoffDelayMs(policy, n, () => i / 100);
          expect(d).toBeGreaterThanOrEqual(Math.round(exp * 0.8));
          expect(d).toBeLessThanOrEqual(Math.min(policy.maxDelayMs, Math.round(exp * 1.2)));
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(policy.maxDelayMs);
        }
      }
    });

    it('ignores random() entirely when jitterRatio is 0', () => {
      const p: RetryPolicy = { ...policy, jitterRatio: 0 };
      expect(new Set([0, 0.1, 0.5, 0.99, 1].map((r) => backoffDelayMs(p, 4, () => r)))).toEqual(new Set([8_000]));
    });

    it('can reach a zero delay with full jitter, but never a negative one', () => {
      const p: RetryPolicy = { ...policy, jitterRatio: 1 };
      expect(backoffDelayMs(p, 3, () => 0)).toBe(0);
      expect(backoffDelayMs(p, 3, () => 1)).toBe(8_000);
      for (let i = 0; i <= 20; i++) expect(backoffDelayMs(p, 2, () => i / 20)).toBeGreaterThanOrEqual(0);
    });

    it('calls random() exactly once per computation', () => {
      const random = vi.fn(() => 0.5);
      backoffDelayMs(policy, 4, random);
      expect(random).toHaveBeenCalledTimes(1);
    });

    it('falls back to Math.random when no random source is injected', () => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(backoffDelayMs(policy, 3)).toBe(3_200);
      spy.mockReturnValue(1);
      expect(backoffDelayMs(policy, 3)).toBe(4_800);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('produces a different spread over a real random source (not constant)', () => {
      const seen = new Set<number>();
      let s = 1;
      const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      for (let i = 0; i < 50; i++) seen.add(backoffDelayMs(policy, 5, rnd));
      expect(seen.size).toBeGreaterThan(10);
    });
  });

  describe('attemptsMade <= 1', () => {
    it('treats the first failure (attemptsMade = 1) as the base delay', () => {
      expect(backoffDelayMs(policy, 1, mid)).toBe(1_000);
    });

    it('treats 0 and negative counts like the first attempt (no sub-base delays)', () => {
      expect(backoffDelayMs(policy, 0, mid)).toBe(1_000);
      expect(backoffDelayMs(policy, -1, mid)).toBe(1_000);
      expect(backoffDelayMs(policy, -1_000, mid)).toBe(1_000);
      expect(backoffDelayMs(policy, 0, () => 0)).toBe(800);
      expect(backoffDelayMs(policy, 0, () => 1)).toBe(1_200);
    });
  });

  describe('with the default accounting policy shape (30 s base, 1 h cap, 20 % jitter)', () => {
    const p: RetryPolicy = { baseDelayMs: 30_000, factor: 2, maxDelayMs: 3_600_000, jitterRatio: 0.2, maxAttempts: 15 };
    it('backs off 30 s, 1 min, 2 min ... and saturates at one hour', () => {
      const delays = Array.from({ length: 10 }, (_, i) => backoffDelayMs(p, i + 1, mid));
      expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]);
    });
  });
});
