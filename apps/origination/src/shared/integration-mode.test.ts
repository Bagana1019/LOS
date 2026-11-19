import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRealIntegrationEnv, IntegrationNotConfiguredError, isProduction, requireEnv, resolveIntegrationMode, unsetIfBlank } from './integration-mode';

const messageOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};
const PROD = { NODE_ENV: 'production' } as const;

afterEach(() => { vi.unstubAllEnvs(); });

describe('isProduction', () => {
  it.each([['production'], ['Production'], [' PRODUCTION ']])('is true for NODE_ENV=%j (fail closed)', (nodeEnv) => {
    expect(isProduction({ NODE_ENV: nodeEnv })).toBe(true);
  });
  it.each([[undefined], [''], ['development'], ['test'], ['staging']])('is false for NODE_ENV=%j', (nodeEnv) => {
    expect(isProduction({ NODE_ENV: nodeEnv })).toBe(false);
  });
});

describe('unsetIfBlank', () => {
  it.each([[undefined], [''], ['   '], ['\t\n']])('maps %j to undefined', (value) => {
    expect(unsetIfBlank(value)).toBeUndefined();
  });
  it('keeps a real value exactly as written (no trimming of secrets)', () => {
    expect(unsetIfBlank(' real ')).toBe(' real ');
    expect(unsetIfBlank('0')).toBe('0');
  });
});

describe('resolveIntegrationMode (H3: production must choose explicitly)', () => {
  describe('outside production the mock stays the default', () => {
    it.each([
      ['empty env', {}],
      ['NODE_ENV=development', { NODE_ENV: 'development' }],
      ['NODE_ENV=test', { NODE_ENV: 'test' }],
      ['NODE_ENV empty', { NODE_ENV: '' }],
      ['INTEGRATION_MODE empty', { INTEGRATION_MODE: '' }],
      ['INTEGRATION_MODE whitespace', { INTEGRATION_MODE: '   ' }],
    ])('returns mock for %s', (_label, env) => {
      expect(resolveIntegrationMode('qpay', env)).toBe('mock');
    });
  });

  describe('in production', () => {
    it('refuses to fall back to mock when INTEGRATION_MODE is not set, naming the integration', () => {
      const msg = messageOf(() => resolveIntegrationMode('core-loan', { ...PROD }));
      expect(msg).toMatch(/INTEGRATION_MODE must be set explicitly \(mock \| real\) in production/);
      expect(msg).toContain('core-loan');
    });

    it.each([[''], ['   ']])('treats INTEGRATION_MODE=%j (the .env.example style blank) as not set', (blank) => {
      expect(() => resolveIntegrationMode('sms', { ...PROD, INTEGRATION_MODE: blank })).toThrow(/must be set explicitly/);
    });

    it.each([['Production'], [' production ']])('applies the same rule for NODE_ENV=%j', (nodeEnv) => {
      expect(() => resolveIntegrationMode('sms', { NODE_ENV: nodeEnv })).toThrow(/must be set explicitly/);
    });

    it.each([['mock'], ['real']])('accepts an explicit INTEGRATION_MODE=%s', (mode) => {
      expect(resolveIntegrationMode('qpay', { ...PROD, INTEGRATION_MODE: mode })).toBe(mode);
    });

    it('accepts a per-integration value as the explicit choice for that integration only', () => {
      const env = { ...PROD, INTEGRATION_MODE_QPAY: 'real' };
      expect(resolveIntegrationMode('qpay', env)).toBe('real');
      expect(() => resolveIntegrationMode('sms', env)).toThrow(/must be set explicitly/);
    });

    it('treats a blank per-integration value as unset and falls back to INTEGRATION_MODE', () => {
      expect(resolveIntegrationMode('qpay', { ...PROD, INTEGRATION_MODE: 'real', INTEGRATION_MODE_QPAY: '' })).toBe('real');
      expect(() => resolveIntegrationMode('qpay', { ...PROD, INTEGRATION_MODE_QPAY: '  ' })).toThrow(/must be set explicitly/);
    });
  });

  describe('value validation (production and non-production)', () => {
    it.each([['prod'], ['true'], ['realx'], ['mock,real'], ['1'], ['staging']])('rejects INTEGRATION_MODE=%j', (mode) => {
      expect(() => resolveIntegrationMode('qpay', { INTEGRATION_MODE: mode })).toThrow(/'mock' эсвэл 'real'/);
      expect(() => resolveIntegrationMode('qpay', { ...PROD, INTEGRATION_MODE: mode })).toThrow(/'mock' эсвэл 'real'/);
    });

    it('rejects an invalid per-integration value even when the global one is valid', () => {
      const msg = messageOf(() => resolveIntegrationMode('sms', { ...PROD, INTEGRATION_MODE: 'real', INTEGRATION_MODE_SMS: 'fake' }));
      expect(msg).toContain('sms');
      expect(msg).toContain('fake');
    });

    it('stays case-insensitive and ignores surrounding blanks (existing behaviour)', () => {
      expect(resolveIntegrationMode('qpay', { INTEGRATION_MODE: 'REAL' })).toBe('real');
      expect(resolveIntegrationMode('qpay', { INTEGRATION_MODE: ' Mock ' })).toBe('mock');
    });
  });

  describe('per-integration override', () => {
    it('beats the global mode in both directions', () => {
      expect(resolveIntegrationMode('sms', { INTEGRATION_MODE: 'real', INTEGRATION_MODE_SMS: 'mock' })).toBe('mock');
      expect(resolveIntegrationMode('qpay', { INTEGRATION_MODE: 'mock', INTEGRATION_MODE_QPAY: 'real' })).toBe('real');
    });

    it.each([['bank-transfer', 'INTEGRATION_MODE_BANK_TRANSFER'], ['core-deposit', 'INTEGRATION_MODE_CORE_DEPOSIT'], ['socialpay', 'INTEGRATION_MODE_SOCIALPAY']])('reads %s from %s', (name, key) => {
      expect(resolveIntegrationMode(name, { [key]: 'real' })).toBe('real');
    });
  });

  it('reads process.env by default', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', '');
    expect(() => resolveIntegrationMode('qpay')).toThrow(/must be set explicitly/);
    vi.stubEnv('INTEGRATION_MODE', 'real');
    expect(resolveIntegrationMode('qpay')).toBe('real');
  });
});

