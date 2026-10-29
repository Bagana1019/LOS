import { describe, it, expect } from 'vitest';
import { remindersFor } from './reminders';

const policy = { beforeDueDays: [3, 1, 0], overdueDays: [1, 3, 7] };
const c = (id: string, dueDate: string, outstanding = 1000) => ({ installmentId: id, dueDate, outstanding });

describe('remindersFor', () => {
  it('3 хоногийн өмнө / өдөр нь / хэтэрсэн хоног бүрт', () => {
    const hits = remindersFor('2026-10-28', [c('a', '2026-10-31'), c('b', '2026-10-29'), c('c', '2026-10-28'), c('d', '2026-10-27'), c('e', '2026-10-25'), c('f', '2026-10-21')], policy);
    expect(hits.map((h) => [h.installmentId, h.kind, h.offsetDays])).toEqual([
      ['a', 'UPCOMING', 3], ['b', 'UPCOMING', 1], ['c', 'DUE_TODAY', 0], ['d', 'OVERDUE', 1], ['e', 'OVERDUE', 3], ['f', 'OVERDUE', 7],
    ]);
    expect(hits[0].key).toBe('a:UPCOMING:3');
  });
  it('бодлогод байхгүй хоногт, төлөгдсөн мөрөнд сануулахгүй', () => {
    expect(remindersFor('2026-10-28', [c('x', '2026-11-05'), c('y', '2026-10-24'), c('z', '2026-10-31', 0)], policy)).toEqual([]);
  });
  it('буруу бодлогын утгыг (сөрөг, бутархай, overdue 0) үл тооцно', () => {
    const bad = { beforeDueDays: [-1, 1.5, 2], overdueDays: [0, -2, 2.5] };
    expect(remindersFor('2026-10-28', [c('a', '2026-10-30'), c('b', '2026-10-28'), c('c', '2026-10-27')], bad).map((h) => h.installmentId)).toEqual(['a']);
  });
});
