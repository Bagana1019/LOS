import { z } from 'zod';
import { ListingCurrency } from '@los/contracts';
import type { IntegrationContext } from '../integration.types';

export interface VehicleListingQuery {
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
}

/**
 * One classified ad, normalised by the adapter: `make`/`model` follow the registry spelling, every ad has a year, the price is a number.
 * The valuation service validates adapter output against this schema; a source that returns anything else is reported as BAD_RESPONSE.
 */
const isHttpUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export const VehicleListingSchema = z.object({
  externalId: z.string().min(1).max(128),
  url: z.string().max(2048).refine(isHttpUrl, 'url must be http(s)').nullable(),
  title: z.string().max(300),
  make: z.string().max(100),
  model: z.string().max(100),
  year: z.number().int(),
  mileageKm: z.number().int().nonnegative().nullable(),
  price: z.number().finite(), // may be <= 0 or tiny: the plausibility checks live in @los/calc, which excludes such an ad as INVALID_PRICE
  currency: z.enum(ListingCurrency),
  postedAt: z.string().max(64), // ISO 8601; any other shape is excluded as STALE_LISTING
});
export type VehicleListing = z.infer<typeof VehicleListingSchema>;

/** A source returning more ads than this is treated as broken: adapters must page or limit their queries. */
export const MAX_LISTINGS_PER_SOURCE = 1000;

/** A classified-ads site (unegui.mn …). Several sources are queried in parallel; one failing must not fail the valuation. */
export interface VehicleListingSource {
  readonly id: string;
  search(query: VehicleListingQuery, ctx: IntegrationContext): Promise<VehicleListing[]>;
}

export const VEHICLE_LISTING_SOURCES = Symbol('VEHICLE_LISTING_SOURCES');
