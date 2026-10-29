import { describe, expect, it } from 'vitest';
import {
  buildingAgeCoefficient,
  floorCoefficient,
  isBasePriceStale,
  landValue,
  livestockValue,
  mileageDeduction,
  needsOverrideReason,
  realtyValue,
  requiresExternalValuation,
  resolveHaircut,
  round2,
  sameValue,
  validUntilFrom,
  vehicleAgeYears,
  vehicleBasePriceValue,
  vehicleDepreciationRate,
  type CollateralPricingParams,
  type RealtyValueInput,
} from './collateral-value';
import { collateralValue } from './ltv';
// FR-14.1, FR-14.2, FR-14.3 — тестийн параметр нь DEMO биш, зориудаар энгийн тоо (тооцоо гараар шалгагдахуйц).

const M = 1_000_000;

const params: CollateralPricingParams = {
  vehicle: { annualDepreciationRate: 0.03, maxDepreciation: 0.5, freeMileageKmPerYear: 15_000, mileageDeductionPer10kKm: 0.01, maxMileageDeduction: 0.2 },
  realty: {
    floor: { basement: 0.85, ground: 0.95, middle: 1, top: 0.97 },
    purpose: { RESIDENTIAL: 1, COMMERCIAL: 1.15 },
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
  land: { landUse: { RESIDENTIAL: 1, COMMERCIAL: 1.2, AGRICULTURAL: 0.3, INDUSTRIAL: 0.9, OTHER: 0.8 } },
  basePriceStaleDays: 365,
  defaultHaircuts: { VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 },
};

describe('docs/04 M6 AC: барьцааны үнэлгээ = зах зээлийн үнэ × haircut', () => {
  it('30,000,000 × 0.7 = 21,000,000', () => {
    expect(collateralValue(30 * M, 0.7)).toBe(21 * M);
    expect(collateralValue(30 * M, resolveHaircut({ demoDefault: params.defaultHaircuts.VEHICLE }).rate)).toBe(21 * M);
  });
});

describe('round2 / sameValue', () => {
  it('rounds half up to 2 decimals (decimal arithmetic, not binary float)', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(10)).toBe(10);
    expect(round2(0.004)).toBe(0);
  });
  it('compares after rounding', () => {
    expect(sameValue(100.004, 100.001)).toBe(true);
    expect(sameValue(100.004, 100.006)).toBe(false);
    expect(sameValue(25_000_000, 25_000_000.4)).toBe(false);
  });
});

describe('VEHICLE_BASE_PRICE: суурь үнэ × (1 − элэгдэл) × (1 − гүйлтийн хасалт)', () => {
  const p = params.vehicle;

  it('age is the difference of years, never negative', () => {
    expect(vehicleAgeYears(2012, 2026)).toBe(14);
    expect(vehicleAgeYears(2027, 2026)).toBe(0);
  });

  it('depreciation grows linearly and stops at the cap', () => {
    expect(vehicleDepreciationRate(0, p)).toBe(0);
    expect(vehicleDepreciationRate(10, p)).toBe(0.3);
    expect(vehicleDepreciationRate(14, p)).toBe(0.42);
    expect(vehicleDepreciationRate(40, p)).toBe(0.5);
  });

  it('mileage deduction only counts the part above the free allowance', () => {
    expect(mileageDeduction(null, 14, p)).toEqual({ rate: 0, excessKm: 0 });
    expect(mileageDeduction(210_000, 14, p)).toEqual({ rate: 0, excessKm: 0 }); // exactly the allowance
    expect(mileageDeduction(300_000, 14, p)).toEqual({ rate: 0.09, excessKm: 90_000 });
    expect(mileageDeduction(5_000_000, 14, p)).toEqual({ rate: 0.2, excessKm: 4_790_000 }); // capped
  });

  it('a car younger than a year still gets one year of allowance', () => {
    expect(mileageDeduction(20_000, 0, p)).toEqual({ rate: 0.005, excessKm: 5_000 });
  });

  it('44,000,000 base, 2012 car in 2026 at 90,000 km: age 14 → 42% off → 25,520,000', () => {
    const r = vehicleBasePriceValue({ basePrice: 44 * M, manufactureYear: 2012, valuationYear: 2026, mileageKm: 90_000 }, p);
    expect(r).toEqual({ marketValue: 25_520_000, ageYears: 14, depreciationRate: 0.42, mileageDeductionRate: 0, excessMileageKm: 0 });
  });

  it('deducts for high mileage: 300,000 km → 9% → 23,223,200', () => {
    const r = vehicleBasePriceValue({ basePrice: 44 * M, manufactureYear: 2012, valuationYear: 2026, mileageKm: 300_000 }, p);
    expect(r.marketValue).toBe(23_223_200);
    expect(r.mileageDeductionRate).toBe(0.09);
    expect(r.excessMileageKm).toBe(90_000);
  });

  it('caps both the depreciation and the mileage deduction', () => {
    const r = vehicleBasePriceValue({ basePrice: 10 * M, manufactureYear: 2005, valuationYear: 2026, mileageKm: 3_000_000 }, p);
    expect(r.depreciationRate).toBe(0.5);
    expect(r.mileageDeductionRate).toBe(0.2);
    expect(r.marketValue).toBe(4_000_000); // 10M × 0.5 × 0.8
  });

  it('unknown mileage means no deduction', () => {
    const r = vehicleBasePriceValue({ basePrice: 44 * M, manufactureYear: 2012, valuationYear: 2026, mileageKm: null }, p);
    expect(r.marketValue).toBe(25_520_000);
    expect(r.mileageDeductionRate).toBe(0);
  });

  it('a zero rate for the parameters switches that part off (table already holds used prices)', () => {
    const r = vehicleBasePriceValue({ basePrice: 44 * M, manufactureYear: 2012, valuationYear: 2026, mileageKm: 900_000 }, { ...p, annualDepreciationRate: 0, mileageDeductionPer10kKm: 0 });
    expect(r.marketValue).toBe(44 * M);
  });

  it('rejects unusable inputs instead of returning a number', () => {
    const ok = { basePrice: 44 * M, manufactureYear: 2012, valuationYear: 2026, mileageKm: 1000 };
    expect(() => vehicleBasePriceValue({ ...ok, basePrice: 0 }, p)).toThrow(RangeError);
    expect(() => vehicleBasePriceValue({ ...ok, basePrice: Number.NaN }, p)).toThrow(RangeError);
    expect(() => vehicleBasePriceValue({ ...ok, mileageKm: -1 }, p)).toThrow(RangeError);
    expect(() => vehicleBasePriceValue({ ...ok, mileageKm: Number.POSITIVE_INFINITY }, p)).toThrow(RangeError);
  });
});

