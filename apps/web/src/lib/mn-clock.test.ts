import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mnDateKey, mnStartOfDayIso } from './format';
import { msUntilMnMidnight, watchMnDateKey } from './mn-clock';

describe('msUntilMnMidnight', () => {
  it('counts to the next Ulaanbaatar midnight (UTC+8), not UTC midnight', () => {
    // 15:59:30Z = 23:59:30 UB
    expect(msUntilMnMidnight(new Date('2026-10-28T15:59:30Z'))).toBe(30_000);
    // 16:00:00Z = 00:00:00 UB (29-р) → дараагийн шөнө дунд хүртэл бүтэн өдөр
    expect(msUntilMnMidnight(new Date('2026-10-28T16:00:00Z'))).toBe(86_400_000);
    expect(msUntilMnMidnight(new Date('2026-10-28T16:00:01Z'))).toBe(86_399_000);
    // UTC шөнө дунд = UB 08:00 → 16 цаг
    expect(msUntilMnMidnight(new Date('2026-10-28T00:00:00Z'))).toBe(16 * 3_600_000);
  });
});

describe('watchMnDateKey (dashboard window must roll over at UB midnight)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fires once when the Ulaanbaatar date changes and recomputes the window start', () => {
    vi.setSystemTime(new Date('2026-10-28T15:59:30Z')); // 23:59:30 UB, 28-ны өдөр
    const seen: string[] = [];
    const froms: string[] = [mnStartOfDayIso(new Date(), 0)];
    const stop = watchMnDateKey((key) => {
      seen.push(key);
      froms.push(mnStartOfDayIso(new Date(), 0));
    });
    expect(froms[0]).toBe('2026-10-28T00:00:00+08:00');

    vi.advanceTimersByTime(29_000); // 23:59:59
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1_200); // 00:00:00.2+ UB
    expect(seen).toEqual(['2026-10-29']);
    expect(froms).toEqual(['2026-10-28T00:00:00+08:00', '2026-10-29T00:00:00+08:00']);

    // Дахин зөвхөн дараагийн шөнө дундад л дуудагдана
    vi.advanceTimersByTime(23 * 3_600_000);
    expect(seen).toEqual(['2026-10-29']);
    vi.advanceTimersByTime(3_600_000);
    expect(seen).toEqual(['2026-10-29', '2026-10-30']);
    stop();
  });

  it('is not fooled by UTC midnight (08:00 UB) and does not fire on the initial value', () => {
    vi.setSystemTime(new Date('2026-10-28T23:00:00Z')); // 07:00 UB, 29-ний өглөө
    const seen: string[] = [];
    const stop = watchMnDateKey((key) => seen.push(key));
    vi.advanceTimersByTime(2 * 3_600_000); // UTC шөнө дунд (08:00 UB) өнгөрсөн ч Улаанбаатарын өдөр хэвээр
    expect(seen).toEqual([]);
    stop();
  });

  it('stop() cancels the timer', () => {
    vi.setSystemTime(new Date('2026-10-28T15:59:55Z'));
    const seen: string[] = [];
    const stop = watchMnDateKey((key) => seen.push(key));
    stop();
    vi.advanceTimersByTime(10_000);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-checks when the tab becomes visible again (timers are throttled/suspended in background)', () => {
    vi.setSystemTime(new Date('2026-10-28T10:00:00Z')); // 18:00 UB
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' as 'hidden' | 'visible' });
    vi.stubGlobal('document', doc);
    const seen: string[] = [];
    const stop = watchMnDateKey((key) => seen.push(key));
    // Төхөөрөмж унтсан: timer ажиллаагүй, цаг шууд маргааш өглөө болсон
    vi.setSystemTime(new Date('2026-10-29T01:00:00Z')); // 09:00 UB, 29-ний өглөө
    doc.dispatchEvent(new Event('visibilitychange')); // hidden → алгасна
    expect(seen).toEqual([]);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(seen).toEqual([mnDateKey(new Date('2026-10-29T01:00:00Z'))]);
    expect(seen).toEqual(['2026-10-29']);
    stop();
  });
});
