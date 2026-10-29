import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockUnScClient } from './mock-un-sc.client';
import { RealUnScClient } from './real-un-sc.client';
import { UN_SC_CLIENT } from './un-sc.client';
import { UnScModule, createUnScClient } from './un-sc.module';

describe('createUnScClient', () => {
  it('returns the mock by default', () => {
    expect(createUnScClient({})).toBeInstanceOf(MockUnScClient);
    expect(createUnScClient({ INTEGRATION_MODE: 'mock' })).toBeInstanceOf(MockUnScClient);
  });

  it('returns the real client when INTEGRATION_MODE=real', () => {
    expect(createUnScClient({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealUnScClient);
  });

  it('rejects an unknown mode', () => {
    expect(() => createUnScClient({ INTEGRATION_MODE: 'staging' })).toThrow(/INTEGRATION_MODE/);
  });
});

describe('UnScModule', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('provides the mock UN_SC_CLIENT by default', async () => {
    vi.stubEnv('INTEGRATION_MODE', '');
    const mod = await Test.createTestingModule({ imports: [UnScModule] }).compile();
    expect(mod.get(UN_SC_CLIENT)).toBeInstanceOf(MockUnScClient);
  });

  it('provides the real UN_SC_CLIENT when INTEGRATION_MODE=real', async () => {
    vi.stubEnv('INTEGRATION_MODE', 'real');
    const mod = await Test.createTestingModule({ imports: [UnScModule] }).compile();
    expect(mod.get(UN_SC_CLIENT)).toBeInstanceOf(RealUnScClient);
  });
});