describe('REALTY_BASE_PRICE: м² суурь үнэ × талбай × давхар × зориулалт × барилгын нас', () => {
  const p = params.realty;

  describe('floorCoefficient', () => {
    it.each([
      [null, 12, 'UNKNOWN', 1],
      [-1, 12, 'BASEMENT', 0.85],
      [0, 12, 'BASEMENT', 0.85],
      [1, 12, 'GROUND', 0.95],
      [5, 12, 'MIDDLE', 1],
      [12, 12, 'TOP', 0.97],
      [13, 12, 'TOP', 0.97], // data error in the registry: above the top counts as top
      [5, null, 'MIDDLE', 1],
      [1, 1, 'GROUND', 0.95], // single-storey building: ground, never "top"
      [2, 1, 'MIDDLE', 1], // top-floor rule needs more than one floor
    ])('floor %s of %s → %s', (floor, total, position, coefficient) => {
      expect(floorCoefficient(floor, total, p.floor)).toEqual({ position, coefficient });
    });
  });

  describe('buildingAgeCoefficient', () => {
    it.each([
      [2024, 2026, 2, 1.05],
      [2021, 2026, 5, 1.05], // band edge is inclusive
      [2020, 2026, 6, 1],
      [2011, 2026, 15, 1],
      [2010, 2026, 16, 0.9],
      [1996, 2026, 30, 0.9],
      [1990, 2026, 36, 0.8],
      [2030, 2026, 0, 1.05], // future build year → age 0
    ])('built %s, valued %s → age %s, ×%s', (buildYear, valuationYear, ageYears, coefficient) => {
      expect(buildingAgeCoefficient(buildYear, valuationYear, p.buildingAge)).toEqual({ ageYears, coefficient });
    });

    it('unknown build year uses the unknown coefficient', () => {
      expect(buildingAgeCoefficient(null, 2026, p.buildingAge)).toEqual({ ageYears: null, coefficient: 0.95 });
    });

    it('fails loudly when the bands have no catch-all', () => {
      expect(() => buildingAgeCoefficient(1950, 2026, { bands: [{ maxAgeYears: 10, coefficient: 1 }], unknownCoefficient: 1 })).toThrow(RangeError);
    });
  });

  const apartment: RealtyValueInput = {
    assetType: 'APARTMENT',
    unitPrice: 4_500_000,
    areaM2: 60,
    floor: 5,
    totalFloors: 12,
    purpose: 'RESIDENTIAL',
    buildYear: 2010,
    valuationYear: 2026,
  };

  it('apartment: 4.5M × 60 m² × 1 × 1 × 0.9 (16 years old) = 243,000,000', () => {
    expect(realtyValue(apartment, p)).toEqual({
      marketValue: 243_000_000,
      floorPosition: 'MIDDLE',
      floorCoefficient: 1,
      purposeCoefficient: 1,
      buildingAgeYears: 16,
      buildingAgeCoefficient: 0.9,
    });
  });

  it('apartment: ground floor and commercial purpose scale the price', () => {
    const r = realtyValue({ ...apartment, floor: 1, purpose: 'COMMERCIAL' }, p);
    expect(r.marketValue).toBe(round2(4_500_000 * 60 * 0.95 * 1.15 * 0.9));
    expect(r.floorPosition).toBe('GROUND');
    expect(r.purposeCoefficient).toBe(1.15);
  });

  it('apartment: unknown floor and unknown build year fall back to the neutral/unknown coefficients', () => {
    const r = realtyValue({ ...apartment, floor: null, totalFloors: null, buildYear: null }, p);
    expect(r.floorPosition).toBe('UNKNOWN');
    expect(r.buildingAgeYears).toBeNull();
    expect(r.marketValue).toBe(round2(4_500_000 * 60 * 0.95));
  });

  it('house: floor coefficient does not apply', () => {
    const r = realtyValue({ ...apartment, assetType: 'HOUSE', floor: 1, totalFloors: 1, unitPrice: 2_000_000, areaM2: 100.5 }, p);
    expect(r.floorPosition).toBe('NOT_APPLICABLE');
    expect(r.floorCoefficient).toBe(1);
    expect(r.marketValue).toBe(round2(2_000_000 * 100.5 * 0.9));
  });

  it('rounds the product to 2 decimals', () => {
    const r = realtyValue({ ...apartment, unitPrice: 3_333_333.33, areaM2: 45.55, buildYear: 2024 }, p);
    expect(r.marketValue).toBe(round2(3_333_333.33 * 45.55 * 1.05));
    expect(Number.isInteger(r.marketValue * 100)).toBe(true);
  });

  it('rejects a non-positive price or area', () => {
    expect(() => realtyValue({ ...apartment, unitPrice: 0 }, p)).toThrow(RangeError);
    expect(() => realtyValue({ ...apartment, areaM2: -5 }, p)).toThrow(RangeError);
  });
});

