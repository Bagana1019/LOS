import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IntegrationsModule } from './integrations.module';
import { RealUneguiVehicleListingSource } from './listings/real-unegui-vehicle-listing-source';
import { MockVehicleListingSource } from './listings/mock-vehicle-listing-source';
import { VEHICLE_LISTING_SOURCES, type VehicleListingSource } from './listings/vehicle-listing-source.port';
import { MockVehicleRegistry } from './vehicle-registry/mock-vehicle-registry';
import { RealAtutVehicleRegistry } from './vehicle-registry/real-atut-vehicle-registry';
import { VEHICLE_REGISTRY, type VehicleRegistry } from './vehicle-registry/vehicle-registry.port';

@Injectable()
class Consumer {
  constructor(
    @Inject(VEHICLE_REGISTRY) readonly registry: VehicleRegistry,
    @Inject(VEHICLE_LISTING_SOURCES) readonly sources: VehicleListingSource[],
  ) {}
}

@Module({ imports: [IntegrationsModule], providers: [Consumer] })
class ConsumerModule {}

// ConfigService reads process.env before the `load` factories, so the real environment must be neutral for these tests.
const KEYS = ['INTEGRATION_MODE', 'NODE_ENV'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    if (k === 'INTEGRATION_MODE') delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const compile = (config: Record<string, string>) =>
  Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => config] }), ConsumerModule],
  }).compile();

describe('IntegrationsModule', () => {
  it('wires the mock registry and both mock listing sources in mock mode', async () => {
    const { registry, sources } = (await compile({ INTEGRATION_MODE: 'mock' })).get(Consumer);
    expect(registry).toBeInstanceOf(MockVehicleRegistry);
    expect(sources.map((s) => s.id)).toEqual(['MOCK_UNEGUI', 'MOCK_ADS_B']);
    expect(sources.every((s) => s instanceof MockVehicleListingSource)).toBe(true);
  });

  it('warns at bootstrap that mock mode serves simulated data, and stays quiet in real mode', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await compile({ INTEGRATION_MODE: 'real' });
      expect(warn).not.toHaveBeenCalled();
      await compile({ INTEGRATION_MODE: 'mock' });
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toMatch(/INTEGRATION_MODE=mock.*SIMULATED/);
    } finally {
      warn.mockRestore();
    }
  });

  it('wires the real registry and the real unegui source in real mode', async () => {
    const { registry, sources } = (await compile({ INTEGRATION_MODE: 'real' })).get(Consumer);
    expect(registry).toBeInstanceOf(RealAtutVehicleRegistry);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(RealUneguiVehicleListingSource);
    expect(sources[0].id).toBe('UNEGUI');
  });

  it('defaults to mock outside production when INTEGRATION_MODE is not set', async () => {
    process.env.NODE_ENV = 'development';
    const { registry } = (await compile({})).get(Consumer);
    expect(registry).toBeInstanceOf(MockVehicleRegistry);
  });

  it('fails at bootstrap in production when INTEGRATION_MODE is not set', async () => {
    process.env.NODE_ENV = 'production';
    await expect(compile({})).rejects.toThrow(/INTEGRATION_MODE must be set explicitly in production/);
  });

  it('allows an explicit real mode in production', async () => {
    process.env.NODE_ENV = 'production';
    expect((await compile({ INTEGRATION_MODE: 'real' })).get(Consumer).registry).toBeInstanceOf(RealAtutVehicleRegistry);
  });

  it('fails at bootstrap on an unknown INTEGRATION_MODE', async () => {
    await expect(compile({ INTEGRATION_MODE: 'sandbox' })).rejects.toThrow(/INTEGRATION_MODE must be 'mock' or 'real'/);
  });

  it('serves the mock registry end to end through the exported token', async () => {
    const { registry } = (await compile({ INTEGRATION_MODE: 'mock' })).get(Consumer);
    const ctx = { correlationId: 't', now: new Date('2026-10-28T09:00:00.000Z'), signal: new AbortController().signal };
    expect(await registry.lookup('УЕН5246', ctx)).toMatchObject({ make: 'Toyota', model: 'Prius' });
  });
});
