import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFatfClient, FatfModule } from './fatf/fatf.module';
import { resolveIntegrationMode } from './integration-mode';
import { createUnScClient, UnScModule } from './un-sc/un-sc.module';

describe('resolveIntegrationMode', () => {
  it('defaults to mock when INTEGRATION_MODE is unset or blank', () => {
    expect(resolveIntegrationMode({})).toBe('mock');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: undefined })).toBe('mock');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: '' })).toBe('mock');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: '   ' })).toBe('mock');
  });

  it('accepts mock and real, case-insensitively', () => {
    expect(resolveIntegrationMode({ INTEGRATION_MODE: 'mock' })).toBe('mock');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: 'real' })).toBe('real');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: 'REAL' })).toBe('real');
    expect(resolveIntegrationMode({ INTEGRATION_MODE: ' Mock ' })).toBe('mock');
  });

  it('throws a clear error on any other value', () => {
    expect(() => resolveIntegrationMode({ INTEGRATION_MODE: 'prod' })).toThrow(/Invalid INTEGRATION_MODE "prod".*"mock" or "real"/);
  });

  it('refuses to default to mock in production when INTEGRATION_MODE is unset or blank', () => {
    const msg = /INTEGRATION_MODE is not set while NODE_ENV=production.*"?INTEGRATION_MODE=real/;
    expect(() => resolveIntegrationMode({ NODE_ENV: 'production' })).toThrow(msg);
    expect(() => resolveIntegrationMode({ NODE_ENV: 'production', INTEGRATION_MODE: '' })).toThrow(msg);
    expect(() => resolveIntegrationMode({ NODE_ENV: 'production', INTEGRATION_MODE: '   ' })).toThrow(msg);
    expect(() => resolveIntegrationMode({ NODE_ENV: ' Production ' })).toThrow(msg);
  });

  it('still allows an explicit mock (or real) in production, and the implicit mock outside production', () => {
    expect(resolveIntegrationMode({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' })).toBe('mock');
    expect(resolveIntegrationMode({ NODE_ENV: 'production', INTEGRATION_MODE: 'real' })).toBe('real');
    expect(resolveIntegrationMode({ NODE_ENV: 'development' })).toBe('mock');
    expect(resolveIntegrationMode({ NODE_ENV: 'test' })).toBe('mock');
  });

  it('reads process.env by default', () => {
    const prev = process.env.INTEGRATION_MODE;
    try {
      process.env.INTEGRATION_MODE = 'real';
      expect(resolveIntegrationMode()).toBe('real');
    } finally {
      if (prev === undefined) delete process.env.INTEGRATION_MODE;
      else process.env.INTEGRATION_MODE = prev;
    }
  });
});

describe('production boot guard', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('makes the list clients fail at construction when INTEGRATION_MODE is unset in production', () => {
    expect(() => createUnScClient({ NODE_ENV: 'production' })).toThrow(/INTEGRATION_MODE is not set/);
    expect(() => createFatfClient({ NODE_ENV: 'production' })).toThrow(/INTEGRATION_MODE is not set/);
    expect(createUnScClient({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' })).toBeDefined();
  });

  it('fails the Nest module boot (not the first request) in production without INTEGRATION_MODE', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTEGRATION_MODE', '');
    await expect(Test.createTestingModule({ imports: [UnScModule] }).compile()).rejects.toThrow(/INTEGRATION_MODE is not set/);
    await expect(Test.createTestingModule({ imports: [FatfModule] }).compile()).rejects.toThrow(/INTEGRATION_MODE is not set/);
    vi.stubEnv('INTEGRATION_MODE', 'mock');
    await expect(Test.createTestingModule({ imports: [UnScModule] }).compile()).resolves.toBeDefined();
  });
});
