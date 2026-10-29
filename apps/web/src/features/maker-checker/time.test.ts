import { describe, expect, it } from 'vitest';
import { mn } from '@los/ui';
import { URGENT_MS, formatDateTime, formatRemaining, isUrgent, msUntil } from './time';

const NOW = Date.parse('2026-10-28T06:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('msUntil', () => {
  it('is positive for the future and negative for the past', () => {
    expect(msUntil(at(5 * MIN), NOW)).toBe(5 * MIN);
    expect(msUntil(at(-MIN), NOW)).toBe(-MIN);
  });
});

describe('isUrgent', () => {
  it('is true for PENDING with less than 4 hours left', () => {
    expect(isUrgent('PENDING', at(3 * HOUR + 59 * MIN), NOW)).toBe(true);
    expect(isUrgent('PENDING', at(MIN), NOW)).toBe(true);
  });
  it('is true for PENDING that is already past', () => {
    expect(isUrgent('PENDING', at(0), NOW)).toBe(true);
    expect(isUrgent('PENDING', at(-HOUR), NOW)).toBe(true);
  });
  it('is false at exactly 4 hours and beyond', () => {
    expect(URGENT_MS).toBe(4 * HOUR);
    expect(isUrgent('PENDING', at(4 * HOUR), NOW)).toBe(false);
    expect(isUrgent('PENDING', at(48 * HOUR), NOW)).toBe(false);
  });
  it('is never true for decided requests', () => {
    for (const s of ['APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']) expect(isUrgent(s, at(-HOUR), NOW)).toBe(false);
  });
});

describe('formatRemaining', () => {
  it('says the time has passed for zero, negative and NaN', () => {
    expect(formatRemaining(0)).toBe(mn['maker_checker.expires.past']);
    expect(formatRemaining(-5 * MIN)).toBe(mn['maker_checker.expires.past']);
    expect(formatRemaining(Number.NaN)).toBe(mn['maker_checker.expires.past']);
  });
  it('shows minutes under an hour, rounding up and never 0', () => {
    expect(formatRemaining(9 * MIN)).toBe('9 мин үлдсэн');
    expect(formatRemaining(30_000)).toBe('1 мин үлдсэн');
    expect(formatRemaining(59 * MIN + 1)).toBe('60 мин үлдсэн');
  });
  it('shows hours and minutes under a day', () => {
    expect(formatRemaining(HOUR)).toBe('1 ц 0 мин үлдсэн');
    expect(formatRemaining(2 * HOUR + 15 * MIN)).toBe('2 ц 15 мин үлдсэн');
    expect(formatRemaining(23 * HOUR + 59 * MIN)).toBe('23 ц 59 мин үлдсэн');
  });
  it('shows days and hours from a day on', () => {
    expect(formatRemaining(24 * HOUR)).toBe('1 өдөр 0 ц үлдсэн');
    expect(formatRemaining(3 * 24 * HOUR + 4 * HOUR + 30 * MIN)).toBe('3 өдөр 4 ц үлдсэн');
  });
});

describe('formatDateTime', () => {
  it('renders Ulaanbaatar time (UTC+8) as YYYY-MM-DD HH:mm', () => {
    expect(formatDateTime('2026-10-28T06:05:00.000Z')).toBe('2026-10-28 14:05');
  });
  it('rolls over to the next day and uses 24h clock at midnight', () => {
    expect(formatDateTime('2026-12-31T16:00:00.000Z')).toBe('2027-01-01 00:00');
    expect(formatDateTime('2026-03-01T15:59:00.000Z')).toBe('2026-03-01 23:59');
  });
  it('returns empty for missing values and the input itself for garbage', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});
