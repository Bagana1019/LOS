// BSA-BR-3: шинжилгээний хугацааны цэвэр функцүүд (UTC огноо, I/O үгүй).
import { describe, expect, it } from 'vitest';
import { addDays, addMonths, defaultPeriodMonths, intersect, isAllowedMonths, isMonthEnd, resolvePeriod, validExplicitPeriod, windowStart } from './period';

const SETTINGS = { allowedPeriodMonths: [3, 6, 12], minStatementMonths: 6 };

describe('date helpers', () => {
  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('isMonthEnd', () => {
    expect(isMonthEnd('2026-06-30')).toBe(true);
    expect(isMonthEnd('2026-02-28')).toBe(true);
    expect(isMonthEnd('2028-02-28')).toBe(false);
    expect(isMonthEnd('2028-02-29')).toBe(true);
    expect(isMonthEnd('2026-06-29')).toBe(false);
  });

  it('addMonths clamps the day to the month length', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-01-15', -13)).toBe('2024-12-15');
  });

  it('windowStart: N whole calendar months for a month-end, otherwise N months minus a day', () => {
    expect(windowStart('2026-06-30', 3)).toBe('2026-04-01');
    expect(windowStart('2026-02-28', 1)).toBe('2026-02-01');
    expect(windowStart('2026-09-30', 6)).toBe('2026-04-01');
    expect(windowStart('2026-06-15', 3)).toBe('2026-03-16');
    expect(windowStart('2026-05-31', 12)).toBe('2025-06-01');
  });

  it('intersect', () => {
    expect(intersect({ from: '2026-01-01', to: '2026-06-30' }, { from: '2026-04-01', to: '2026-12-31' })).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(intersect({ from: '2026-01-01', to: '2026-03-31' }, { from: '2026-04-01', to: '2026-12-31' })).toBeNull();
    expect(intersect({ from: '2026-04-01', to: '2026-04-01' }, { from: '2026-04-01', to: '2026-04-01' })).toEqual({ from: '2026-04-01', to: '2026-04-01' });
  });
});

describe('settings helpers', () => {
  it('isAllowedMonths follows the configured list', () => {
    expect(isAllowedMonths(6, SETTINGS)).toBe(true);
    expect(isAllowedMonths(5, SETTINGS)).toBe(false);
    expect(isAllowedMonths(3.5, SETTINGS)).toBe(false);
  });

  it('defaultPeriodMonths: the smallest allowed value >= minStatementMonths, else the largest', () => {
    expect(defaultPeriodMonths(SETTINGS)).toBe(6);
    expect(defaultPeriodMonths({ allowedPeriodMonths: [12, 3, 6], minStatementMonths: 4 })).toBe(6);
    expect(defaultPeriodMonths({ allowedPeriodMonths: [3, 6], minStatementMonths: 24 })).toBe(6);
  });

  it('validExplicitPeriod rejects reversed, partial and impossible dates', () => {
    expect(validExplicitPeriod('2026-01-01', '2026-01-01')).toBe(true);
    expect(validExplicitPeriod('2026-02-01', '2026-01-01')).toBe(false);
    expect(validExplicitPeriod(null, '2026-01-01')).toBe(false);
    expect(validExplicitPeriod('2026-02-30', '2026-03-01')).toBe(false);
  });
});

describe('resolvePeriod', () => {
  const coverage = { from: '2026-01-01', to: '2026-09-30' };

  it('MONTHS: a window that ends at the coverage end', () => {
    const p = resolvePeriod({ periodMonths: 6, periodFrom: null, periodTo: null }, coverage, SETTINGS);
    expect(p).toMatchObject({ from: '2026-04-01', to: '2026-09-30', months: 6, mode: 'MONTHS', requestedMonths: 6, clamped: false, warnings: [] });
  });

  it('MONTHS: clamped to the coverage with a warning when the statements are shorter', () => {
    const p = resolvePeriod({ periodMonths: 12, periodFrom: null, periodTo: null }, coverage, SETTINGS);
    expect(p).toMatchObject({ from: '2026-01-01', to: '2026-09-30', months: 9, requestedMonths: 12, clamped: true });
    expect(p?.warnings.map((w) => w.code)).toEqual(['PERIOD_CLAMPED']);
  });

  it('AUTO: no request uses the default months', () => {
    const p = resolvePeriod({ periodMonths: null, periodFrom: null, periodTo: null }, coverage, SETTINGS);
    expect(p).toMatchObject({ from: '2026-04-01', to: '2026-09-30', months: 6, mode: 'AUTO', requestedMonths: 6 });
  });

  it('EXPLICIT: intersected with the coverage; an outside range falls back to the whole coverage with a warning', () => {
    const inside = resolvePeriod({ periodMonths: null, periodFrom: '2026-03-01', periodTo: '2026-05-31' }, coverage, SETTINGS);
    expect(inside).toMatchObject({ from: '2026-03-01', to: '2026-05-31', months: 3, mode: 'EXPLICIT', clamped: false, warnings: [] });
    const partly = resolvePeriod({ periodMonths: null, periodFrom: '2025-10-01', periodTo: '2026-03-31' }, coverage, SETTINGS);
    expect(partly).toMatchObject({ from: '2026-01-01', to: '2026-03-31', clamped: true });
    expect(partly?.warnings.map((w) => w.code)).toEqual(['PERIOD_CLAMPED']);
    const outside = resolvePeriod({ periodMonths: null, periodFrom: '2020-01-01', periodTo: '2020-12-31' }, coverage, SETTINGS);
    expect(outside).toMatchObject({ from: '2026-01-01', to: '2026-09-30', mode: 'EXPLICIT', clamped: true });
    expect(outside?.warnings.map((w) => w.code)).toEqual(['PERIOD_OUTSIDE_COVERAGE']);
  });

  it('a request with both months and a range is treated as months (the range is ignored)', () => {
    const p = resolvePeriod({ periodMonths: 3, periodFrom: '2026-01-01', periodTo: '2026-02-01' }, coverage, SETTINGS);
    expect(p).toMatchObject({ mode: 'MONTHS', from: '2026-07-01', to: '2026-09-30', months: 3 });
  });

  it('no coverage means nothing to calculate', () => {
    expect(resolvePeriod({ periodMonths: 3, periodFrom: null, periodTo: null }, null, SETTINGS)).toBeNull();
  });
});
