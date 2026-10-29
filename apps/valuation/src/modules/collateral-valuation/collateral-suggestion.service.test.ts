import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { DomainError, FixedClock } from '@los/nest-common';
import type { ValuationSettings } from '../valuation/valuation-settings.port';
import { CollateralSuggestionService } from './collateral-suggestion.service';
import { DEMO_COLLATERAL_PRICING } from './demo-collateral-pricing';
import { CTX, FakeAuto, FakeBasePrices, FakeHaircuts, FakePricing, autoResponse, suggestRequest, vehicleDescription, type FakePriceRow } from './testing/fakes';

// FR-14.1, FR-14.2 — suggestion per asset type, vehicle fallback chain, haircut priority. Collaborators are fakes; the maths is @los/calc's (tested there).

const M = 1_000_000;
beforeAll(() => Logger.overrideLogger(false)); // the fallback path logs a warning on purpose
// 2026-10-29 11:00 in Ulaanbaatar; valuation year 2026.
const NOW = new Date('2026-10-29T03:00:00.000Z');
const FROM = '2026-01-01';

const PRICES: FakePriceRow[] = [
  { assetType: 'APARTMENT', key: { district: 'Баянзүрх' }, unitPrice: 4_200_000, validFrom: FROM },
  { assetType: 'APARTMENT', key: { district: 'Баянзүрх', khoroo: '5-р хороо' }, unitPrice: 4_600_000, validFrom: FROM },
  { assetType: 'HOUSE', key: { district: 'Налайх' }, unitPrice: 1_300_000, validFrom: FROM },
  { assetType: 'LAND', key: { district: 'Хан-Уул' }, unitPrice: 1_800_000, validFrom: FROM },
  { assetType: 'LIVESTOCK', key: { livestockType: 'HORSE', ageGroup: 'ADULT' }, unitPrice: 1_800_000, validFrom: FROM },
  { assetType: 'LIVESTOCK', key: { livestockType: 'SHEEP', ageGroup: 'YOUNG' }, unitPrice: 1_000_000_000, validFrom: FROM },
  { assetType: 'VEHICLE', key: { make: 'Toyota', model: 'Prius', year: 2012 }, unitPrice: 44 * M, validFrom: FROM },
];

function setup(opts: { auto?: ConstructorParameters<typeof FakeAuto>[0]; prices?: FakePriceRow[]; vehicleDemo?: boolean; pricingDemo?: boolean; now?: Date } = {}) {
  const auto = new FakeAuto(opts.auto ?? autoResponse());
  const prices = new FakeBasePrices(opts.prices ?? PRICES);
  const haircuts = new FakeHaircuts();
  const vehicleSettings: ValuationSettings = { demo: opts.vehicleDemo ?? true, vehiclePricing: async () => { throw new Error('not used'); } };
  const service = new CollateralSuggestionService(auto as never, prices as never, haircuts as never, new FakePricing(opts.pricingDemo ?? true), vehicleSettings, new FixedClock(opts.now ?? NOW));
  return { service, auto, prices, haircuts };
}