describe('LAND_BASE_PRICE: м² суурь үнэ × талбай × зориулалтын коэффициент', () => {
  it('residential 700 m² at 800,000 ₮/m² = 560,000,000; agricultural land counts 30%', () => {
    expect(landValue({ unitPrice: 800_000, areaM2: 700, landUse: 'RESIDENTIAL' }, params.land)).toEqual({ marketValue: 560 * M, landUseCoefficient: 1 });
    expect(landValue({ unitPrice: 800_000, areaM2: 700, landUse: 'AGRICULTURAL' }, params.land)).toEqual({ marketValue: 168 * M, landUseCoefficient: 0.3 });
  });
  it('rejects a non-positive price or area', () => {
    expect(() => landValue({ unitPrice: 0, areaM2: 1, landUse: 'OTHER' }, params.land)).toThrow(RangeError);
    expect(() => landValue({ unitPrice: 1, areaM2: Number.NaN, landUse: 'OTHER' }, params.land)).toThrow(RangeError);
  });
});

describe('LIVESTOCK_UNIT_PRICE: нэгж үнэ × тоо толгой', () => {
  it('adult horses: 1,500,000 × 40 = 60,000,000', () => {
    expect(livestockValue({ unitPrice: 1_500_000, headCount: 40 })).toBe(60 * M);
  });
  it('rejects a non-positive price or head count', () => {
    expect(() => livestockValue({ unitPrice: 0, headCount: 3 })).toThrow(RangeError);
    expect(() => livestockValue({ unitPrice: 100, headCount: 0 })).toThrow(RangeError);
  });
});

