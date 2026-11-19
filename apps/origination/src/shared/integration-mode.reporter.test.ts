import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockIntegrationsInProduction, ORIGINATION_INTEGRATIONS } from './integration-mode';
import { IntegrationModeReporter, reportMockIntegrations } from './integration-mode.reporter';

const PROD = { NODE_ENV: 'production' } as const;
const REAL = { ...PROD, INTEGRATION_MODE: 'real' } as const;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('mockIntegrationsInProduction (N3)', () => {
  it.each([[{ INTEGRATION_MODE: 'mock' }], [{ NODE_ENV: 'staging', INTEGRATION_MODE: 'mock' }], [{ NODE_ENV: 'test' }], [{}]])('is empty outside production: %j', (env) => {
    expect(mockIntegrationsInProduction(env)).toEqual([]);
  });

  it('is empty when production runs everything real', () => {
    expect(mockIntegrationsInProduction({ ...REAL })).toEqual([]);
  });

  it('names a single integration left on mock next to INTEGRATION_MODE=real', () => {
    expect(mockIntegrationsInProduction({ ...REAL, INTEGRATION_MODE_SMS: 'mock' })).toEqual(['sms']);
  });

  it('maps dashed names to their env key (bank-transfer, core-deposit)', () => {
    const env = { ...REAL, INTEGRATION_MODE_BANK_TRANSFER: 'mock', INTEGRATION_MODE_CORE_DEPOSIT: ' Mock ' };
    expect(mockIntegrationsInProduction(env)).toEqual(['bank-transfer', 'core-deposit']);
  });

  it('lists every integration when the global mode is mock (explicit staging setup)', () => {
    expect(mockIntegrationsInProduction({ ...PROD, INTEGRATION_MODE: 'mock' })).toEqual([...ORIGINATION_INTEGRATIONS]);
  });

  it('treats a per-integration real as real even when the global mode is mock', () => {
    expect(mockIntegrationsInProduction({ ...PROD, INTEGRATION_MODE: 'mock', INTEGRATION_MODE_QPAY: 'real' })).not.toContain('qpay');
  });

  it('ignores a blank override (blank = unset, falls back to the global real)', () => {
    expect(mockIntegrationsInProduction({ ...REAL, INTEGRATION_MODE_SMS: '  ' })).toEqual([]);
  });

  it('keeps H3 fail-closed: nothing chosen in production still throws', () => {
    expect(() => mockIntegrationsInProduction({ ...PROD })).toThrow(/must be set explicitly/);
  });

  it('keeps rejecting an invalid mode instead of reporting it', () => {
    expect(() => mockIntegrationsInProduction({ ...REAL, INTEGRATION_MODE_SMS: 'fake' })).toThrow(/'mock' эсвэл 'real'/);
  });
});

describe('reportMockIntegrations', () => {
  it('warns once with the integration names and returns them', () => {
    const warn = vi.fn();
    expect(reportMockIntegrations(warn, { ...REAL, INTEGRATION_MODE_SMS: 'mock', INTEGRATION_MODE_CORE_LOAN: 'mock' })).toEqual(['sms', 'core-loan']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/MOCK mode.*sms, core-loan/);
  });

  it('stays silent when nothing runs on mock', () => {
    const warn = vi.fn();
    expect(reportMockIntegrations(warn, { ...REAL })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never puts env values in the message (only integration names)', () => {
    const warn = vi.fn();
    reportMockIntegrations(warn, { ...REAL, INTEGRATION_MODE_SMS: 'mock', QPAY_CLIENT_SECRET: 'sup3r-s3cret-value', INTERNAL_AUTH_SECRET: 'another-s3cret' });
    expect(warn.mock.calls[0]![0]).not.toMatch(/s3cret/);
  });
});

describe('IntegrationModeReporter', () => {
  it('logs a warning at startup when production keeps one integration on mock', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', 'real');
    vi.stubEnv('INTEGRATION_MODE_SMS', 'mock');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new IntegrationModeReporter().onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('sms');
  });

  it('does not log in a non-production environment', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new IntegrationModeReporter().onModuleInit();
    expect(warn).not.toHaveBeenCalled();
  });
});