const apartment = { address: { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Гудамж 1' }, propertyId: 'P-1', areaM2: 60, floor: 5, totalFloors: 12, buildYear: 2010, purpose: 'RESIDENTIAL' };

describe('VEHICLE', () => {
  it('uses the market comparables when the registry and the ads give an estimate', async () => {
    const { service, auto } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
    expect(auto.calls).toEqual([{ req: { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: 90_000 }, correlationId: 'corr-1' }]);
    expect(r.suggestion).toMatchObject({
      available: true,
      method: 'VEHICLE_MARKET_COMPARABLES',
      marketValue: 25_800_000,
      lowValue: 25_000_000,
      highValue: 26_500_000,
      confidence: 'HIGH',
      unavailableReason: null,
      warnings: ['DEMO_PARAMETERS'],
    });
    expect(r.suggestion.basis).toMatchObject({ estimateMethod: 'MARKET_COMPARABLES_V1', vehicleSource: 'REGISTRY', sampleSize: 9, comparablesIncluded: 1, comparablesExcluded: 1, descriptionMatchesRegistry: true, mileageKm: 90_000 });
    expect(r.manualValueRequired).toBe(false);
  });

  it('keeps the plate, the owner and the typed description out of the basis', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: { ...vehicleDescription, vin: 'MOCKVIN1' } }));
    const text = JSON.stringify(r);
    expect(text).not.toContain('УЕН5246');
    expect(text).not.toContain('MOCKVIN1');
    expect(text).not.toMatch(/owner/i);
  });

  it('passes a missing mileage as null and says so; a LOW confidence is flagged', async () => {
    const { service, auto } = setup({ auto: autoResponse({ estimate: { ...autoResponse().estimate!, confidence: 'LOW' } }) });
    const { mileageKm: _m, ...noMileage } = vehicleDescription;
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: noMileage }));
    expect(auto.calls[0].req.mileageKm).toBeNull();
    expect(r.suggestion.warnings).toEqual(['MILEAGE_NOT_PROVIDED', 'LOW_CONFIDENCE', 'DEMO_PARAMETERS']);
  });

  it('a mileage of 0 is a known mileage (a new car), not a missing one', async () => {
    const { service, auto } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: { ...vehicleDescription, mileageKm: 0 } }));
    expect(auto.calls[0].req.mileageKm).toBe(0);
    expect(r.suggestion.warnings).not.toContain('MILEAGE_NOT_PROVIDED');
  });

  it('adds DEMO_PARAMETERS only while the vehicle settings are DEMO', async () => {
    const { service } = setup({ vehicleDemo: false });
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
    expect(r.suggestion.warnings).toEqual([]);
  });

  it('records a registry vehicle that differs from the typed description', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: { ...vehicleDescription, model: 'Aqua' } }));
    expect(r.suggestion.basis).toMatchObject({ descriptionMatchesRegistry: false, model: 'Prius' });
  });

  describe('falls back to base price × depreciation', () => {
    const insufficient = autoResponse({ status: 'INSUFFICIENT_DATA', estimate: null, comparables: [] });

    it('when the ads give too little data: 44,000,000 × (1 − 14 × 3%) = 25,520,000', async () => {
      const { service, prices } = setup({ auto: insufficient });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
      expect(r.suggestion).toMatchObject({ available: true, method: 'VEHICLE_BASE_PRICE', marketValue: 25_520_000, lowValue: null, highValue: null, confidence: null, warnings: ['DEMO_PARAMETERS'] });
      expect(r.suggestion.basis).toMatchObject({ fallbackReason: 'INSUFFICIENT_MARKET_DATA', vehicleSource: 'REGISTRY', basePrice: 44 * M, basePriceVersion: 1, basePriceValidFrom: FROM, ageYears: 14, depreciationRate: 0.42, mileageDeductionRate: 0, valuationYear: 2026 });
      expect(prices.calls).toEqual([{ assetType: 'VEHICLE', keys: [{ make: 'Toyota', model: 'Prius', year: 2012 }], asOf: '2026-10-29' }]);
    });

    it('deducts for a mileage far above the free allowance', async () => {
      const { service } = setup({ auto: insufficient });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: { ...vehicleDescription, mileageKm: 300_000 } }));
      expect(r.suggestion.marketValue).toBe(23_223_200); // 25,520,000 × (1 − 9%)
      expect(r.suggestion.basis).toMatchObject({ mileageDeductionRate: 0.09, excessMileageKm: 90_000 });
    });

    it('takes make/model/year from the registry, not from the typed description', async () => {
      const { service } = setup({ auto: insufficient });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: { ...vehicleDescription, make: 'Honda', model: 'Fit', manufactureYear: 2009 } }));
      expect(r.suggestion.method).toBe('VEHICLE_BASE_PRICE');
      expect(r.suggestion.basis).toMatchObject({ make: 'Toyota', model: 'Prius', manufactureYear: 2012 });
    });

    it('when the registry cannot answer: uses the typed description', async () => {
      const { service } = setup({ auto: new DomainError('REGISTRY_UNAVAILABLE', 'АТҮТ', 502) });
      const { mileageKm: _m, ...noMileage } = vehicleDescription;
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: noMileage }));
      expect(r.suggestion).toMatchObject({ available: true, method: 'VEHICLE_BASE_PRICE', marketValue: 25_520_000, warnings: ['MILEAGE_NOT_PROVIDED', 'DEMO_PARAMETERS'] });
      expect(r.suggestion.basis).toMatchObject({ fallbackReason: 'REGISTRY_UNAVAILABLE', vehicleSource: 'DESCRIPTION' });
    });

    it('flags a base price older than the staleness limit', async () => {
      const { service } = setup({ auto: insufficient, now: new Date('2027-02-01T03:00:00.000Z') }); // 396 days after 2026-01-01
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
      expect(r.suggestion.warnings).toEqual(['BASE_PRICE_STALE', 'DEMO_PARAMETERS']);
      expect(r.suggestion.basis).toMatchObject({ valuationYear: 2027, ageYears: 15, depreciationRate: 0.45 });
    });
  });

  describe('is unavailable (never throws) when nothing can be priced', () => {
    const noPrices: FakePriceRow[] = [];

    it('too little market data and no base price: INSUFFICIENT_DATA', async () => {
      const { service } = setup({ auto: autoResponse({ status: 'INSUFFICIENT_DATA', estimate: null }), prices: noPrices });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
      expect(r.suggestion).toMatchObject({ available: false, method: null, marketValue: null, unavailableReason: 'INSUFFICIENT_DATA', warnings: [] });
      expect(r.suggestion.basis).toMatchObject({ triedMethods: ['VEHICLE_MARKET_COMPARABLES', 'VEHICLE_BASE_PRICE'], basePriceMissing: true });
    });

    it('an ads site failed on top of that: SOURCE_UNAVAILABLE', async () => {
      const { service } = setup({ auto: autoResponse({ status: 'INSUFFICIENT_DATA', estimate: null, warnings: ['SOURCE_UNAVAILABLE'] }), prices: noPrices });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
      expect(r.suggestion.unavailableReason).toBe('SOURCE_UNAVAILABLE');
    });

    it('registry down and no base price: SOURCE_UNAVAILABLE', async () => {
      const { service } = setup({ auto: new DomainError('REGISTRY_UNAVAILABLE', 'АТҮТ', 502), prices: noPrices });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
      expect(r.suggestion).toMatchObject({ available: false, unavailableReason: 'SOURCE_UNAVAILABLE' });
    });

    it('an unknown plate: VEHICLE_NOT_FOUND, without trying the base price', async () => {
      const { service, prices } = setup({ auto: new DomainError('VEHICLE_NOT_FOUND', 'not found', 404) });
      const r = await service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }));
      expect(r.suggestion).toMatchObject({ available: false, marketValue: null, unavailableReason: 'VEHICLE_NOT_FOUND' });
      expect(prices.calls).toEqual([]);
    });

    it('an unexpected failure is not swallowed', async () => {
      const { service } = setup({ auto: new RangeError('bad settings') });
      await expect(service.suggest(CTX, suggestRequest({ assetType: 'VEHICLE', description: vehicleDescription }))).rejects.toThrow(RangeError);
    });
  });
});