describe('resolveHaircut: PRODUCT_RULE > PRODUCT_JSON > ORG_RULE > DEMO_DEFAULT', () => {
  const demoDefault = 0.7;
  it('takes the product rule first', () => {
    expect(resolveHaircut({ productRule: 0.55, productJson: 0.6, orgRule: 0.65, demoDefault })).toEqual({ rate: 0.55, source: 'PRODUCT_RULE' });
  });
  it('then product.haircut_json', () => {
    expect(resolveHaircut({ productRule: null, productJson: 0.6, orgRule: 0.65, demoDefault })).toEqual({ rate: 0.6, source: 'PRODUCT_JSON' });
  });
  it('then the org-wide rule', () => {
    expect(resolveHaircut({ productJson: null, orgRule: 0.65, demoDefault })).toEqual({ rate: 0.65, source: 'ORG_RULE' });
  });
  it('then the DEMO default', () => {
    expect(resolveHaircut({ demoDefault })).toEqual({ rate: 0.7, source: 'DEMO_DEFAULT' });
  });
  it('a rate of 0 is a real value (not "missing")', () => {
    expect(resolveHaircut({ productRule: 0, demoDefault })).toEqual({ rate: 0, source: 'PRODUCT_RULE' });
    expect(resolveHaircut({ productJson: 1, demoDefault })).toEqual({ rate: 1, source: 'PRODUCT_JSON' });
  });
  it('skips values that are not a rate between 0 and 1', () => {
    expect(resolveHaircut({ productRule: 1.5, productJson: Number.NaN, orgRule: -0.1, demoDefault })).toEqual({ rate: 0.7, source: 'DEMO_DEFAULT' });
    expect(resolveHaircut({ productRule: Number.NaN, productJson: 0.6, demoDefault })).toEqual({ rate: 0.6, source: 'PRODUCT_JSON' });
  });
  it('a broken DEMO default is a configuration error', () => {
    expect(() => resolveHaircut({ demoDefault: 1.2 })).toThrow(RangeError);
    expect(() => resolveHaircut({ demoDefault: Number.NaN })).toThrow(RangeError);
  });
});

describe('validUntilFrom', () => {
  it('adds the validity days to the valuation time', () => {
    expect(validUntilFrom(new Date('2026-10-29T00:00:00.000Z'), 90).toISOString()).toBe('2027-01-27T00:00:00.000Z');
    expect(validUntilFrom(new Date('2026-10-29T05:30:00.000Z'), 365).toISOString()).toBe('2027-10-29T05:30:00.000Z');
  });
  it('does not mutate its input', () => {
    const d = new Date('2026-10-29T00:00:00.000Z');
    validUntilFrom(d, 1);
    expect(d.toISOString()).toBe('2026-10-29T00:00:00.000Z');
  });
  it('rejects a non-positive or fractional number of days', () => {
    for (const days of [0, -1, 1.5, Number.NaN]) expect(() => validUntilFrom(new Date(), days)).toThrow(RangeError);
  });
});

describe('requiresExternalValuation (FR-14.3)', () => {
  it('is true at and above the threshold, false below', () => {
    expect(requiresExternalValuation(100 * M, 100 * M)).toBe(true);
    expect(requiresExternalValuation(100 * M + 1, 100 * M)).toBe(true);
    expect(requiresExternalValuation(100 * M - 0.01, 100 * M)).toBe(false);
  });
  it('is false when the product has no threshold', () => {
    expect(requiresExternalValuation(900 * M, null)).toBe(false);
    expect(requiresExternalValuation(900 * M, undefined)).toBe(false);
  });
});

describe('needsOverrideReason (FR-14.2)', () => {
  it('manual-value assets never need one', () => {
    expect(needsOverrideReason({ manualValueAsset: true, suggestedValue: null, finalValue: 5 * M })).toBe(false);
    expect(needsOverrideReason({ manualValueAsset: true, suggestedValue: 4 * M, finalValue: 5 * M })).toBe(false);
  });
  it('needs one when the system gave no suggestion', () => {
    expect(needsOverrideReason({ manualValueAsset: false, suggestedValue: null, finalValue: 5 * M })).toBe(true);
  });
  it('needs one when the final value differs from the suggestion after rounding to 2 decimals', () => {
    expect(needsOverrideReason({ manualValueAsset: false, suggestedValue: 25 * M, finalValue: 26 * M })).toBe(true);
    expect(needsOverrideReason({ manualValueAsset: false, suggestedValue: 25 * M, finalValue: 25 * M + 0.01 })).toBe(true);
  });
  it('does not need one when the value equals the suggestion (also after rounding)', () => {
    expect(needsOverrideReason({ manualValueAsset: false, suggestedValue: 25 * M, finalValue: 25 * M })).toBe(false);
    expect(needsOverrideReason({ manualValueAsset: false, suggestedValue: 25 * M, finalValue: 25 * M + 0.004 })).toBe(false);
  });
});

describe('isBasePriceStale', () => {
  it('is stale only when older than the maximum age', () => {
    expect(isBasePriceStale('2026-01-01', '2026-10-29', 365)).toBe(false);
    expect(isBasePriceStale('2025-10-29', '2026-10-29', 365)).toBe(false); // exactly 365 days
    expect(isBasePriceStale('2025-10-28', '2026-10-29', 365)).toBe(true);
  });
});
