import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  isBasePriceStale,
  landValue,
  livestockValue,
  realtyValue,
  resolveHaircut,
  vehicleBasePriceValue,
  type CollateralPricingParams,
} from '@los/calc';
import {
  isManualValueAsset,
  parseCollateralDescription,
  type AssetType,
  type AutoValuationResponse,
  type MarketEstimate,
  type RequestContext,
  type SuggestionUnavailableReason,
  type SuggestionWarning,
  type SuggestValuationRequest,
  type SuggestValuationResponse,
  type ValuationMethod,
  type ValuationSuggestion,
} from '@los/contracts';
import { Clock, DomainError } from '@los/nest-common';
import { todayUb } from '../../common/dates';
import { BasePriceLookupService, type BasePriceHit } from '../base-price/base-price-lookup.service';
import { livestockKeys, realtyKeys, vehicleKeys } from '../base-price/base-price.keys';
import { HaircutLookupService } from '../haircut/haircut-lookup.service';
import { AutoValuationService } from '../valuation/auto-valuation.service';
import { VALUATION_SETTINGS, type ValuationSettings } from '../valuation/valuation-settings.port';
import { COLLATERAL_PRICING_SETTINGS, type CollateralPricingSettings } from './collateral-pricing-settings.port';

/** `SaveCollateralValuationRequest.marketValue` is capped at this by the contract; a computed suggestion above it is not believable. */
const MAX_MARKET_VALUE = 1e12;

type Description<T extends AssetType> = ReturnType<typeof parseCollateralDescription<T>>;
type Env = { orgId: string; correlationId: string; today: string; valuationYear: number; params: CollateralPricingParams; pricingDemo: boolean };
type VehicleFallback = 'REGISTRY_UNAVAILABLE' | 'LISTINGS_UNAVAILABLE' | 'INSUFFICIENT_MARKET_DATA';

const isoName = (e: unknown): string | undefined => (e instanceof Error ? e.name : undefined);
const isDomain = (e: unknown, code: string): boolean => e instanceof DomainError && e.code === code;

export const unavailable = (reason: SuggestionUnavailableReason, basis: Record<string, unknown> = {}): ValuationSuggestion => ({
  available: false,
  method: null,
  marketValue: null,
  lowValue: null,
  highValue: null,
  confidence: null,
  basis,
  warnings: [],
  unavailableReason: reason,
});

interface AvailableInput {
  method: ValuationMethod;
  marketValue: number;
  basis: Record<string, unknown>;
  warnings: SuggestionWarning[];
  lowValue?: number;
  highValue?: number;
  confidence?: MarketEstimate['confidence'];
}
const available = (a: AvailableInput): ValuationSuggestion => ({
  available: true,
  method: a.method,
  marketValue: a.marketValue,
  lowValue: a.lowValue ?? null,
  highValue: a.highValue ?? null,
  confidence: a.confidence ?? null,
  basis: a.basis,
  warnings: a.warnings,
  unavailableReason: null,
});

/** Warnings in the order of the contract's enum; `DEMO_PARAMETERS` while the parameters are DEMO placeholders. */
const warningsOf = (w: { mileageMissing?: boolean; lowConfidence?: boolean; stale?: boolean; demo: boolean }): SuggestionWarning[] => [
  ...(w.mileageMissing ? (['MILEAGE_NOT_PROVIDED'] as const) : []),
  ...(w.lowConfidence ? (['LOW_CONFIDENCE'] as const) : []),
  ...(w.stale ? (['BASE_PRICE_STALE'] as const) : []),
  ...(w.demo ? (['DEMO_PARAMETERS'] as const) : []),
];

/**
 * FR-14.1, FR-14.2 — the system's market-value suggestion and the haircut for one collateral. Stateless: nothing is persisted here.
 * The description is re-parsed with the asset type's schema (never trust the caller); the plate, owner and street address never reach
 * `basis`, the logs or anything else this service returns.
 */
@Injectable()
export class CollateralSuggestionService {
  private readonly logger = new Logger(CollateralSuggestionService.name);

