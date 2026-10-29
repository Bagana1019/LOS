import { Injectable } from '@nestjs/common';
import type { CollateralPricingParams } from '@los/calc';
import type { CollateralPricingSettings } from './collateral-pricing-settings.port';

// DEMO: every number below is a placeholder that stands in for a business decision that has not been taken yet (docs/05 §9, docs/DECISIONS.md M6).
// This is the ONE place to swap: replace this class with a projection of origination.settings (CLAUDE.md §3.2 rule 8) or an admin-editable
// table and bind it to COLLATERAL_PRICING_SETTINGS in CollateralValuationModule. Nothing else in the service hard-codes these values.
export const DEMO_COLLATERAL_PRICING: CollateralPricingParams = {
  // DEMO: vehicle value = base price × (1 − min(50%, 3% × age)) × (1 − min(20%, 1% per 10 000 km above 15 000 km/year)).
  vehicle: { annualDepreciationRate: 0.03, maxDepreciation: 0.5, freeMileageKmPerYear: 15_000, mileageDeductionPer10kKm: 0.01, maxMileageDeduction: 0.2 },
  realty: {
    // DEMO: floor coefficient (apartments only).
    floor: { basement: 0.85, ground: 0.95, middle: 1, top: 0.97 },
    // DEMO: purpose coefficient.
    purpose: { RESIDENTIAL: 1, COMMERCIAL: 1.15 },
    // DEMO: building-age coefficient, bands ascending; the last band (maxAgeYears null) catches every older building.
    buildingAge: {
      bands: [
        { maxAgeYears: 5, coefficient: 1.05 },
        { maxAgeYears: 15, coefficient: 1 },
        { maxAgeYears: 30, coefficient: 0.9 },
        { maxAgeYears: null, coefficient: 0.8 },
      ],
      unknownCoefficient: 0.95,
    },
  },
  // DEMO: land-use coefficient.
  land: { landUse: { RESIDENTIAL: 1, COMMERCIAL: 1.2, AGRICULTURAL: 0.3, INDUSTRIAL: 0.9, OTHER: 0.8 } },
  // DEMO: a base price older than a year is flagged BASE_PRICE_STALE.
  basePriceStaleDays: 365,
  // DEMO: last-resort haircut (HaircutSource DEMO_DEFAULT) — docs/04 M6 AC: 30,000,000 × 0.7 = 21,000,000. Real values live in haircut_rule / product.haircut_json.
  defaultHaircuts: { VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 },
};

@Injectable()
export class DemoCollateralPricing implements CollateralPricingSettings {
  readonly demo = true;

  async pricing(): Promise<CollateralPricingParams> {
    return DEMO_COLLATERAL_PRICING;
  }
}