describe('APARTMENT / HOUSE (REALTY_BASE_PRICE)', () => {
  it('apartment: khoroo price × area × coefficients = 4.6M × 60 × 0.9 = 248,400,000', async () => {
    const { service, prices } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'APARTMENT', description: apartment }));
    expect(r.suggestion).toMatchObject({ available: true, method: 'REALTY_BASE_PRICE', marketValue: 248_400_000, confidence: null, lowValue: null, highValue: null, warnings: ['DEMO_PARAMETERS'] });
    expect(r.suggestion.basis).toMatchObject({
      district: 'Баянзүрх',
      khoroo: '5-р хороо',
      keyMatch: 'KHOROO',
      unitPricePerM2: 4_600_000,
      areaM2: 60,
      floorPosition: 'MIDDLE',
      purposeCoefficient: 1,
      buildingAgeYears: 16,
      buildingAgeCoefficient: 0.9,
      basePriceVersion: 1,
      basePriceValidFrom: FROM,
    });
    expect(prices.calls[0]).toMatchObject({ assetType: 'APARTMENT', keys: [{ district: 'Баянзүрх', khoroo: '5-р хороо' }, { district: 'Баянзүрх' }] });
    expect(JSON.stringify(r.suggestion)).not.toContain('Гудамж 1'); // street address stays out
  });

  it('apartment: falls back to the district price when the khoroo has none', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'APARTMENT', description: { ...apartment, address: { ...apartment.address, khoroo: '99-р хороо' } } }));
    expect(r.suggestion.marketValue).toBe(226_800_000); // 4.2M × 60 × 0.9
    expect(r.suggestion.basis).toMatchObject({ keyMatch: 'DISTRICT', khoroo: null, unitPricePerM2: 4_200_000 });
  });

  it('apartment: a registry spelling "Баянзүрх дүүрэг" and padded blanks still find the district price', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'APARTMENT', description: { ...apartment, address: { province: 'Улаанбаатар', district: '  Баянзүрх   дүүрэг ' } } }));
    expect(r.suggestion.marketValue).toBe(226_800_000);
  });

  it('apartment: ground floor, commercial purpose and an unknown build year change the coefficients', async () => {
    const { service } = setup();
    const { buildYear: _b, ...noBuildYear } = apartment;
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'APARTMENT', description: { ...noBuildYear, floor: 1, purpose: 'COMMERCIAL' } }));
    expect(r.suggestion.marketValue).toBe(Math.round(4_600_000 * 60 * 0.95 * 1.15 * 0.95 * 100) / 100);
    expect(r.suggestion.basis).toMatchObject({ floorPosition: 'GROUND', buildingAgeYears: null, buildingAgeCoefficient: 0.95 });
  });

  it('house: the floor coefficient does not apply and the land under it is not added', async () => {
    const { service } = setup();
    const description = { address: { province: 'Улаанбаатар', district: 'Налайх' }, certificateNo: 'C-1', areaM2: 100, landAreaM2: 700, floors: 2, buildYear: 2020, purpose: 'RESIDENTIAL' };
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'HOUSE', description }));
    expect(r.suggestion.method).toBe('REALTY_BASE_PRICE');
    expect(r.suggestion.marketValue).toBe(130 * M); // 1.3M × 100 × 1 × 1 × 1 (6 years old)
    expect(r.suggestion.basis).toMatchObject({ floorPosition: 'NOT_APPLICABLE', landAreaM2: 700, landValued: false });
  });

  it('is unavailable with NO_BASE_PRICE outside the price list', async () => {
    const { service } = setup();
    for (const assetType of ['APARTMENT', 'HOUSE'] as const) {
      const r = await service.suggest(CTX, suggestRequest({ assetType, description: { ...apartment, address: { province: 'Дархан-Уул', district: 'Дархан' } } }));
      expect(r.suggestion).toMatchObject({ available: false, method: null, marketValue: null, unavailableReason: 'NO_BASE_PRICE', warnings: [] });
      expect(r.suggestion.basis).toEqual({ district: 'Дархан', khoroo: null });
    }
  });

  it('does not use a price valid only from a later date (the lookup is asked for today in Ulaanbaatar)', async () => {
    const { service, prices } = setup({ now: new Date('2026-10-28T20:30:00.000Z') }); // 04:30 on 29 Oct in Ulaanbaatar, still 28 Oct in UTC
    await service.suggest(CTX, suggestRequest({ assetType: 'APARTMENT', description: apartment }));
    expect(prices.calls[0].asOf).toBe('2026-10-29');
  });
});

