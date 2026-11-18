import { describe, expect, it } from 'vitest';
import { assertInternalAuthSecret, MIN_INTERNAL_AUTH_SECRET_LENGTH } from './internal-secret';

const GOOD = 'a'.repeat(MIN_INTERNAL_AUTH_SECRET_LENGTH);
const messageOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};

describe('assertInternalAuthSecret (H2: INTERNAL_AUTH_SECRET is mandatory in production)', () => {
  it('uses a minimum length of 16 characters', () => {
    expect(MIN_INTERNAL_AUTH_SECRET_LENGTH).toBe(16);
  });

  describe('NODE_ENV=production', () => {
    const prod = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'production', ...extra });

    it('accepts a secret of exactly the minimum length', () => {
      expect(() => assertInternalAuthSecret(prod({ INTERNAL_AUTH_SECRET: GOOD }))).not.toThrow();
    });

    it('accepts a long secret', () => {
      expect(() => assertInternalAuthSecret(prod({ INTERNAL_AUTH_SECRET: 'x'.repeat(64) }))).not.toThrow();
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['whitespace only', '                '], // 16 blanks: long enough, but carries no secret
      ['a single blank', ' '],
    ])('refuses to start when the secret is %s', (_label, value) => {
      const msg = messageOf(() => assertInternalAuthSecret(prod({ INTERNAL_AUTH_SECRET: value })));
      expect(msg).toContain('INTERNAL_AUTH_SECRET');
      expect(msg).toContain('production');
    });

    it('refuses a secret one character shorter than the minimum, without echoing it', () => {
      const tooShort = 'S3cr3t-zzzzzzzzzzzzzzzz'.slice(0, MIN_INTERNAL_AUTH_SECRET_LENGTH - 1);
      expect(tooShort).toHaveLength(MIN_INTERNAL_AUTH_SECRET_LENGTH - 1);
      const msg = messageOf(() => assertInternalAuthSecret(prod({ INTERNAL_AUTH_SECRET: tooShort })));
      expect(msg).toContain('INTERNAL_AUTH_SECRET');
      expect(msg).not.toContain(tooShort);
    });

    it('does not count surrounding whitespace towards the minimum length', () => {
      expect(() => assertInternalAuthSecret(prod({ INTERNAL_AUTH_SECRET: `   ${'a'.repeat(MIN_INTERNAL_AUTH_SECRET_LENGTH - 1)}   ` }))).toThrow(/INTERNAL_AUTH_SECRET/);
    });

    it('treats NODE_ENV case-insensitively and ignores surrounding blanks (fail closed)', () => {
      for (const nodeEnv of ['Production', 'PRODUCTION', ' production ']) {
        expect(() => assertInternalAuthSecret({ NODE_ENV: nodeEnv })).toThrow(/INTERNAL_AUTH_SECRET/);
      }
    });
  });

  describe('non-production (behaviour stays as before)', () => {
    it.each([
      ['NODE_ENV unset', undefined],
      ['NODE_ENV empty', ''],
      ['development', 'development'],
      ['test', 'test'],
      ['staging', 'staging'],
    ])('does not require the secret when %s', (_label, nodeEnv) => {
      expect(() => assertInternalAuthSecret({ NODE_ENV: nodeEnv })).not.toThrow();
      expect(() => assertInternalAuthSecret({ NODE_ENV: nodeEnv, INTERNAL_AUTH_SECRET: '' })).not.toThrow();
    });

    it('does not enforce a minimum length outside production (dev secrets may be short)', () => {
      expect(() => assertInternalAuthSecret({ NODE_ENV: 'development', INTERNAL_AUTH_SECRET: 'dev' })).not.toThrow();
    });
  });

  it('reads process.env by default', () => {
    const before = { nodeEnv: process.env.NODE_ENV, secret: process.env.INTERNAL_AUTH_SECRET };
    try {
      process.env.NODE_ENV = 'production';
      process.env.INTERNAL_AUTH_SECRET = '';
      expect(() => assertInternalAuthSecret()).toThrow(/INTERNAL_AUTH_SECRET/);
      process.env.INTERNAL_AUTH_SECRET = GOOD;
      expect(() => assertInternalAuthSecret()).not.toThrow();
    } finally {
      if (before.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before.nodeEnv;
      if (before.secret === undefined) delete process.env.INTERNAL_AUTH_SECRET; else process.env.INTERNAL_AUTH_SECRET = before.secret;
    }
  });
});

describe('assertInternalAuthSecret rejects public placeholder secrets in production (review M2)', () => {
  it.each([['dev-internal-secret-change-me'], ['  dev-internal-secret-change-me  '], ['my-secret-CHANGE-ME-please'], ['changeme-changeme-changeme']])('refuses %j', (secret) => {
    expect(() => assertInternalAuthSecret({ NODE_ENV: 'production', INTERNAL_AUTH_SECRET: secret })).toThrow(/placeholder/);
  });

  it('never echoes the refused secret', () => {
    expect(messageOf(() => assertInternalAuthSecret({ NODE_ENV: 'production', INTERNAL_AUTH_SECRET: 'dev-internal-secret-change-me' }))).not.toContain('dev-internal-secret');
  });

  it('still accepts a random secret and ignores placeholders outside production', () => {
    expect(() => assertInternalAuthSecret({ NODE_ENV: 'production', INTERNAL_AUTH_SECRET: 'q7Zp3kLm9VxT2rWs8YbN' })).not.toThrow();
    expect(() => assertInternalAuthSecret({ NODE_ENV: 'development', INTERNAL_AUTH_SECRET: 'dev-internal-secret-change-me' })).not.toThrow();
  });
});
