import { describe, expect, it } from 'vitest';
import { dateKeyOf } from './date-key';

// dim_date.date_key = YYYYMMDD of the Mongolian business day (Asia/Ulaanbaatar, UTC+8, no DST), within the seeded 2020–2040 range.
describe('dateKeyOf', () => {
  it('maps an instant to the Ulaanbaatar calendar day', () => {
    expect(dateKeyOf('2026-11-02T03:00:00.000Z')).toBe(20261102);
  });
  it('rolls over at Ulaanbaatar midnight (16:00 UTC), not at UTC midnight', () => {
    expect(dateKeyOf('2026-11-01T15:59:59.999Z')).toBe(20261101);
    expect(dateKeyOf('2026-11-01T16:00:00.000Z')).toBe(20261102);
  });
  it('accepts the first and last seeded dim_date days', () => {
    expect(dateKeyOf('2019-12-31T16:00:00.000Z')).toBe(20200101);
    expect(dateKeyOf('2040-12-31T15:59:59.000Z')).toBe(20401231);
  });
  it('returns null outside the dim_date range (FK would fail) instead of throwing', () => {
    expect(dateKeyOf('2019-12-31T15:59:59.000Z')).toBeNull();
    expect(dateKeyOf('2040-12-31T16:00:00.000Z')).toBeNull();
  });
  it('returns null for an unparseable or empty timestamp', () => {
    expect(dateKeyOf('not-a-date')).toBeNull();
    expect(dateKeyOf('')).toBeNull();
  });
});