describe('LAND', () => {
  const land = { address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, propertyId: 'L-1', areaM2: 500, landUse: 'RESIDENTIAL' };

  it('m² price × area × land-use coefficient', async () => {
    const { service } = setup();
    const residential = await service.suggest(CTX, suggestRequest({ assetType: 'LAND', description: land }));
    expect(residential.suggestion).toMatchObject({ method: 'LAND_BASE_PRICE', marketValue: 900 * M });
    expect(residential.suggestion.basis).toMatchObject({ unitPricePerM2: 1_800_000, landUse: 'RESIDENTIAL', landUseCoefficient: 1 });
    const farm = await service.suggest(CTX, suggestRequest({ assetType: 'LAND', description: { ...land, landUse: 'AGRICULTURAL' } }));
    expect(farm.suggestion.marketValue).toBe(270 * M);
  });

  it('NO_BASE_PRICE when the district has no price', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'LAND', description: { ...land, address: { province: 'Орхон', district: 'Баян-Өндөр' } } }));
    expect(r.suggestion).toMatchObject({ available: false, unavailableReason: 'NO_BASE_PRICE' });
  });
});

describe('LIVESTOCK', () => {
  it('unit price (type, age) × head count', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'LIVESTOCK', description: { livestockType: 'HORSE', ageGroup: 'ADULT', headCount: 40, location: 'Төв аймаг' } }));
    expect(r.suggestion).toMatchObject({ method: 'LIVESTOCK_UNIT_PRICE', marketValue: 72 * M });
    expect(r.suggestion.basis).toMatchObject({ livestockType: 'HORSE', ageGroup: 'ADULT', unitPrice: 1_800_000, headCount: 40 });
    expect(JSON.stringify(r.suggestion)).not.toContain('Төв аймаг');
  });

  it('the age group defaults to ADULT; a missing price is NO_BASE_PRICE', async () => {
    const { service } = setup();
    const adult = await service.suggest(CTX, suggestRequest({ assetType: 'LIVESTOCK', description: { livestockType: 'HORSE', headCount: 1 } }));
    expect(adult.suggestion.marketValue).toBe(1_800_000);
    const camel = await service.suggest(CTX, suggestRequest({ assetType: 'LIVESTOCK', description: { livestockType: 'CAMEL', ageGroup: 'YOUNG', headCount: 2 } }));
    expect(camel.suggestion).toMatchObject({ available: false, unavailableReason: 'NO_BASE_PRICE' });
    expect(camel.suggestion.basis).toEqual({ livestockType: 'CAMEL', ageGroup: 'YOUNG' });
  });

  it('a computed figure above the contract maximum is not offered', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'LIVESTOCK', description: { livestockType: 'SHEEP', ageGroup: 'YOUNG', headCount: 1_000_000 } })); // 1e9 × 1e6
    expect(r.suggestion).toMatchObject({ available: false, marketValue: null, method: null, unavailableReason: 'INSUFFICIENT_DATA' });
    expect(r.suggestion.basis).toMatchObject({ rejected: 'VALUE_OUT_OF_RANGE', method: 'LIVESTOCK_UNIT_PRICE' });
  });
});

