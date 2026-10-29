import { describe, expect, it } from 'vitest';
import { loadErpSyncConfig } from './erp-sync.config';
import { backoffDelayMs } from './retry-policy';

const load = (env: Record<string, string | undefined> = {}) => loadErpSyncConfig(env);

describe('loadErpSyncConfig defaults', () => {
  it('returns the documented defaults for an empty environment', () => {
    expect(load()).toEqual({
      mode: 'mock',
      relay: { enabled: true, intervalMs: 5_000, batchSize: 20, concurrency: 1, leaseMs: 45_000, abortAfterFailures: 3, cooldownMs: 30_000 },
      retry: { baseDelayMs: 30_000, factor: 2, maxDelayMs: 3_600_000, jitterRatio: 0.2, maxAttempts: 48 },
    });
  });

  it('treats explicitly undefined variables as unset', () => {
    const env = {
      INTEGRATION_MODE: undefined, ERP_RELAY_ENABLED: undefined, ERP_RELAY_INTERVAL_MS: undefined, ERP_BATCH_SIZE: undefined, ERP_CONCURRENCY: undefined,
      ERP_TIMEOUT_MS: undefined, ERP_LEASE_MS: undefined, ERP_MAX_ATTEMPTS: undefined, ERP_RETRY_BASE_MS: undefined, ERP_RETRY_MAX_MS: undefined,
      ERP_ABORT_AFTER_FAILURES: undefined, ERP_COOLDOWN_MS: undefined,
    };
    expect(load(env)).toEqual(load());
  });

  it('ignores unrelated variables and does not mutate the environment object', () => {
    const env = { PATH: '/usr/bin', DATABASE_URL: 'postgres://x', ERP_BATCH_SIZE: '7' };
    const copy = { ...env };
    expect(load(env).relay.batchSize).toBe(7);
    expect(env).toEqual(copy);
  });

  it('returns an independent object on every call', () => {
    const a = load();
    const b = load();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.relay).not.toBe(b.relay);
    a.relay.batchSize = 99;
    expect(load().relay.batchSize).toBe(20);
  });
});

describe('loadErpSyncConfig overrides', () => {
  it('parses numeric strings into numbers', () => {
    const c = load({
      ERP_RELAY_INTERVAL_MS: '250', ERP_BATCH_SIZE: '100', ERP_CONCURRENCY: '4', ERP_MAX_ATTEMPTS: '5',
      ERP_RETRY_BASE_MS: '500', ERP_RETRY_MAX_MS: '90000', ERP_ABORT_AFTER_FAILURES: '10',
    });
    expect(c.relay).toMatchObject({ intervalMs: 250, batchSize: 100, concurrency: 4, abortAfterFailures: 10 });
    expect(c.retry).toEqual({ baseDelayMs: 500, factor: 2, maxDelayMs: 90_000, jitterRatio: 0.2, maxAttempts: 5 });
  });

  it('parses the cooldown and exposes the integration mode', () => {
    expect(load({ ERP_COOLDOWN_MS: '90000' }).relay.cooldownMs).toBe(90_000);
    expect(load({ INTEGRATION_MODE: 'real' })).toMatchObject({ mode: 'real' });
  });

  it('requires INTEGRATION_MODE to be set explicitly in production so a forgotten variable cannot silently run the mock', () => {
    expect(() => load({ NODE_ENV: 'production' })).toThrow(/INTEGRATION_MODE must be set explicitly/);
    expect(load({ NODE_ENV: 'production', INTEGRATION_MODE: 'real' }).mode).toBe('real');
    expect(load({ NODE_ENV: 'development' }).mode).toBe('mock');
  });

  it('maps ERP_RELAY_ENABLED to a boolean', () => {
    expect(load({ ERP_RELAY_ENABLED: 'true' }).relay.enabled).toBe(true);
    expect(load({ ERP_RELAY_ENABLED: 'false' }).relay.enabled).toBe(false);
  });

  it('accepts the documented boundary values', () => {
    expect(() => load({ ERP_RELAY_INTERVAL_MS: '200' })).not.toThrow();
    expect(() => load({ ERP_BATCH_SIZE: '1' })).not.toThrow();
    expect(() => load({ ERP_BATCH_SIZE: '500' })).not.toThrow();
    expect(() => load({ ERP_CONCURRENCY: '1' })).not.toThrow();
    expect(() => load({ ERP_CONCURRENCY: '16' })).not.toThrow();
    expect(() => load({ ERP_TIMEOUT_MS: '1000' })).not.toThrow();
    expect(() => load({ ERP_TIMEOUT_MS: '60000' })).not.toThrow();
    expect(() => load({ ERP_LEASE_MS: '5000' })).not.toThrow();
    expect(() => load({ ERP_MAX_ATTEMPTS: '1' })).not.toThrow();
    expect(() => load({ ERP_MAX_ATTEMPTS: '100' })).not.toThrow();
    expect(() => load({ ERP_RETRY_BASE_MS: '100' })).not.toThrow();
    expect(() => load({ ERP_RETRY_MAX_MS: '1000' })).not.toThrow();
    expect(() => load({ ERP_ABORT_AFTER_FAILURES: '1' })).not.toThrow();
  });

  it('feeds the retry settings into backoffDelayMs (30 s base, 1 h cap by default)', () => {
    const { retry } = load();
    expect(backoffDelayMs(retry, 1, () => 0.5)).toBe(30_000);
    expect(backoffDelayMs(retry, 3, () => 0.5)).toBe(120_000);
    expect(backoffDelayMs(retry, 12, () => 1)).toBe(3_600_000);
    const fast = load({ ERP_RETRY_BASE_MS: '100', ERP_RETRY_MAX_MS: '1000' }).retry;
    expect(backoffDelayMs(fast, 1, () => 0.5)).toBe(100);
    expect(backoffDelayMs(fast, 5, () => 1)).toBe(1_000);
  });
});

