import type { IntegrationContext } from '../integration.types';
import type { VehicleListing, VehicleListingQuery, VehicleListingSource } from './vehicle-listing-source.port';
import { MOCK_ADS_B_SEEDS, MOCK_UNEGUI_SEEDS, type MockListingSeed } from './mock-listings';

const DAY_MS = 86_400_000;
const normalize = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Deterministic stand-in for a classified-ads site (FR-14.2): the same query and `ctx.now` always give the same ads. */
export class MockVehicleListingSource implements VehicleListingSource {
  constructor(
    readonly id: string,
    private readonly seeds: readonly MockListingSeed[],
  ) {}

  async search(query: VehicleListingQuery, ctx: IntegrationContext): Promise<VehicleListing[]> {
    const make = normalize(query.make);
    const model = normalize(query.model);
    return this.seeds
      .filter((s) => normalize(s.make) === make && normalize(s.model).startsWith(model) && s.year >= query.yearFrom && s.year <= query.yearTo)
      .map((s) => ({
        externalId: s.externalId,
        url: `https://example.invalid/mock/${this.id}/${s.externalId}`,
        title: s.title,
        make: s.make,
        model: s.model,
        year: s.year,
        mileageKm: s.mileageKm,
        price: s.price,
        currency: s.currency,
        postedAt: new Date(ctx.now.getTime() - s.daysAgo * DAY_MS).toISOString(),
      }));
  }
}

export const createMockListingSources = (): VehicleListingSource[] => [
  new MockVehicleListingSource('MOCK_UNEGUI', MOCK_UNEGUI_SEEDS),
  new MockVehicleListingSource('MOCK_ADS_B', MOCK_ADS_B_SEEDS),
];
