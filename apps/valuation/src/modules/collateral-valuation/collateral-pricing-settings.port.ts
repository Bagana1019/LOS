import type { CollateralPricingParams } from '@los/calc';

/**
 * Everything the collateral price suggestion reads from settings (FR-14.1, FR-14.2; docs/01 §8: no business values hard-coded in logic):
 * vehicle depreciation/mileage, real-estate coefficients, land-use coefficients, base-price staleness and the last-resort haircut table.
 */
export interface CollateralPricingSettings {
  /** true while the values are DEMO placeholders: every suggestion computed from them carries the `DEMO_PARAMETERS` warning. */
  readonly demo: boolean;
  pricing(): Promise<CollateralPricingParams>;
}

export const COLLATERAL_PRICING_SETTINGS = Symbol('COLLATERAL_PRICING_SETTINGS');
