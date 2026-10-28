import { z } from 'zod';
import type { AssetType } from '../enums';
// Collateral auto-valuation (FR-14.1, FR-14.2) — sync REST DTOs of the valuation service.
// origination → valuation: POST /valuate/vehicle-lookup, POST /valuate/auto

/** Asset types the auto-valuation endpoint supports; a subset of `AssetType`. */
export const AUTO_VALUATION_ASSET_TYPES = ['VEHICLE'] as const satisfies readonly (typeof AssetType)[number][];

// Mongolian plate: 4 digits + 2–3 Cyrillic letters, in either order (1234УБА, УЕН5246).
export const PLATE_NO_PATTERN = /^(?:[А-ЯЁӨҮ]{2,3}\d{4}|\d{4}[А-ЯЁӨҮ]{2,3})$/;

/** Upper-cases and strips spaces/dashes so "1234 уба" and "1234-УБА" are the same key. */
export const normalizePlateNo = (raw: string): string => raw.replace(/[\s\-_.]+/g, '').toUpperCase();

// Latin letters are rejected on purpose: Latin/Cyrillic look-alikes (Y/У/Ү) cannot be mapped safely.
export const PlateNo = z
  .string()
  .transform(normalizePlateNo)
  .pipe(z.string().regex(PLATE_NO_PATTERN, 'Plate number must be 4 digits and 2-3 Cyrillic letters, e.g. УЕН5246 or 1234УБА'));

export const VehicleFuelType = ['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'LPG', 'OTHER'] as const;

// Owner data is personal data (CLAUDE.md §6.5): returned to the caller, never persisted or logged by valuation.
export const VehicleOwner = z.object({ registerNo: z.string(), name: z.string() });
export const VehicleInfo = z.object({
  plateNo: z.string(),
  vin: z.string().nullable(),
  make: z.string(),
  model: z.string(),
  manufactureYear: z.number().int(),
  importYear: z.number().int().nullable(),
  engineCc: z.number().int().nullable(),
  fuelType: z.enum(VehicleFuelType).nullable(),
  color: z.string().nullable(),
  owner: VehicleOwner,
  registeredAt: z.string().nullable(), // first registration, ISO date
});
export type VehicleInfo = z.infer<typeof VehicleInfo>;

// What the valuation result keeps about the vehicle: no owner, so the whole result can be stored (collateral_valuation.method_json).
export const VehicleSummary = VehicleInfo.omit({ owner: true });
export type VehicleSummary = z.infer<typeof VehicleSummary>;

export const VehicleLookupRequest = z.object({ plateNo: PlateNo });
export type VehicleLookupRequest = z.infer<typeof VehicleLookupRequest>;
export const VehicleLookupResponse = z.object({ vehicle: VehicleInfo, fetchedAt: z.string().datetime() });
export type VehicleLookupResponse = z.infer<typeof VehicleLookupResponse>;

export const AutoValuationRequest = z.object({
  assetType: z.enum(AUTO_VALUATION_ASSET_TYPES),
  plateNo: PlateNo,
  // The odometer is not in the registry — the officer enters it. Omit (or null) when unknown; 0 is rejected as a blank field sent as a number.
  mileageKm: z.number().int().positive().max(2_000_000).nullish(),
});
export type AutoValuationRequest = z.infer<typeof AutoValuationRequest>;

export const ComparableExclusionReason = ['INVALID_PRICE', 'UNSUPPORTED_CURRENCY', 'MODEL_MISMATCH', 'YEAR_OUT_OF_RANGE', 'STALE_LISTING', 'OUTLIER'] as const;
export type ComparableExclusionReason = (typeof ComparableExclusionReason)[number];
export const ValuationConfidence = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ValuationConfidence = (typeof ValuationConfidence)[number];
export const AutoValuationStatus = ['OK', 'INSUFFICIENT_DATA'] as const;
export const AutoValuationWarning = ['SOURCE_UNAVAILABLE', 'MILEAGE_NOT_PROVIDED', 'LOW_CONFIDENCE'] as const;

export const ListingCurrency = ['MNT', 'USD'] as const;
export type ListingCurrency = (typeof ListingCurrency)[number];

export const MarketComparable = z.object({
  source: z.string(),
  externalId: z.string(),
  url: z.string().nullable(),
  title: z.string(),
  year: z.number().int(),
  mileageKm: z.number().int().nullable(),
  listedPrice: z.number(),
  currency: z.enum(ListingCurrency),
  postedAt: z.string(),
  priceMnt: z.number().nullable(), // listed price converted to MNT; null when the price or currency is unusable
  adjustedPriceMnt: z.number().nullable(), // after year/mileage adjustment to the subject vehicle
  included: z.boolean(),
  exclusionReason: z.enum(ComparableExclusionReason).nullable(),
});
export type MarketComparable = z.infer<typeof MarketComparable>;

// marketValue is a suggestion (FR-14.2): the officer may edit it, with a reason.
export const MarketEstimate = z.object({
  marketValue: z.number(), // median of the adjusted comparables
  lowValue: z.number(), // 25th percentile
  highValue: z.number(), // 75th percentile
  meanValue: z.number(),
  sampleSize: z.number().int(),
  confidence: z.enum(ValuationConfidence),
  currency: z.literal('MNT'),
  method: z.literal('MARKET_COMPARABLES_V1'),
});
export type MarketEstimate = z.infer<typeof MarketEstimate>;

export const SourceReport = z.object({
  id: z.string(),
  kind: z.enum(['GOVERNMENT_REGISTRY', 'CLASSIFIED_ADS']),
  status: z.enum(['OK', 'ERROR']), // an unknown plate is a 404, not a source status
  count: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  fetchedAt: z.string().datetime(),
});
export type SourceReport = z.infer<typeof SourceReport>;

// Storable as collateral_valuation.method_json (docs/03): it holds the inputs, the parameters and every comparable but no owner data.
export const AutoValuationResponse = z.object({
  assetType: z.enum(AUTO_VALUATION_ASSET_TYPES),
  status: z.enum(AutoValuationStatus),
  valuedAt: z.string().datetime(),
  request: z.object({ plateNo: z.string(), mileageKm: z.number().int().nullable() }), // echo of the inputs the estimate depends on
  vehicle: VehicleSummary,
  estimate: MarketEstimate.nullable(),
  comparables: z.array(MarketComparable),
  sources: z.array(SourceReport),
  parameters: z.record(z.number()), // pricing parameters used, for reproducibility
  warnings: z.array(z.enum(AutoValuationWarning)),
});
export type AutoValuationResponse = z.infer<typeof AutoValuationResponse>;
