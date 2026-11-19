import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from './errors';
import { assertRealIntegrationEnv, isProduction, requireEnv } from './integration-env';

const PROD = { NODE_ENV: 'production' } as const;
const NAMES = ['X_URL', 'X_PASS'];
const FULL = { ...PROD, INTEGRATION_MODE: 'real', X_URL: 'https://x', X_PASS: 'p-secret' };

describe('isProduction', () => {
  it.each([['production'], ['Production'], [' PRODUCTION ']])('is true for %j (fail closed)', (v) => expect(isProduction({ NODE_ENV: v })).toBe(true));
  it.each([[undefined], [''], ['development'], ['test'], ['staging']])('is false for %j', (v) => expect(isProduction({ NODE_ENV: v })).toBe(false));
});

describe('requireEnv', () => {
  it('returns the requested values untouched', () => {
    expect(requireEnv('x', NAMES, { X_URL: ' u ', X_PASS: 'p' })).toEqual({ X_URL: ' u ', X_PASS: 'p' });
  });
  it.each([['unset', undefined], ['empty', ''], ['whitespace', '   ']])('reports a %s variable as missing by name only', (_l, value) => {
    try {
      requireEnv('x', NAMES, { X_URL: 'ok-value', X_PASS: value });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationNotConfiguredError);
      expect((e as IntegrationNotConfiguredError).missing).toEqual(['X_PASS']);
      expect((e as Error).message).not.toContain('ok-value');
    }
  });
});

describe('assertRealIntegrationEnv (phase 5: refuse to start in production + real on missing config)', () => {
  it('does nothing outside production, even in real mode with missing env (per-call fail-closed stays)', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { INTEGRATION_MODE: 'real' })).not.toThrow();
    expect(() => assertRealIntegrationEnv('x', NAMES, { NODE_ENV: 'staging', INTEGRATION_MODE: 'real' })).not.toThrow();
  });
  it('does nothing in production with an explicit mock', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { ...PROD, INTEGRATION_MODE: 'mock' })).not.toThrow();
  });
  it('passes in production + real when everything is set', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, FULL)).not.toThrow();
  });
  it('refuses in production + real naming the missing variable, never a value', () => {
    try {
      assertRealIntegrationEnv('x', NAMES, { ...FULL, X_PASS: '' });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationNotConfiguredError);
      expect((e as Error).message).toContain('X_PASS');
      expect((e as Error).message).not.toContain('https://x');
    }
  });
  it('still refuses an unset INTEGRATION_MODE in production (no silent mock fallback)', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { ...PROD })).toThrow(/INTEGRATION_MODE is not set/);
  });
});
