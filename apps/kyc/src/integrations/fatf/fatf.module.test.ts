import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FATF_CLIENT } from './fatf.client';
import { FatfModule, createFatfClient } from './fatf.module';
import { MockFatfClient } from './mock-fatf.client';
import { RealFatfClient } from './real-fatf.client';

describe('createFatfClient', () => {
  it('returns the mock by default', () => {
    expect(createFatfClient({})).toBeInstanceOf(MockFatfClient);
    expect(createFatfClient({ INTEGRATION_MODE: 'mock' })).toBeInstanceOf(MockFatfClient);
  });

  it('returns the real client when INTEGRATION_MODE=real', () => {
    expect(createFatfClient({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealFatfClient);
  });

  it('rejects an unknown mode', () => {
    expect(() => createFatfClient({ INTEGRATION_MODE: 'staging' })).toThrow(/INTEGRATION_MODE/);
  });
});

describe('FatfModule', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('provides the mock FATF_CLIENT by default', async () => {
    vi.stubEnv('INTEGRATION_MODE', '');
    const mod = await Test.createTestingModule({ imports: [FatfModule] }).compile();
    expect(mod.get(FATF_CLIENT)).toBeInstanceOf(MockFatfClient);
  });

  it('provides the real FATF_CLIENT when INTEGRATION_MODE=real', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    const mod = await Test.createTestingModule({ imports: [FatfModule] }).compile();
    expect(mod.get(FATF_CLIENT)).toBeInstanceOf(RealFatfClient);
  });
});
