import { describe, expect, it } from 'vitest';
import { buildIsoDate, DATE_MAX_INPUT_LENGTH, DATE_YEAR_MAX, DATE_YEAR_MIN, findDates, parseDateIso, parseTime } from './date';

describe('buildIsoDate', () => {
  it('builds zero-padded dates and validates the calendar', () => {
    expect(buildIsoDate(2026, 3, 5)).toBe('2026-03-05');
    expect(buildIsoDate(2024, 2, 29)).toBe('2024-02-29');
    expect(buildIsoDate(2023, 2, 29)).toBeNull();
    expect(buildIsoDate(2026, 4, 31)).toBeNull();
    expect(buildIsoDate(2026, 12, 31)).toBe('2026-12-31');
  });

  it('rejects non-integers and out-of-range parts', () => {
    expect(buildIsoDate(2026.5, 1, 1)).toBeNull();
    expect(buildIsoDate(2026, 1.5, 1)).toBeNull();
    expect(buildIsoDate(2026, 1, 1.5)).toBeNull();
    expect(buildIsoDate(NaN, 1, 1)).toBeNull();
    expect(buildIsoDate(2026, 0, 1)).toBeNull();
    expect(buildIsoDate(2026, 13, 1)).toBeNull();
    expect(buildIsoDate(2026, 1, 0)).toBeNull();
    expect(buildIsoDate(DATE_YEAR_MIN - 1, 1, 1)).toBeNull();
    expect(buildIsoDate(DATE_YEAR_MAX + 1, 1, 1)).toBeNull();
    expect(buildIsoDate(DATE_YEAR_MIN, 1, 1)).toBe('1900-01-01');
    expect(buildIsoDate(DATE_YEAR_MAX, 12, 31)).toBe('2100-12-31');
  });
});

describe('parseDateIso: supported formats', () => {
  it.each([
    ['2026-03-10', '2026-03-10'],
    ['2026/03/10', '2026-03-10'],
    ['2026.03.10', '2026-03-10'],
    ['2026-3-5', '2026-03-05'],
    ['10.03.2026', '2026-03-10'],
    ['10/03/2026', '2026-03-10'],
    ['10-03-2026', '2026-03-10'],
    ['5.3.2026', '2026-03-05'],
    ['31.12.2026', '2026-12-31'],
    ['  2026-03-10  ', '2026-03-10'],
    ['\u{A0}2026-03-10\u{A0}', '2026-03-10'],
    ['\u{200B}2026-03-10', '2026-03-10'],
    ['２０２６-０３-１０', '2026-03-10'], // бүтэн өргөнтэй цифр
  ])('%j -> %j', (input, expected) => {
    expect(parseDateIso(input)).toBe(expected);
  });

  it.each([
    ['2026 оны 3 дугаар сарын 10', '2026-03-10'],
    ['2026 оны 03-р сарын 10-ны өдөр', '2026-03-10'],
    ['2026 оны 3 сарын 10', '2026-03-10'],
    ['2026 он 3 сар 10', '2026-03-10'],
    ['2026 ОНЫ 3 ДУГААР САРЫН 10', '2026-03-10'],
    ['2026 оны 12 дугаар сарын 31-ний өдөр', '2026-12-31'],
    ['2026 оны 3 дүгээр сарын 1', '2026-03-01'],
    ['2026 оны 3 дахь сарын 1 өдөр', '2026-03-01'],
    ['2026 оны  3  дугаар  сарын  10', '2026-03-10'],
    ['2026оны 3-р сарын 10', '2026-03-10'],
    ['2026 оны 3-р сарын 10-нд', '2026-03-10'],
  ])('mongolian long form %j -> %j', (input, expected) => {
    expect(parseDateIso(input)).toBe(expected);
  });

  it.each([
    ['2026-03-10T12:30:45Z', '2026-03-10'],
    ['2026-03-10T12:30:45.123Z', '2026-03-10'],
    ['2026-03-10T12:30:45+08:00', '2026-03-10'],
    ['2026-03-10T12:30:45+0800', '2026-03-10'],
    ['2026-03-10T12:30', '2026-03-10'],
    ['2026-03-10 14:25', '2026-03-10'],
    ['2026-03-10 14:25:07', '2026-03-10'],
    ['2026-03-10 02:25 PM', '2026-03-10'],
    ['2026-03-10 14:25 UTC', '2026-03-10'],
    ['10.03.2026 14:25:07', '2026-03-10'],
    ['2026 оны 3 дугаар сарын 10 14:25', '2026-03-10'],
  ])('ISO datetime prefix %j -> %j (no timezone shift)', (input, expected) => {
    expect(parseDateIso(input)).toBe(expected);
  });
});

