// Хуудаслалтын хөрвүүлэлт ба өдрийн хил (UTC).
import { describe, expect, it } from 'vitest';
import { endExclusiveUtc, pageRequestOf, startOfDayUtc, toEnvelope } from './page';

describe('page helpers', () => {
  it('maps page/pageSize to limit/offset', () => {
    expect(pageRequestOf({ page: 1, pageSize: 50 })).toEqual({ limit: 50, offset: 0 });
    expect(pageRequestOf({ page: 3, pageSize: 20 })).toEqual({ limit: 20, offset: 40 });
  });

  it('builds a consistent envelope (page number, hasMore)', () => {
    expect(toEnvelope({ items: [1, 2], total: 5, limit: 2, offset: 2 })).toEqual({
      items: [1, 2], total: 5, limit: 2, offset: 2, page: 2, pageSize: 2, hasMore: true,
    });
    expect(toEnvelope({ items: [5], total: 5, limit: 2, offset: 4 })).toMatchObject({ page: 3, hasMore: false });
    expect(toEnvelope({ items: [], total: 0, limit: 50, offset: 0 })).toMatchObject({ page: 1, hasMore: false });
    expect(toEnvelope({ items: [], total: 0, limit: 0, offset: 0 }).page).toBe(1); // limit=0 үед хуваахгүй
  });

  it('createdTo includes the whole day: the end is the start of the next UTC day', () => {
    expect(startOfDayUtc('2026-06-30').toISOString()).toBe('2026-06-30T00:00:00.000Z');
    expect(endExclusiveUtc('2026-06-30').toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(endExclusiveUtc('2026-12-31').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
