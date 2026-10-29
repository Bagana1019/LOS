import { describe, expect, it } from 'vitest';
import { parseSweepSeconds } from './expiry.sweeper';

describe('MAKER_CHECKER_SWEEP_SECONDS parsing', () => {
  it('uses 60s when unset or blank', () => {
    expect(parseSweepSeconds(undefined)).toEqual({ seconds: 60 });
    expect(parseSweepSeconds('')).toEqual({ seconds: 60 });
    expect(parseSweepSeconds('   ')).toEqual({ seconds: 60 });
  });
  it('0 disables the sweeper on purpose (no warning from the parser)', () => {
    expect(parseSweepSeconds('0')).toEqual({ seconds: 0 });
  });
  it('an unparsable or negative value falls back to the default with a warning instead of silently disabling expiry', () => {
    for (const bad of ['abc', '-5', 'NaN', 'Infinity', '10s']) {
      const r = parseSweepSeconds(bad);
      expect(r.seconds, bad).toBe(60);
      expect(r.warning, bad).toContain('MAKER_CHECKER_SWEEP_SECONDS');
    }
  });
  it('clamps to 1…3600 seconds so a huge value cannot fire every millisecond (2^31 timer overflow)', () => {
    expect(parseSweepSeconds('0.2').seconds).toBe(1);
    expect(parseSweepSeconds('30').seconds).toBe(30);
    expect(parseSweepSeconds('99999999999').seconds).toBe(3600);
  });
});
