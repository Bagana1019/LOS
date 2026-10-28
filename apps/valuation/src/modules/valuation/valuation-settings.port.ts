import type { MarketPriceParams } from '@los/calc';

/** Everything the vehicle auto-valuation reads from settings (docs/01 §8: no business values hard-coded in logic). */
export interface VehiclePricingSettings extends MarketPriceParams {
  /** Timeout of each external call, ms. */
  externalTimeoutMs: number;
}

export interface ValuationSettings {
  vehiclePricing(): Promise<VehiclePricingSettings>;
}

export const VALUATION_SETTINGS = Symbol('VALUATION_SETTINGS');