describe('INVENTORY, EQUIPMENT, OTHER (the officer enters the value)', () => {
  it('INVENTORY echoes the stocktake value in the basis', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'INVENTORY', description: { name: 'Хүнсний бараа', stocktakeValue: 30 * M, stocktakeDate: '2026-10-01', location: 'Агуулах 4' } }));
    expect(r.suggestion).toMatchObject({ available: false, method: null, marketValue: null, unavailableReason: 'MANUAL_VALUE_ASSET', basis: { stocktakeValue: 30 * M, stocktakeDate: '2026-10-01' } });
    expect(r.manualValueRequired).toBe(true);
  });

  it('EQUIPMENT and OTHER are unavailable too (the purchase price, when given, is echoed)', async () => {
    const { service } = setup();
    const e = await service.suggest(CTX, suggestRequest({ assetType: 'EQUIPMENT', description: { name: 'Экскаватор', purchasePrice: 80 * M } }));
    expect(e.suggestion).toMatchObject({ available: false, unavailableReason: 'MANUAL_VALUE_ASSET', basis: { purchasePrice: 80 * M } });
    const noPrice = await service.suggest(CTX, suggestRequest({ assetType: 'EQUIPMENT', description: { name: 'Хөргөгч' } }));
    expect(noPrice.suggestion.basis).toEqual({});
    const o = await service.suggest(CTX, suggestRequest({ assetType: 'OTHER', description: { name: 'Бусад' } }));
    expect(o.suggestion).toMatchObject({ available: false, unavailableReason: 'MANUAL_VALUE_ASSET' });
    expect(o.manualValueRequired).toBe(true);
  });
});