describe('parseDateIso: calendar validation', () => {
  it.each([
    ['2024-02-29', '2024-02-29'],
    ['2000-02-29', '2000-02-29'],
    ['2026-04-30', '2026-04-30'],
    ['29.02.2024', '2024-02-29'],
  ])('accepts %j', (input, expected) => {
    expect(parseDateIso(input)).toBe(expected);
  });

  it.each([
    '2026-02-30',
    '2026-02-29',
    '1900-02-29',
    '2100-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '30.02.2026',
    '31.04.2026',
    '1899-12-31',
    '2101-01-01',
    '2026 оны 13 дугаар сарын 10',
    '2026 оны 2 дугаар сарын 30',
  ])('rejects the invalid day %j', (input) => {
    expect(parseDateIso(input)).toBeNull();
  });
});

describe('parseDateIso: order option (year-last numeric dates)', () => {
  it('defaults to DMY', () => {
    expect(parseDateIso('03/10/2026')).toBe('2026-10-03');
    expect(parseDateIso('03/10/2026', { order: 'DMY' })).toBe('2026-10-03');
    expect(parseDateIso('13/01/2026')).toBe('2026-01-13');
  });

  it('MDY reads month first', () => {
    expect(parseDateIso('03/10/2026', { order: 'MDY' })).toBe('2026-03-10');
    expect(parseDateIso('12/13/2026', { order: 'MDY' })).toBe('2026-12-13');
  });

  it('never guesses: a part that does not fit the declared order is null', () => {
    expect(parseDateIso('12/13/2026')).toBeNull(); // DMY: сар 13
    expect(parseDateIso('13/12/2026', { order: 'MDY' })).toBeNull();
  });

  it('YMD declares year-first data: year-last strings are rejected, year-first still parse', () => {
    expect(parseDateIso('10.03.2026', { order: 'YMD' })).toBeNull();
    expect(parseDateIso('2026-03-10', { order: 'YMD' })).toBe('2026-03-10');
    expect(parseDateIso('2026 оны 3 дугаар сарын 10', { order: 'YMD' })).toBe('2026-03-10');
  });

  it('year-first is always Y-M-D whatever the order says', () => {
    expect(parseDateIso('2026-03-10', { order: 'MDY' })).toBe('2026-03-10');
    expect(parseDateIso('2026-03-10', { order: 'DMY' })).toBe('2026-03-10');
  });
});

describe('parseDateIso: not a date -> null', () => {
  it.each([
    '',
    '   ',
    'abc',
    '2026',
    '2026-03',
    '03/10',
    '26-03-10', // 2 оронтой жил: хоёрдмол тул таамаглахгүй
    '10.03.26',
    '2026-03-100',
    '2026-03-10-5',
    '12026-03-10',
    'x2026-03-10',
    '2026-03/10', // холимог тусгаарлагч
    '2026-3-5-7',
    '2026-03-10 abc',
    '2026-03-10 12:30 xyz',
    '2026-03-10T25:00',
    '2026-03-10 14:25 PM',
    '2026-03-10T',
    '2026-03-10x',
    '10.03.2026abc',
    '2026 оны сарын 10',
    '2026 оны 3 дугаар сарын',
    '2026 оны 3 дугаар сарын 10 abc',
    '2026 оны 3 дугаар сарын 10 25:00',
    '1,234,567.89',
  ])('%j', (input) => {
    expect(parseDateIso(input)).toBeNull();
  });

  it('rejects non-strings and over-long input', () => {
    expect(parseDateIso(undefined as unknown as string)).toBeNull();
    expect(parseDateIso(20260310 as unknown as string)).toBeNull();
    expect(parseDateIso(`2026-03-10 ${'1'.repeat(DATE_MAX_INPUT_LENGTH)}`)).toBeNull();
  });
});

