import { Injectable } from '@nestjs/common';
import type { ValuationSettings, VehiclePricingSettings } from './valuation-settings.port';

// DEMO values. To be replaced by a projection of origination.settings (CLAUDE.md §3.2 rule 8, docs/01 §8);
// the keys are proposed as valuation.vehicle.* and must be confirmed by the business before go-live (docs/DECISIONS.md).
@Injectable()
export class DemoValuationSettings implements ValuationSettings {
  async vehiclePricing(): Promise<VehiclePricingSettings> {
    return {
      usdMnt: 3500,
      minPriceMnt: 1_000_000,
      yearTolerance: 1,
      maxListingAgeDays: 90,
      yearAdjustmentRate: 0.05,
      mileageAdjustmentPer10kKm: 0.01,
      maxTotalAdjustment: 0.3,
      outlierIqrFactor: 1.5,
      outlierMinRelativeSpread: 0.05,
      outlierMinSample: 4,
      minComparables: 3,
      highConfidenceMinSample: 8,
      highConfidenceMaxCv: 0.15,
      mediumConfidenceMinSample: 5,
      mediumConfidenceMaxCv: 0.3,
      roundToMnt: 10000,
      externalTimeoutMs: 15000,
    };
  }
}
