import { describe, expect, it } from 'vitest';
import { PortalError } from './portal-error';
import { safeEqual, hmacHex, sha256Hex } from './crypto';
import { addDays, addMonths, diffDays, round2, todayIn } from './date';
import { maskPhone } from './mask';
import { ERROR_CATALOG } from './error-catalog';
import { PortalErrorCode } from '@los/contracts';

describe('date helpers', () => {
  it('todayIn uses the Ulaanbaatar calendar day (UTC+8), not UTC', () => {
    expect(todayIn('Asia/Ulaanbaatar', new Date('2026-10-28T15:59:59Z'))).toBe('2026-10-28');
    expect(todayIn('Asia/Ulaanbaatar', new Date('2026-10-28T16:00:00Z'))).toBe('2026-10-29');
    expect(todayIn('UTC', new Date('2026-10-28T16:00:00Z'))).toBe('2026-10-28');
  });

  it('addMonths clamps to the end of shorter months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-10-28', -11)).toBe('2025-11-28');
    expect(addMonths('2026-12-15', 2)).toBe('2027-02-15');
  });

  it('diffDays / addDays are calendar-day exact across DST-free dates', () => {
    expect(diffDays('2026-10-18', '2026-11-18')).toBe(31);
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });

  it('round2 rounds half up on cents', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2924613.809999)).toBe(2924613.81);
  });
});

describe('maskPhone', () => {
  it('keeps the first two and last two digits', () => {
    expect(maskPhone('99112233')).toBe('99****33');
    expect(maskPhone('123')).toBe('***');
  });
});

describe('crypto helpers', () => {
  it('safeEqual compares without throwing on different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('hmac depends on the secret; sha256 is stable', () => {
    expect(hmacHex('a'.repeat(32), 'x')).not.toBe(hmacHex('b'.repeat(32), 'x'));
    expect(sha256Hex('x')).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });
});

describe('error catalog', () => {
  it('has a status and a Mongolian message for every public error code', () => {
    for (const code of PortalErrorCode.options) {
      const entry = ERROR_CATALOG[code];
      expect(entry, code).toBeDefined();
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.message).toMatch(/[А-Яа-яӨөҮү]/);
    }
  });
  it('PortalError carries its code', () => {
    expect(new PortalError('LOAN_NOT_FOUND').code).toBe('LOAN_NOT_FOUND');
  });
});
