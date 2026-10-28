import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './portal.config';

const prodEnv = {
  NODE_ENV: 'production',
  INTEGRATION_MODE: 'real',
  REDIS_URL: 'redis://redis:6379',
  PORTAL_JWT_SECRET: 'j'.repeat(40),
  PORTAL_HASH_SECRET: 'h'.repeat(40),
  PORTAL_CORS_ORIGINS: 'https://app.example.mn',
};

describe('loadConfig', () => {
  it('has safe development defaults (mock integrations, memory store, port 4007, Ulaanbaatar time)', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ env: 'development', port: 4007, integrationMode: 'mock', timezone: 'Asia/Ulaanbaatar', trustProxy: 0 });
    expect(c.store.kind).toBe('memory');
    expect(c.internalTimeoutMs).toBe(3000); // CLAUDE.md §3.1: дотоод timeout 3с
    expect(c.auth).toMatchObject({ accessTtlSec: 600, otpTtlSec: 300, otpMaxAttempts: 5 });
  });

  it('uses redis when REDIS_URL is present', () => {
    expect(loadConfig({ REDIS_URL: 'redis://localhost:6379' }).store).toEqual({ kind: 'redis', redisUrl: 'redis://localhost:6379' });
  });

  it('accepts a complete production configuration', () => {
    const c = loadConfig(prodEnv);
    expect(c.store.kind).toBe('redis');
    expect(c.auth.jwtSecret).toBe('j'.repeat(40));
    expect(c.cors.origins).toEqual(['https://app.example.mn']);
  });

  it.each([
    ['missing JWT secret', { PORTAL_JWT_SECRET: undefined }],
    ['missing hash secret', { PORTAL_HASH_SECRET: undefined }],
    ['same secret for jwt and hash', { PORTAL_HASH_SECRET: 'j'.repeat(40) }],
    ['short secret', { PORTAL_JWT_SECRET: 'short' }],
    ['mock integrations', { INTEGRATION_MODE: 'mock' }],
    ['memory store', { PORTAL_STORE: 'memory' }],
    ['mock otp code', { PORTAL_MOCK_OTP_CODE: '123456' }],
    ['http cors origin', { PORTAL_CORS_ORIGINS: 'http://app.example.mn' }],
  ])('refuses to start in production with %s', (_name, patch) => {
    expect(() => loadConfig({ ...prodEnv, ...patch })).toThrow(ConfigError);
  });

  it('never allows a wildcard CORS origin', () => {
    expect(() => loadConfig({ PORTAL_CORS_ORIGINS: '*' })).toThrow(ConfigError);
  });

  it('rejects out-of-range numbers and malformed values', () => {
    expect(() => loadConfig({ PORTAL_BFF_PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORTAL_ACCESS_TTL_SEC: '5' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORTAL_MOCK_OTP_CODE: '12' })).toThrow(ConfigError);
    expect(() => loadConfig({ ORIGINATION_URL: 'not a url' })).toThrow(ConfigError);
  });

  it('error messages never echo secret values', () => {
    try {
      loadConfig({ ...prodEnv, PORTAL_JWT_SECRET: 'secret-but-too-short' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-but-too-short');
      return;
    }
    throw new Error('expected failure');
  });
});
