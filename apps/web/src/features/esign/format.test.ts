import { describe, expect, it } from 'vitest';
import { formatUlaanbaatar } from './format';

describe('formatUlaanbaatar', () => {
  it('UTC+8 цагаар YYYY-MM-DD HH:mm:ss', () => {
    expect(formatUlaanbaatar('2026-10-28T06:05:09.000Z')).toBe('2026-10-28 14:05:09');
  });
  it('шөнө дундыг 24:00 биш 00:00 гэж, өдөр шилжихийг зөв харуулна', () => {
    expect(formatUlaanbaatar('2026-12-31T16:00:00.000Z')).toBe('2027-01-01 00:00:00');
    expect(formatUlaanbaatar('2026-12-31T15:59:59.000Z')).toBe('2026-12-31 23:59:59');
  });
  it('буруу огноог шууд буцаана', () => {
    expect(formatUlaanbaatar('xx')).toBe('xx');
  });
});
