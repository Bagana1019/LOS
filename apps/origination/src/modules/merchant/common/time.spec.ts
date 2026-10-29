import { describe, expect, it } from 'vitest';
import { Clock } from '../ports';
import { addHours, addMinutes, addSeconds, mnDateKey, mnDayRange, mnDaysBetween, mnStartOfDay, mnYYMMDD, SystemClock } from './time';

const d = (s: string) => new Date(s);

describe('Asia/Ulaanbaatar (UTC+8) helpers', () => {
  it('SystemClock is a Clock and returns the current time', () => {
    const c = new SystemClock();
    expect(c).toBeInstanceOf(Clock);
    expect(Math.abs(c.now().getTime() - Date.now())).toBeLessThan(1000);
  });
  it('mnDateKey flips at 16:00Z', () => {
    expect(mnDateKey(d('2026-10-27T15:59:59.999Z'))).toBe('2026-10-27');
    expect(mnDateKey(d('2026-10-27T16:00:00.000Z'))).toBe('2026-10-28');
    expect(mnDateKey(d('2026-10-28T00:00:00.000Z'))).toBe('2026-10-28');
  });
  it('mnDateKey handles month, year and leap-day boundaries', () => {
    expect(mnDateKey(d('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01');
    expect(mnDateKey(d('2028-02-28T16:00:00.000Z'))).toBe('2028-02-29');
    expect(mnDateKey(d('2028-02-29T16:00:00.000Z'))).toBe('2028-03-01');
  });
  it('mnDayRange is [start, end) of the Ulaanbaatar day', () => {
    const [start, end] = mnDayRange(d('2026-10-28T04:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-10-27T16:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-28T16:00:00.000Z');
    expect(mnDayRange(start)[0].toISOString()).toBe(start.toISOString()); // эхлэл өөрөө тухайн өдөрт
    expect(mnDayRange(new Date(end.getTime() - 1))[0].toISOString()).toBe(start.toISOString());
    expect(mnDayRange(end)[0].toISOString()).toBe(end.toISOString()); // төгсгөл нь дараагийн өдрийн эхлэл
    expect(mnStartOfDay(d('2026-10-28T10:00:00.000Z')).toISOString()).toBe('2026-10-27T16:00:00.000Z');
  });
  it('mnDaysBetween lists every Ulaanbaatar date inclusive', () => {
    expect(mnDaysBetween(d('2026-10-26T02:00:00.000Z'), d('2026-10-28T04:00:00.000Z'))).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect(mnDaysBetween(d('2026-10-29T20:00:00.000Z'), d('2026-11-01T01:00:00.000Z'))).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    expect(mnDaysBetween(d('2026-10-28T01:00:00.000Z'), d('2026-10-28T02:00:00.000Z'))).toEqual(['2026-10-28']);
    expect(mnDaysBetween(d('2026-10-29T00:00:00.000Z'), d('2026-10-28T00:00:00.000Z'))).toEqual([]);
  });
  it('mnYYMMDD formats the lease-number date part', () => {
    expect(mnYYMMDD(d('2026-10-28T04:00:00.000Z'))).toBe('261028');
    expect(mnYYMMDD(d('2026-12-31T16:00:00.000Z'))).toBe('270101');
  });
  it('add helpers', () => {
    const base = d('2026-10-28T00:00:00.000Z');
    expect(addMinutes(base, 30).toISOString()).toBe('2026-10-28T00:30:00.000Z');
    expect(addSeconds(base, 90).toISOString()).toBe('2026-10-28T00:01:30.000Z');
    expect(addHours(base, 72).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});