describe('parseTime', () => {
  it.each([
    ['14:25', '14:25'],
    ['9:05', '09:05'],
    ['00:00', '00:00'],
    ['23:59:59', '23:59:59'],
    ['14:25:07', '14:25:07'],
    ['14:25:07.123', '14:25:07'],
    ['14:25:07,5', '14:25:07'],
    ['2:25 PM', '14:25'],
    ['2:25pm', '14:25'],
    ['2:25 p.m.', '14:25'],
    ['12:30 AM', '00:30'],
    ['12:30 PM', '12:30'],
    ['11:59:59 PM', '23:59:59'],
    ['1:00 am', '01:00'],
    ['at 14:25 hrs', '14:25'],
    ['2026-03-10 09:05:07', '09:05:07'],
    ['2026-03-10T14:25:07Z', '14:25:07'],
    ['10.03.2026 14:25 Хаан', '14:25'],
    ['１４:２５', '14:25'], // NFKC
  ])('%j -> %j', (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  it.each([
    '',
    'abc',
    '24:00',
    '24:00:00',
    '12:60',
    '14:25:60',
    '99:99',
    '1:2',
    ':30',
    '12:30:456',
    '123:45',
    '1:234',
    '0:30 AM',
    '13:30 PM',
    '12:30:45:10',
    '2026-03-10',
    '1000',
  ])('rejects %j', (input) => {
    expect(parseTime(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseTime(undefined as unknown as string)).toBeNull();
    expect(parseTime(1425 as unknown as string)).toBeNull();
  });

  it('stays linear on a 100k-char adversarial string', () => {
    const started = performance.now();
    expect(parseTime('1:'.repeat(50_000))).toBeNull();
    expect(parseTime('12:3'.repeat(25_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('findDates', () => {
  it('finds every supported format in order with index and raw', () => {
    const text = 'Хугацаа 2026.03.10 - 10/09/2026 ба 2026 оны 3 дугаар сарын 10 мөн 2026-12-31T10:00:00Z';
    const found = findDates(text);
    expect(found.map((f) => f.iso)).toEqual(['2026-03-10', '2026-09-10', '2026-03-10', '2026-12-31']);
    for (const f of found) expect(text.slice(f.index, f.index + f.raw.length)).toBe(f.raw);
    expect(found[0]).toEqual({ iso: '2026-03-10', index: 8, raw: '2026.03.10' });
    expect(found[2].raw).toBe('2026 оны 3 дугаар сарын 10');
    expect(found[3].raw).toBe('2026-12-31');
  });

  it('skips calendar-invalid candidates but keeps the valid ones', () => {
    const found = findDates('2026-02-30, 31.04.2026, 2024-02-29, 12 оны 3 сарын 40, 2026 оны 2 сарын 30');
    expect(found.map((f) => f.iso)).toEqual(['2024-02-29']);
  });

  it('does not take pieces of longer digit/separator sequences', () => {
    expect(findDates('ref 12026-03-10')).toEqual([]);
    expect(findDates('2026-03-101')).toEqual([]);
    expect(findDates('1.2026-03-10')).toEqual([]);
    expect(findDates('10.03.2026.5')).toEqual([]);
    expect(findDates('1.234.567,89')).toEqual([]);
    expect(findDates('x 10.03.2026.')).toEqual([{ iso: '2026-03-10', index: 2, raw: '10.03.2026' }]);
  });

  it('honours the order option for year-last dates', () => {
    expect(findDates('03/10/2026')[0].iso).toBe('2026-10-03');
    expect(findDates('03/10/2026', { order: 'MDY' })[0].iso).toBe('2026-03-10');
    expect(findDates('03/10/2026', { order: 'YMD' })).toEqual([]);
    expect(findDates('2026-03-10', { order: 'YMD' })[0].iso).toBe('2026-03-10');
  });

  it('returns sorted, non-overlapping matches on random concatenations of date fragments', () => {
    const fragments = ['2026-03-10', '10.03.2026', '10/03/2026', '2026/3/5', '2026 оны 3 дугаар сарын 10-ны өдөр', '1.', '-', '/', '.', ' ', '2026',
      '03', '10', '2026-02-30', '31.04.2026', 'оны', 'сарын', '12:30', 'x', '2026 оны 3 сарын 10', '99'];
    let seed = 99;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 1 + next(8) }, () => fragments[next(fragments.length)]).join(next(2) ? ' ' : '');
      const found = findDates(text);
      let end = 0;
      for (const f of found) {
        expect(f.index, text).toBeGreaterThanOrEqual(end);
        expect(text.slice(f.index, f.index + f.raw.length)).toBe(f.raw);
        expect(parseDateIso(f.raw, { order: 'DMY' }), text).toBe(f.iso);
        end = f.index + f.raw.length;
      }
    }
    expect(findDates('2026-03-10 2026-03-11').map((f) => f.iso)).toEqual(['2026-03-10', '2026-03-11']);
    expect(findDates('2026 оны 3 сарын 10')).toHaveLength(1);
  });

  it('handles empty and non-string input', () => {
    expect(findDates('')).toEqual([]);
    expect(findDates('   no dates here   ')).toEqual([]);
    expect(findDates(undefined as unknown as string)).toEqual([]);
  });

  it.each([
    ['digits', '1'.repeat(100_000)],
    ['dotted', '1.'.repeat(50_000)],
    ['dates', '2026-03-10 '.repeat(9_000)],
    ['almost dates', '2026-03-1 2026-3-'.repeat(6_000)],
    ['mongolian', '2026 оны '.repeat(11_000)],
    ['spaces', `2026 оны${' '.repeat(100_000)}3 сарын 10`],
  ])('%s within the time budget', (_name, input) => {
    const started = performance.now();
    findDates(input);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