  constructor(
    @Inject(AutoValuationService) private readonly auto: AutoValuationService,
    @Inject(BasePriceLookupService) private readonly prices: BasePriceLookupService,
    @Inject(HaircutLookupService) private readonly haircuts: HaircutLookupService,
    @Inject(COLLATERAL_PRICING_SETTINGS) private readonly pricing: CollateralPricingSettings,
    @Inject(VALUATION_SETTINGS) private readonly vehicleSettings: ValuationSettings,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  async suggest(ctx: RequestContext, req: SuggestValuationRequest): Promise<SuggestValuationResponse> {
    const now = this.clock.now();
    const today = todayUb(now);
    const params = await this.pricing.pricing();
    const env: Env = { orgId: ctx.orgId, correlationId: ctx.correlationId, today, valuationYear: Number(today.slice(0, 4)), params, pricingDemo: this.pricing.demo };

    const suggestion = this.sane(await this.compute(req, env));
    const rates = await this.haircuts.findRates(ctx.orgId, req.productId, req.assetType);
    // FR-14.2 order: haircut_rule(product) > product.haircut_json (req.productHaircutRate) > haircut_rule(org-wide) > DEMO default.
    const haircut = resolveHaircut({ productRule: rates.productRule, productJson: req.productHaircutRate, orgRule: rates.orgRule, demoDefault: params.defaultHaircuts[req.assetType] });
    return { assetType: req.assetType, suggestion, haircut, manualValueRequired: isManualValueAsset(req.assetType), externalValuationThreshold: req.externalValuationThreshold };
  }

  /** The description parsed with its asset type's schema; a mismatch is a 400 whose paths start with `description.`. */
  private parse<T extends AssetType>(assetType: T, description: unknown): Description<T> {
    try {
      return parseCollateralDescription(assetType, description);
    } catch (e) {
      const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
      if (isoName(e) !== 'ZodError' || !issues) throw e;
      throw new DomainError(
        'VALIDATION_FAILED',
        'Оруулсан өгөгдөл буруу',
        HttpStatus.BAD_REQUEST,
        issues.map((i) => ({ path: ['description', ...i.path].join('.'), message: i.message })),
      );
    }
  }

  private async compute(req: SuggestValuationRequest, env: Env): Promise<ValuationSuggestion> {
    switch (req.assetType) {
      case 'VEHICLE':
        return this.vehicle(this.parse('VEHICLE', req.description), env);
      case 'APARTMENT':
        return this.realty('APARTMENT', this.parse('APARTMENT', req.description), env);
      case 'HOUSE':
        return this.realty('HOUSE', this.parse('HOUSE', req.description), env);
      case 'LAND':
        return this.land(this.parse('LAND', req.description), env);
      case 'LIVESTOCK':
        return this.livestock(this.parse('LIVESTOCK', req.description), env);
      case 'INVENTORY': {
        // FR-14.1: the stocktake value is what the officer enters; echoed so the screen can prefill it.
        const d = this.parse('INVENTORY', req.description);
        return unavailable('MANUAL_VALUE_ASSET', { stocktakeValue: d.stocktakeValue, stocktakeDate: d.stocktakeDate });
      }
      case 'EQUIPMENT': {
        const d = this.parse('EQUIPMENT', req.description);
        return unavailable('MANUAL_VALUE_ASSET', d.purchasePrice === undefined ? {} : { purchasePrice: d.purchasePrice });
      }
      case 'OTHER':
        this.parse('OTHER', req.description);
        return unavailable('MANUAL_VALUE_ASSET');
    }
  }

  /** A computed figure that is not a positive number inside the contract's range is not offered as a suggestion. */
  private sane(s: ValuationSuggestion): ValuationSuggestion {
    if (!s.available || (s.marketValue !== null && s.marketValue > 0 && s.marketValue <= MAX_MARKET_VALUE)) return s;
    return unavailable('INSUFFICIENT_DATA', { ...s.basis, rejected: 'VALUE_OUT_OF_RANGE', method: s.method });
  }

  // ── VEHICLE: market comparables (АТҮТ + ads) → base price × depreciation → unavailable ──────────────────────────────────
  private async vehicle(d: Description<'VEHICLE'>, env: Env): Promise<ValuationSuggestion> {
    const mileageKm = d.mileageKm ?? null;
    const demo = env.pricingDemo; // base-price parameters
    let registry: { make: string; model: string; manufactureYear: number } | null = null;
    let fallback: VehicleFallback;
    try {
      const auto = await this.auto.autoValuateVehicle({ assetType: 'VEHICLE', plateNo: d.plateNo, mileageKm }, env.correlationId);
      registry = { make: auto.vehicle.make, model: auto.vehicle.model, manufactureYear: auto.vehicle.manufactureYear };
      if (auto.status === 'OK' && auto.estimate) return this.fromComparables(auto, auto.estimate, d, mileageKm);
      fallback = auto.warnings.includes('SOURCE_UNAVAILABLE') ? 'LISTINGS_UNAVAILABLE' : 'INSUFFICIENT_MARKET_DATA';
    } catch (e) {
      // The caller asked about a plate the registry does not know: nothing to fall back on (the registry is the authority on the vehicle).
      if (isDomain(e, 'VEHICLE_NOT_FOUND')) return unavailable('VEHICLE_NOT_FOUND');
      if (!isDomain(e, 'REGISTRY_UNAVAILABLE')) throw e;
      fallback = 'REGISTRY_UNAVAILABLE';
    }
    this.logger.warn('vehicle_market_comparables_unavailable', { reason: fallback });

    // FR-14.1 fallback: base price(make, model, year) × depreciation. The registry's vehicle wins over the typed description when we have it.
    const vehicle = registry ?? { make: d.make, model: d.model, manufactureYear: d.manufactureYear };
    const hit = await this.prices.find(env.orgId, 'VEHICLE', vehicleKeys({ make: vehicle.make, model: vehicle.model, year: vehicle.manufactureYear }), env.today);
    if (!hit) {
      return unavailable(fallback === 'INSUFFICIENT_MARKET_DATA' ? 'INSUFFICIENT_DATA' : 'SOURCE_UNAVAILABLE', {
        triedMethods: ['VEHICLE_MARKET_COMPARABLES', 'VEHICLE_BASE_PRICE'],
        fallbackReason: fallback,
        basePriceMissing: true,
        make: vehicle.make,
        model: vehicle.model,
        manufactureYear: vehicle.manufactureYear,
      });
    }
    const r = vehicleBasePriceValue({ basePrice: hit.unitPrice, manufactureYear: vehicle.manufactureYear, valuationYear: env.valuationYear, mileageKm }, env.params.vehicle);
    return available({
      method: 'VEHICLE_BASE_PRICE',
      marketValue: r.marketValue,
      warnings: warningsOf({ mileageMissing: mileageKm === null, stale: this.stale(hit, env), demo }),
      basis: {
        fallbackReason: fallback,
        vehicleSource: registry ? 'REGISTRY' : 'DESCRIPTION',
        make: vehicle.make,
        model: vehicle.model,
        manufactureYear: vehicle.manufactureYear,
        basePrice: hit.unitPrice,
        ...this.priceRef(hit),
        valuationYear: env.valuationYear,
        ageYears: r.ageYears,
        depreciationRate: r.depreciationRate,
        mileageKm,
        mileageDeductionRate: r.mileageDeductionRate,
        excessMileageKm: r.excessMileageKm,
      },
    });
  }

  private fromComparables(
    auto: AutoValuationResponse,
    estimate: MarketEstimate,
    d: Description<'VEHICLE'>,
    mileageKm: number | null,
  ): ValuationSuggestion {
    const matchesDescription =
      auto.vehicle.make === d.make && auto.vehicle.model === d.model && auto.vehicle.manufactureYear === d.manufactureYear;
    return available({
      method: 'VEHICLE_MARKET_COMPARABLES',
      marketValue: estimate.marketValue,
      lowValue: estimate.lowValue,
      highValue: estimate.highValue,
      confidence: estimate.confidence,
      warnings: warningsOf({ mileageMissing: mileageKm === null, lowConfidence: estimate.confidence === 'LOW', demo: this.vehicleSettings.demo === true }),
      basis: {
        estimateMethod: estimate.method,
        vehicleSource: 'REGISTRY',
        make: auto.vehicle.make,
        model: auto.vehicle.model,
        manufactureYear: auto.vehicle.manufactureYear,
        descriptionMatchesRegistry: matchesDescription,
        mileageKm,
        sampleSize: estimate.sampleSize,
        meanValue: estimate.meanValue,
        comparablesIncluded: auto.comparables.filter((c) => c.included).length,
        comparablesExcluded: auto.comparables.filter((c) => !c.included).length,
        sources: auto.sources.map((s) => ({ id: s.id, kind: s.kind, status: s.status, count: s.count })),
      },
    });
  }

  // ── APARTMENT / HOUSE: m² price(district[, khoroo]) × area × floor × purpose × building-age coefficients ─────────────────
  private async realty(
    assetType: 'APARTMENT' | 'HOUSE',
    d: Description<'APARTMENT'> | Description<'HOUSE'>,
    env: Env,
  ): Promise<ValuationSuggestion> {
    const { district, khoroo } = d.address;
    const hit = await this.prices.find(env.orgId, assetType, realtyKeys(district, khoroo), env.today);
    if (!hit) return unavailable('NO_BASE_PRICE', { district, khoroo: khoroo ?? null });
    const apartment = assetType === 'APARTMENT' ? (d as Description<'APARTMENT'>) : null;
    const r = realtyValue(
      {
        assetType,
        unitPrice: hit.unitPrice,
        areaM2: d.areaM2,
        floor: apartment?.floor ?? null,
        totalFloors: apartment?.totalFloors ?? null,
        purpose: d.purpose,
        buildYear: d.buildYear ?? null,
        valuationYear: env.valuationYear,
      },
      env.params.realty,
    );
    const landAreaM2 = assetType === 'HOUSE' ? (d as Description<'HOUSE'>).landAreaM2 : undefined;
    return available({
      method: 'REALTY_BASE_PRICE',
      marketValue: r.marketValue,
      warnings: warningsOf({ stale: this.stale(hit, env), demo: env.pricingDemo }),
      basis: {
        district: hit.key.district,
        khoroo: hit.key.khoroo ?? null,
        keyMatch: 'khoroo' in hit.key ? 'KHOROO' : 'DISTRICT',
        unitPricePerM2: hit.unitPrice,
        ...this.priceRef(hit),
        areaM2: d.areaM2,
        floor: apartment?.floor ?? null,
        totalFloors: apartment?.totalFloors ?? null,
        floorPosition: r.floorPosition,
        floorCoefficient: r.floorCoefficient,
        purpose: d.purpose,
        purposeCoefficient: r.purposeCoefficient,
        buildYear: d.buildYear ?? null,
        buildingAgeYears: r.buildingAgeYears,
        buildingAgeCoefficient: r.buildingAgeCoefficient,
        valuationYear: env.valuationYear,
        // The land under a house is not added to the building price; the officer adds it through an override if it should count.
        ...(landAreaM2 === undefined ? {} : { landAreaM2, landValued: false }),
      },
    });
  }

  // ── LAND: m² price × area × land-use coefficient ───────────────────────────────────────────────────────────────────────
  private async land(d: Description<'LAND'>, env: Env): Promise<ValuationSuggestion> {
    const { district, khoroo } = d.address;
    const hit = await this.prices.find(env.orgId, 'LAND', realtyKeys(district, khoroo), env.today);
    if (!hit) return unavailable('NO_BASE_PRICE', { district, khoroo: khoroo ?? null });
    const r = landValue({ unitPrice: hit.unitPrice, areaM2: d.areaM2, landUse: d.landUse }, env.params.land);
    return available({
      method: 'LAND_BASE_PRICE',
      marketValue: r.marketValue,
      warnings: warningsOf({ stale: this.stale(hit, env), demo: env.pricingDemo }),
      basis: {
        district: hit.key.district,
        khoroo: hit.key.khoroo ?? null,
        keyMatch: 'khoroo' in hit.key ? 'KHOROO' : 'DISTRICT',
        unitPricePerM2: hit.unitPrice,
        ...this.priceRef(hit),
        areaM2: d.areaM2,
        landUse: d.landUse,
        landUseCoefficient: r.landUseCoefficient,
      },
    });
  }

  // ── LIVESTOCK: unit price(type, age group) × head count ────────────────────────────────────────────────────────────────
  private async livestock(d: Description<'LIVESTOCK'>, env: Env): Promise<ValuationSuggestion> {
    const hit = await this.prices.find(env.orgId, 'LIVESTOCK', livestockKeys({ livestockType: d.livestockType, ageGroup: d.ageGroup }), env.today);
    if (!hit) return unavailable('NO_BASE_PRICE', { livestockType: d.livestockType, ageGroup: d.ageGroup });
    return available({
      method: 'LIVESTOCK_UNIT_PRICE',
      marketValue: livestockValue({ unitPrice: hit.unitPrice, headCount: d.headCount }),
      warnings: warningsOf({ stale: this.stale(hit, env), demo: env.pricingDemo }),
      basis: { livestockType: d.livestockType, ageGroup: d.ageGroup, unitPrice: hit.unitPrice, ...this.priceRef(hit), headCount: d.headCount },
    });
  }

  private stale(hit: BasePriceHit, env: Env): boolean {
    return isBasePriceStale(hit.validFrom, env.today, env.params.basePriceStaleDays);
  }

  private priceRef(hit: BasePriceHit): Record<string, unknown> {
    return { basePriceVersion: hit.version, basePriceValidFrom: hit.validFrom };
  }
}
