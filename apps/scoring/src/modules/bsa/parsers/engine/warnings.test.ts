// WarningCollector — кодоор хязгаарлах, нэг удаа, тоолуур; PII-гүй мессеж. SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { PARSE_WARNING, WarningCollector } from './warnings';

describe('WarningCollector', () => {
  it('keeps warnings in order with page and line', () => {
    const w = new WarningCollector(10);
    w.add(PARSE_WARNING.UNPARSED_ROW, 'a', 2, 7);
    w.add(PARSE_WARNING.REVERSED_ORDER, 'b');
    expect(w.finish()).toEqual([
      { code: 'UNPARSED_ROW', message: 'a', page: 2, line: 7 },
      { code: 'REVERSED_ORDER', message: 'b' },
    ]);
  });

  it('caps each code separately and reports the real total in WARNINGS_TRUNCATED; count() stays exact', () => {
    const w = new WarningCollector(3);
    for (let i = 0; i < 10; i++) w.add(PARSE_WARNING.UNPARSED_ROW, `row ${i}`);
    w.add(PARSE_WARNING.TIME_MISSING, 'once');
    expect(w.count(PARSE_WARNING.UNPARSED_ROW)).toBe(10);
    expect(w.count(PARSE_WARNING.TIME_MISSING)).toBe(1);
    expect(w.count(PARSE_WARNING.REVERSED_ORDER)).toBe(0);
    const out = w.finish();
    expect(out.filter((x) => x.code === 'UNPARSED_ROW')).toHaveLength(3);
    expect(out.filter((x) => x.code === 'TIME_MISSING')).toHaveLength(1);
    const trunc = out.filter((x) => x.code === 'WARNINGS_TRUNCATED');
    expect(trunc).toHaveLength(1);
    expect(trunc[0].message).toContain('10 warnings in total');
  });

  it('addOnce records a code once but still counts the first', () => {
    const w = new WarningCollector(10);
    w.addOnce(PARSE_WARNING.DIRECTION_SWAPPED, 'x');
    w.addOnce(PARSE_WARNING.DIRECTION_SWAPPED, 'y');
    expect(w.finish()).toHaveLength(1);
    expect(w.count(PARSE_WARNING.DIRECTION_SWAPPED)).toBe(1);
  });

  it('codes are unique strings equal to their keys', () => {
    for (const [k, v] of Object.entries(PARSE_WARNING)) expect(v).toBe(k);
    expect(new Set(Object.values(PARSE_WARNING)).size).toBe(Object.keys(PARSE_WARNING).length);
  });
});
