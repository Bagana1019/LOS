import { describe, expect, it } from 'vitest';
import {
  dateInputToIso, formatCountdown, formatDate, formatDateTime, formatDuration, formatMnt, formatMntCompact, formatNumber, formatPercent, formatTime, isoToDateInput, mnDateKey, mnStartOfDayIso,
  percentToRate, rateToPercent,
} from './format';

describe('number and money formatting', () => {
  it('formats integers with thousands separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0)).toBe('0');
  });
  it('formatMnt shows 2 decimals only for fractional amounts', () => {
    expect(formatMnt(1234567)).toBe('1,234,567₮');
    expect(formatMnt(100280.45)).toBe('100,280.45₮');
    expect(formatMnt(1203365.4)).toBe('1,203,365.40₮');
    expect(formatMnt(0)).toBe('0₮');
  });
  it('shows an em dash for missing or non-finite values', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatNumber(v)).toBe('—');
      expect(formatMnt(v)).toBe('—');
      expect(formatPercent(v)).toBe('—');
      expect(formatDuration(v)).toBe('—');
      expect(formatMntCompact(v)).toBe('—');
    }
  });
  it('formatMntCompact uses Mongolian magnitude words', () => {
    expect(formatMntCompact(950)).toBe('950');
    expect(formatMntCompact(250_000)).toBe('250 мянга');
    expect(formatMntCompact(1_500_000)).toBe('1.5 сая');
    expect(formatMntCompact(2_000_000_000)).toBe('2 тэрбум');
  });
  it('formatPercent trims trailing zeros', () => {
    expect(formatPercent(0.55)).toBe('55%');
    expect(formatPercent(0.2399)).toBe('23.99%');
    expect(formatPercent(0.24)).toBe('24%');
    expect(formatPercent(0.675, 1)).toBe('67.5%');
    expect(formatPercent(0.8148, 1)).toBe('81.5%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
  });
  it('percent <-> rate conversion is exact for typical inputs', () => {
    expect(percentToRate(2.5)).toBe(0.025);
    expect(percentToRate(24)).toBe(0.24);
    expect(percentToRate(0.07)).toBe(0.0007);
    expect(rateToPercent(0.025)).toBe(2.5);
    expect(rateToPercent(0.29)).toBe(29);
    for (const p of [0, 1, 2, 2.5, 10.75, 55, 100]) expect(rateToPercent(percentToRate(p))).toBe(p);
  });
});

describe('Ulaanbaatar time (UTC+8)', () => {
  it('formats date and time in Asia/Ulaanbaatar regardless of the runtime zone', () => {
    expect(formatDateTime('2026-10-28T08:05:00Z')).toBe('2026-10-28 16:05');
    expect(formatDate('2026-10-28T08:05:00Z')).toBe('2026-10-28');
    expect(formatTime('2026-10-28T08:05:00Z')).toBe('16:05');
    expect(formatDateTime('2026-10-28T08:05:00+08:00')).toBe('2026-10-28 08:05');
  });
  it('rolls over the date at UB midnight, not UTC midnight', () => {
    expect(formatDateTime('2026-10-27T17:00:00Z')).toBe('2026-10-28 01:00');
    expect(formatDateTime('2026-10-27T15:59:59Z')).toBe('2026-10-27 23:59');
    expect(mnDateKey(new Date('2026-10-27T16:00:00Z'))).toBe('2026-10-28');
  });
  it('returns an em dash for empty or invalid dates', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatTime('not-a-date')).toBe('—');
    expect(isoToDateInput(undefined)).toBe('');
  });
  it('mnStartOfDayIso gives the UB start of day with +08:00', () => {
    // 2026-10-28T20:00Z is already 04:00 on 2026-10-29 in Ulaanbaatar
    expect(mnStartOfDayIso(new Date('2026-10-28T20:00:00Z'))).toBe('2026-10-29T00:00:00+08:00');
    expect(mnStartOfDayIso(new Date('2026-10-28T20:00:00Z'), 7)).toBe('2026-10-22T00:00:00+08:00');
    expect(mnStartOfDayIso(new Date('2026-10-28T03:00:00Z'), 0)).toBe('2026-10-28T00:00:00+08:00');
    expect(mnStartOfDayIso(new Date('2026-03-02T10:00:00Z'), 30)).toBe('2026-01-31T00:00:00+08:00');
  });
  it('date input <-> ISO edges', () => {
    expect(dateInputToIso('2026-10-01', 'start')).toBe('2026-10-01T00:00:00+08:00');
    expect(dateInputToIso('2026-10-28', 'end')).toBe('2026-10-28T23:59:59.999+08:00');
    expect(isoToDateInput('2026-10-28T23:59:59.999+08:00')).toBe('2026-10-28');
    expect(isoToDateInput('2026-10-28T16:30:00Z')).toBe('2026-10-29');
  });
});

describe('durations and countdowns', () => {
  it('formatDuration', () => {
    expect(formatDuration(45)).toBe('45 сек');
    expect(formatDuration(60)).toBe('1 мин');
    expect(formatDuration(95)).toBe('1 мин 35 сек');
    expect(formatDuration(3720)).toBe('1 цаг 2 мин');
    expect(formatDuration(7200)).toBe('2 цаг');
    expect(formatDuration(-5)).toBe('0 сек');
    expect(formatDuration(47.6)).toBe('48 сек');
  });
  it('formatCountdown pads and never goes negative', () => {
    expect(formatCountdown(125)).toBe('02:05');
    expect(formatCountdown(59.2)).toBe('01:00');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-3)).toBe('00:00');
    expect(formatCountdown(1800)).toBe('30:00');
  });
});
