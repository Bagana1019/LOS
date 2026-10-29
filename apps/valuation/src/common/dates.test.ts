import { describe, expect, it } from 'vitest';
import { dbDate, isRealIsoDate, toIsoDate, todayUb, ubDayEnd, ubDayStart } from './dates';

// Asia/Ulaanbaatar is a fixed UTC+8: the officer's "today" can be a day ahead of UTC.

describe('isRealIsoDate', () => {
  it.each(['2026-10-29', '2024-02-29', '2000-02-29', '2026-12-31'])('accepts %s', (d) => expect(isRealIsoDate(d)).toBe(true));
  it.each(['2026-02-30', '2025-02-29', '2100-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '29.10.2026', '2026-1-1', '', '2026-10-29T00:00:00Z'])('rejects %s', (d) => expect(isRealIsoDate(d)).toBe(false));
});

describe('Ulaanbaatar days', () => {
  it('today is the Ulaanbaatar calendar day', () => {
    expect(todayUb(new Date('2026-10-28T15:59:59.999Z'))).toBe('2026-10-28');
    expect(todayUb(new Date('2026-10-28T16:00:00.000Z'))).toBe('2026-10-29');
  });
  it('a day starts at 00:00 and ends at 23:59:59.999 local time', () => {
    expect(ubDayStart('2026-10-29').toISOString()).toBe('2026-10-28T16:00:00.000Z');
    expect(ubDayEnd('2026-10-29').toISOString()).toBe('2026-10-29T15:59:59.999Z');
  });
  it('date columns round-trip as UTC midnight', () => {
    expect(dbDate('2026-01-01').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(toIsoDate(dbDate('2026-01-01'))).toBe('2026-01-01');
  });
});
