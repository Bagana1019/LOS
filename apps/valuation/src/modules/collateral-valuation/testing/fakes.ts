import type { AutoValuationRequest, AutoValuationResponse, RequestContext, SuggestValuationRequest } from '@los/contracts';
import { DEMO_COLLATERAL_PRICING } from '../demo-collateral-pricing';
import type { CollateralPricingSettings } from '../collateral-pricing-settings.port';
import type { CollateralPricingParams } from '@los/calc';
import { stableKey, type CanonicalKey } from '../../base-price/base-price.keys';
import type { BasePriceHit } from '../../base-price/base-price-lookup.service';

// Test doubles of the suggestion service's collaborators (no database, no network).

export const CTX: RequestContext = { userId: 'user-1', roles: ['OFFICER'], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'corr-1' };

export interface FakePriceRow {
  assetType: string;
  key: CanonicalKey;
  unitPrice: number;
  validFrom: string;
  version?: number;
}

export class FakeBasePrices {
  readonly calls: { assetType: string; keys: readonly CanonicalKey[]; asOf: string }[] = [];
  constructor(public rows: FakePriceRow[] = []) {}

  async find(_orgId: string, assetType: string, keys: readonly CanonicalKey[], asOf: string): Promise<BasePriceHit | null> {
    this.calls.push({ assetType, keys, asOf });
    for (const [keyIndex, key] of keys.entries()) {
      const hit = this.rows
        .filter((r) => r.assetType === assetType && stableKey(r.key) === stableKey(key) && r.validFrom <= asOf)
        .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0];
      if (hit) return { id: 'bp-1', unitPrice: hit.unitPrice, validFrom: hit.validFrom, version: hit.version ?? 1, keyIndex, key };
    }
    return null;
  }
}

export class FakeHaircuts {
  readonly calls: { productId: string | null; assetType: string }[] = [];
  constructor(public rates: { productRule: number | null; orgRule: number | null } = { productRule: null, orgRule: null }) {}
  async findRates(_orgId: string, productId: string | null, assetType: string) {
    this.calls.push({ productId, assetType });
    return this.rates;
  }
}

export class FakeAuto {
  readonly calls: { req: AutoValuationRequest; correlationId: string }[] = [];
  constructor(public outcome: AutoValuationResponse | Error) {}
  async autoValuateVehicle(req: AutoValuationRequest, correlationId: string): Promise<AutoValuationResponse> {
    this.calls.push({ req, correlationId });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

export class FakePricing implements CollateralPricingSettings {
  constructor(public demo = true, public params: CollateralPricingParams = DEMO_COLLATERAL_PRICING) {}
  async pricing(): Promise<CollateralPricingParams> {
    return this.params;
  }
}

/** An `AutoValuationResponse` with a usable estimate (Toyota Prius 2012, 25 800 000 ₮); override any part. */
export function autoResponse(over: Partial<AutoValuationResponse> = {}): AutoValuationResponse {
  return {
    assetType: 'VEHICLE',
    status: 'OK',
    valuedAt: '2026-10-29T03:00:00.000Z',
    request: { plateNo: 'УЕН5246', mileageKm: 90_000 },
    vehicle: { plateNo: 'УЕН5246', vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2012, importYear: 2016, engineCc: 1798, fuelType: 'HYBRID', color: null, registeredAt: '2016-05-20' },
    estimate: { marketValue: 25_800_000, lowValue: 25_000_000, highValue: 26_500_000, meanValue: 25_700_000, sampleSize: 9, confidence: 'HIGH', currency: 'MNT', method: 'MARKET_COMPARABLES_V1' },
    comparables: [
      { source: 'S1', externalId: '1', url: null, title: 't', year: 2012, mileageKm: 80_000, listedPrice: 25_800_000, currency: 'MNT', postedAt: '2026-10-20T00:00:00.000Z', priceMnt: 25_800_000, adjustedPriceMnt: 25_800_000, included: true, exclusionReason: null },
      { source: 'S1', externalId: '2', url: null, title: 't', year: 2012, mileageKm: 80_000, listedPrice: 9_000_000, currency: 'MNT', postedAt: '2026-10-20T00:00:00.000Z', priceMnt: 9_000_000, adjustedPriceMnt: null, included: false, exclusionReason: 'OUTLIER' },
    ],
    sources: [
      { id: 'ATUT', kind: 'GOVERNMENT_REGISTRY', status: 'OK', count: 1, errorCode: null, fetchedAt: '2026-10-29T03:00:00.000Z' },
      { id: 'S1', kind: 'CLASSIFIED_ADS', status: 'OK', count: 2, errorCode: null, fetchedAt: '2026-10-29T03:00:00.000Z' },
    ],
    parameters: { minComparables: 3 },
    warnings: [],
    ...over,
  };
}

export const vehicleDescription = { plateNo: 'УЕН5246', make: 'Toyota', model: 'Prius', manufactureYear: 2012, mileageKm: 90_000 };

export function suggestRequest(over: Partial<SuggestValuationRequest> & Pick<SuggestValuationRequest, 'assetType' | 'description'>): SuggestValuationRequest {
  return {
    collateralId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
    productId: null,
    productHaircutRate: null,
    externalValuationThreshold: null,
    validityDays: 90,
    ...over,
  };
}