// Phase 5: production + real горимд шаардлагатай env-ийг хүсэлт бүрт биш, bootstrap-д нэг удаа шалгана (assertInternalAuthSecret-ийн загвар).
describe('assertRealIntegrationEnv', () => {
  const NAMES = ['X_USER', 'X_PASS'];
  const FULL = { ...PROD, INTEGRATION_MODE: 'real', X_USER: 'u-secret', X_PASS: 'p-secret' };

  it('does nothing outside production, even in real mode with missing env (per-call fail-closed stays)', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { INTEGRATION_MODE: 'real' })).not.toThrow();
    expect(() => assertRealIntegrationEnv('x', NAMES, { NODE_ENV: 'staging', INTEGRATION_MODE: 'real' })).not.toThrow();
  });

  it('does nothing in production when the mode is an explicit mock', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { ...PROD, INTEGRATION_MODE: 'mock' })).not.toThrow();
  });

  it('passes in production + real when every variable is set', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, FULL)).not.toThrow();
  });

  it.each([['unset', undefined], ['empty', ''], ['whitespace only', '   ']])('refuses to start in production + real when a variable is %s, naming it but never a value', (_label, value) => {
    try {
      assertRealIntegrationEnv('x', NAMES, { ...FULL, X_PASS: value });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationNotConfiguredError);
      expect((e as IntegrationNotConfiguredError).missing).toEqual(['X_PASS']);
      expect((e as Error).message).not.toContain('u-secret');
    }
  });

  it('honours a per-integration real override', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { ...PROD, INTEGRATION_MODE: 'mock', INTEGRATION_MODE_X: 'real' })).toThrow(IntegrationNotConfiguredError);
  });

  it('still refuses an unset mode in production (no silent mock fallback)', () => {
    expect(() => assertRealIntegrationEnv('x', NAMES, { ...PROD })).toThrow(/must be set explicitly/);
  });
});

describe('requireEnv', () => {
  it('returns the requested values', () => {
    expect(requireEnv('x', ['A', 'B'], { A: '1', B: '2' })).toEqual({ A: '1', B: '2' });
  });

  it.each([['unset', undefined], ['empty', ''], ['whitespace only', '  ']])('reports a variable that is %s as missing, by name only', (_label, value) => {
    try {
      requireEnv('qpay', ['A', 'B'], { A: 'secret-value', B: value });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IntegrationNotConfiguredError);
      expect((e as IntegrationNotConfiguredError).missing).toEqual(['B']);
      expect((e as Error).message).not.toContain('secret-value');
    }
  });
});