describe('loadErpSyncConfig lease', () => {
  it('defaults to the HTTP timeout plus 30 seconds', () => {
    expect(load().relay.leaseMs).toBe(45_000);
    expect(load({ ERP_TIMEOUT_MS: '1000' }).relay.leaseMs).toBe(31_000);
    expect(load({ ERP_TIMEOUT_MS: '60000' }).relay.leaseMs).toBe(90_000);
  });

  it('keeps an explicit lease that is long enough', () => {
    expect(load({ ERP_LEASE_MS: '120000' }).relay.leaseMs).toBe(120_000);
    expect(load({ ERP_LEASE_MS: '45000' }).relay.leaseMs).toBe(45_000);
  });

  it('raises a too-short explicit lease to timeout + 30 s so another worker cannot steal an in-flight delivery', () => {
    expect(load({ ERP_LEASE_MS: '5000' }).relay.leaseMs).toBe(45_000);
    expect(load({ ERP_LEASE_MS: '44999' }).relay.leaseMs).toBe(45_000);
    expect(load({ ERP_LEASE_MS: '20000', ERP_TIMEOUT_MS: '30000' }).relay.leaseMs).toBe(60_000);
  });

  it('never yields a lease shorter than timeout + 30 s for any timeout/lease combination', () => {
    for (const timeout of [1_000, 5_000, 15_000, 59_999, 60_000]) {
      for (const lease of [undefined, 5_000, 20_000, 44_999, 45_000, 60_000, 89_999, 90_000, 500_000]) {
        const env: Record<string, string | undefined> = { ERP_TIMEOUT_MS: String(timeout), ERP_LEASE_MS: lease === undefined ? undefined : String(lease) };
        const leaseMs = load(env).relay.leaseMs;
        expect(leaseMs, `timeout=${timeout} lease=${lease}`).toBeGreaterThanOrEqual(timeout + 30_000);
        expect(leaseMs).toBe(Math.max(lease ?? 0, timeout + 30_000));
      }
    }
  });
});

describe('loadErpSyncConfig INTEGRATION_MODE', () => {
  it('exposes mock mode explicitly', () => {
    expect(load({ INTEGRATION_MODE: 'mock' }).mode).toBe('mock');
  });

  it('defaults to mock when INTEGRATION_MODE is not set', () => {
    expect(load({}).mode).toBe('mock');
  });

  it('exposes real mode explicitly and does not let any other setting flip it', () => {
    expect(load({ INTEGRATION_MODE: 'real', ERP_RELAY_ENABLED: 'false', ERP_BATCH_SIZE: '1', ERP_LEASE_MS: '60000' }).mode).toBe('real');
  });

  it.each(['MOCK', 'Real', 'sandbox', 'prod', ' mock', 'mock ', '', 'true', '1'])('rejects the unsupported INTEGRATION_MODE %j', (mode) => {
    expect(() => load({ INTEGRATION_MODE: mode })).toThrow(/invalid ERP sync config: INTEGRATION_MODE/);
  });
});

describe('loadErpSyncConfig invalid values', () => {
  it.each([
    ['ERP_RELAY_ENABLED', ['yes', 'TRUE', 'True', '1', '0', '', 'on']],
    ['ERP_RELAY_INTERVAL_MS', ['199', '0', '-5', 'abc', '1.5', '200.5', 'NaN']],
    ['ERP_BATCH_SIZE', ['0', '501', '-1', '1.5', 'abc', '', 'NaN']],
    ['ERP_CONCURRENCY', ['0', '17', '-1', '2.5', 'abc']],
    ['ERP_TIMEOUT_MS', ['999', '60001', '0', '-1', '15000.5', 'abc']],
    ['ERP_LEASE_MS', ['4999', '0', '-1', '5000.5', 'abc']],
    ['ERP_MAX_ATTEMPTS', ['0', '101', '-1', '1.5', 'abc']],
    ['ERP_RETRY_BASE_MS', ['99', '0', '-1', '100.5', 'abc']],
    ['ERP_RETRY_MAX_MS', ['999', '0', '-1', '1000.5', 'abc']],
    ['ERP_ABORT_AFTER_FAILURES', ['0', '-1', '1.5', 'abc']],
  ] as const)('%s rejects out-of-range or malformed values', (key, values) => {
    for (const value of values) {
      expect(() => load({ [key]: value }), `${key}=${JSON.stringify(value)}`).toThrow(`invalid ERP sync config: ${key}`);
    }
  });

  it('rejects non-finite numbers', () => {
    expect(() => load({ ERP_BATCH_SIZE: 'Infinity' })).toThrow(/ERP_BATCH_SIZE/);
    expect(() => load({ ERP_RELAY_INTERVAL_MS: 'Infinity' })).toThrow(/ERP_RELAY_INTERVAL_MS/);
  });

  it('names every offending variable in the error message but never echoes the values', () => {
    let message = '';
    try { load({ ERP_BATCH_SIZE: '9999', ERP_CONCURRENCY: '0', ERP_TIMEOUT_MS: 'secret-value-123' }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('invalid ERP sync config');
    expect(message).toContain('ERP_BATCH_SIZE');
    expect(message).toContain('ERP_CONCURRENCY');
    expect(message).toContain('ERP_TIMEOUT_MS');
    expect(message).not.toContain('secret-value-123');
    expect(message).not.toContain('9999');
  });

  it('throws a plain Error (startup failure) rather than returning a partial config', () => {
    expect(() => load({ ERP_BATCH_SIZE: '0' })).toThrow(Error);
  });
});
