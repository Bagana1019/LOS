import { describe, it, expect } from 'vitest';
import { IntegrationError, type IntegrationContext } from './integration.types';
import { RealUneguiVehicleListingSource } from './listings/real-unegui-vehicle-listing-source';
import type { VehicleListingSource } from './listings/vehicle-listing-source.port';
import { RealAtutVehicleRegistry } from './vehicle-registry/real-atut-vehicle-registry';
import type { VehicleRegistry } from './vehicle-registry/vehicle-registry.port';

const ctx: IntegrationContext = { correlationId: 'test', now: new Date('2026-10-28T09:00:00.000Z'), signal: new AbortController().signal };
const query = { make: 'Toyota', model: 'Prius', yearFrom: 2011, yearTo: 2013 };

describe('real integration stubs', () => {
  it('RealAtutVehicleRegistry rejects with NOT_IMPLEMENTED and points to INTEGRATION_MODE=mock', async () => {
    const registry: VehicleRegistry = new RealAtutVehicleRegistry();
    const pending = registry.lookup('УЕН5246', ctx);
    await expect(pending).rejects.toBeInstanceOf(IntegrationError);
    await expect(pending).rejects.toMatchObject({
      integration: 'ATUT',
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('INTEGRATION_MODE=mock'),
    });
  });

  it('RealUneguiVehicleListingSource has id UNEGUI and rejects with NOT_IMPLEMENTED', async () => {
    const source: VehicleListingSource = new RealUneguiVehicleListingSource();
    expect(source.id).toBe('UNEGUI');
    const pending = source.search(query, ctx);
    await expect(pending).rejects.toBeInstanceOf(IntegrationError);
    await expect(pending).rejects.toMatchObject({
      integration: 'UNEGUI',
      code: 'NOT_IMPLEMENTED',
      message: expect.stringContaining('INTEGRATION_MODE=mock'),
    });
  });

  it('never throws synchronously, so callers can always await the call', () => {
    const registry: VehicleRegistry = new RealAtutVehicleRegistry();
    const source: VehicleListingSource = new RealUneguiVehicleListingSource();
    expect(() => registry.lookup('УЕН5246', ctx).catch(() => undefined)).not.toThrow();
    expect(() => source.search(query, ctx).catch(() => undefined)).not.toThrow();
  });
});