describe('the description is re-checked against its asset type', () => {
  it.each([
    ['VEHICLE', { plateNo: 'ABC', make: 'Toyota', model: 'Prius', manufactureYear: 2012 }, 'description.plateNo'],
    ['APARTMENT', { ...apartment, areaM2: -1 }, 'description.areaM2'],
    ['HOUSE', { areaM2: 50, address: { province: 'Улаанбаатар', district: 'Налайх' } }, 'description.propertyId'],
    ['LAND', { address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, certificateNo: 'C', areaM2: 0 }, 'description.areaM2'],
    ['LIVESTOCK', { livestockType: 'DRAGON', headCount: 3 }, 'description.livestockType'],
    ['INVENTORY', { name: 'x', stocktakeValue: -5, stocktakeDate: '2026-10-01' }, 'description.stocktakeValue'],
    ['EQUIPMENT', {}, 'description.name'],
    ['OTHER', { name: '' }, 'description.name'],
  ] as const)('%s with a wrong description is a 400 VALIDATION_FAILED', async (assetType, description, path) => {
    const { service, auto } = setup();
    const err = await service.suggest(CTX, suggestRequest({ assetType, description })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('VALIDATION_FAILED');
    expect((err as DomainError).getStatus()).toBe(400);
    expect(((err as DomainError).details as { path: string }[]).map((d) => d.path)).toContain(path);
    expect(auto.calls).toEqual([]); // nothing external was called for a bad description
  });
});

describe('haircut resolution (FR-14.2): PRODUCT_RULE > PRODUCT_JSON > ORG_RULE > DEMO_DEFAULT', () => {
  const request = (productHaircutRate: number | null, productId: string | null = 'prod-1') =>
    suggestRequest({ assetType: 'OTHER', description: { name: 'x' }, productId, productHaircutRate });

  it('asks the rules of the product and the asset type', async () => {
    const { service, haircuts } = setup();
    await service.suggest(CTX, request(null));
    expect(haircuts.calls).toEqual([{ productId: 'prod-1', assetType: 'OTHER' }]);
  });

  it('1. the product rule beats everything', async () => {
    const { service, haircuts } = setup();
    haircuts.rates = { productRule: 0.55, orgRule: 0.65 };
    expect((await service.suggest(CTX, request(0.6))).haircut).toEqual({ rate: 0.55, source: 'PRODUCT_RULE' });
  });

  it('2. then product.haircut_json sent by origination', async () => {
    const { service, haircuts } = setup();
    haircuts.rates = { productRule: null, orgRule: 0.65 };
    expect((await service.suggest(CTX, request(0.6))).haircut).toEqual({ rate: 0.6, source: 'PRODUCT_JSON' });
  });

  it('3. then the org-wide rule', async () => {
    const { service, haircuts } = setup();
    haircuts.rates = { productRule: null, orgRule: 0.65 };
    expect((await service.suggest(CTX, request(null))).haircut).toEqual({ rate: 0.65, source: 'ORG_RULE' });
  });

  it('4. then the DEMO default of the asset type', async () => {
    const { service } = setup();
    expect((await service.suggest(CTX, request(null, null))).haircut).toEqual({ rate: DEMO_COLLATERAL_PRICING.defaultHaircuts.OTHER, source: 'DEMO_DEFAULT' });
    expect(DEMO_COLLATERAL_PRICING.defaultHaircuts).toEqual({ VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 });
  });

  it('a product without id looks for the org-wide rule only', async () => {
    const { service, haircuts } = setup();
    await service.suggest(CTX, request(null, null));
    expect(haircuts.calls).toEqual([{ productId: null, assetType: 'OTHER' }]);
  });
});

describe('response envelope', () => {
  it('echoes the asset type and the external-valuation threshold', async () => {
    const { service } = setup();
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'LAND', description: { address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, propertyId: 'L', areaM2: 100 }, externalValuationThreshold: 100 * M }));
    expect(r.assetType).toBe('LAND');
    expect(r.externalValuationThreshold).toBe(100 * M);
    expect(r.manualValueRequired).toBe(false);
  });

  it('carries no DEMO_PARAMETERS warning once the pricing parameters are real', async () => {
    const { service } = setup({ pricingDemo: false });
    const r = await service.suggest(CTX, suggestRequest({ assetType: 'APARTMENT', description: apartment }));
    expect(r.suggestion.available).toBe(true);
    expect(r.suggestion.warnings).toEqual([]);
  });
});
