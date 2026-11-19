import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalConfigError, assertPortalOrgConfig } from './portal.config';
import { PortalModule } from './portal.module';

const UUID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('assertPortalOrgConfig (DEFAULT_ORG_ID at boot — portal-bff sends no X-Org-Id)', () => {
  const warn = vi.fn();
  afterEach(() => warn.mockReset());

  it.each([
    ['production, empty', { NODE_ENV: 'production', DEFAULT_ORG_ID: '' }],
    ['production, unset', { NODE_ENV: 'production' }],
    ['production, whitespace', { NODE_ENV: 'production', DEFAULT_ORG_ID: '   ' }],
    ['production, not a UUID', { NODE_ENV: 'production', DEFAULT_ORG_ID: 'org-test' }],
    ['INTEGRATION_MODE=real outside production, empty', { NODE_ENV: 'development', INTEGRATION_MODE: 'real', DEFAULT_ORG_ID: '' }],
    ['INTEGRATION_MODE=REAL (case-insensitive), not a UUID', { NODE_ENV: 'test', INTEGRATION_MODE: 'REAL', DEFAULT_ORG_ID: 'abc' }],
  ])('refuses to start: %s', (_label, env) => {
    expect(() => assertPortalOrgConfig(env as NodeJS.ProcessEnv, warn)).toThrow(PortalConfigError);
    expect(() => assertPortalOrgConfig(env as NodeJS.ProcessEnv, warn)).toThrow(/DEFAULT_ORG_ID/);
  });

  it('production / real with a UUID: starts, no warning, returns the trimmed id', () => {
    expect(assertPortalOrgConfig({ NODE_ENV: 'production', DEFAULT_ORG_ID: ` ${UUID} ` }, warn)).toBe(UUID);
    expect(assertPortalOrgConfig({ INTEGRATION_MODE: 'real', DEFAULT_ORG_ID: UUID.toUpperCase() }, warn)).toBe(UUID.toUpperCase());
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', { NODE_ENV: 'development', DEFAULT_ORG_ID: '' }],
    ['not a UUID', { NODE_ENV: 'test', INTEGRATION_MODE: 'mock', DEFAULT_ORG_ID: 'org-test' }],
  ])('outside production (mock): %s → warning only', (_label, env) => {
    expect(() => assertPortalOrgConfig(env as NodeJS.ProcessEnv, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/DEFAULT_ORG_ID/);
  });

  it('outside production with a UUID: silent', () => {
    expect(assertPortalOrgConfig({ NODE_ENV: 'development', DEFAULT_ORG_ID: UUID }, warn)).toBe(UUID);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('PortalModule boot hook', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('onModuleInit throws in production without DEFAULT_ORG_ID (the app refuses to start)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEFAULT_ORG_ID', '');
    expect(() => new PortalModule().onModuleInit()).toThrow(PortalConfigError);
  });

  it('onModuleInit passes in production with a UUID DEFAULT_ORG_ID', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEFAULT_ORG_ID', UUID);
    expect(() => new PortalModule().onModuleInit()).not.toThrow();
  });
});
