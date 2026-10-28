import { BadGatewayException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { estimateMarketPrice, type ComparableOutcome, type MarketListingInput } from '@los/calc';
import {
  VehicleInfo,
  type AutoValuationRequest,
  type AutoValuationResponse,
  type MarketComparable,
  type SourceReport,
  type VehicleLookupResponse,
} from '@los/contracts';
import type { z, ZodTypeAny } from 'zod';
import { CLOCK, type Clock } from '../../common/clock';
import { callWithTimeout } from '../../integrations/call-with-timeout';
import { IntegrationError } from '../../integrations/integration.types';
import {
  MAX_LISTINGS_PER_SOURCE,
  VEHICLE_LISTING_SOURCES,
  VehicleListingSchema,
  type VehicleListing,
  type VehicleListingQuery,
  type VehicleListingSource,
} from '../../integrations/listings/vehicle-listing-source.port';
import { VEHICLE_REGISTRY, type VehicleRegistry } from '../../integrations/vehicle-registry/vehicle-registry.port';
import { VALUATION_SETTINGS, type ValuationSettings, type VehiclePricingSettings } from './valuation-settings.port';

const REGISTRY_ID = 'ATUT';
type Warning = AutoValuationResponse['warnings'][number];
type CallBase = { correlationId: string; now: Date };
type SourceResult = { report: SourceReport; listings: VehicleListing[] };

const errorCodeOf = (error: unknown): string => (error instanceof IntegrationError ? error.code : 'UNEXPECTED');
const ListingsSchema = VehicleListingSchema.array().max(MAX_LISTINGS_PER_SOURCE);
const MAX_LOGGED_ISSUES = 5;

/** FR-14.1 / FR-14.2. Stateless: nothing is persisted and no personal data (plate, owner) is logged. */
@Injectable()
export class AutoValuationService {
  private readonly logger = new Logger(AutoValuationService.name);

  constructor(
    @Inject(VEHICLE_REGISTRY) private readonly registry: VehicleRegistry,
    @Inject(VEHICLE_LISTING_SOURCES) private readonly sources: VehicleListingSource[],
    @Inject(VALUATION_SETTINGS) private readonly settings: ValuationSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async lookupVehicle(plateNo: string, correlationId: string): Promise<VehicleLookupResponse> {
    const now = this.clock.now();
    const { externalTimeoutMs } = await this.settings.vehiclePricing();
    const vehicle = await this.fetchVehicle(plateNo, externalTimeoutMs, { correlationId, now });
    return { vehicle, fetchedAt: now.toISOString() };
  }

  async autoValuateVehicle(req: AutoValuationRequest, correlationId: string): Promise<AutoValuationResponse> {
    const now = this.clock.now();
    const settings = await this.settings.vehiclePricing();
    const base: CallBase = { correlationId, now };
    // One budget for the whole request: the registry and the ads sites share externalTimeoutMs instead of adding up to twice that.
    const startedAt = performance.now();
    const remainingMs = (): number => Math.max(0, settings.externalTimeoutMs - (performance.now() - startedAt));
    const vehicle = await this.fetchVehicle(req.plateNo, settings.externalTimeoutMs, base);

    const query: VehicleListingQuery = {
      make: vehicle.make,
      model: vehicle.model,
      yearFrom: vehicle.manufactureYear - settings.yearTolerance,
      yearTo: vehicle.manufactureYear + settings.yearTolerance,
    };
    const mileageKm = req.mileageKm ?? null;
    const results = await Promise.all(this.sources.map((source) => this.searchSource(source, query, remainingMs(), base)));

    // Sources stay in configuration order and are not de-duplicated across sites: the same car on two sites counts twice.
    const merged = results.flatMap(({ report, listings }) => listings.map((listing) => ({ source: report.id, listing })));
    const inputs: MarketListingInput[] = merged.map(({ source, listing }) => ({
      id: `${source}:${listing.externalId}`,
      make: listing.make,
      model: listing.model,
      year: listing.year,
      mileageKm: listing.mileageKm,
      price: listing.price,
      currency: listing.currency,
      postedAt: listing.postedAt,
    }));
    const { estimate, outcomes } = estimateMarketPrice(
      { make: vehicle.make, model: vehicle.model, year: vehicle.manufactureYear, mileageKm },
      inputs,
      settings,
      now,
    );

    const listingReports = results.map((r) => r.report);
    const warnings: Warning[] = [];
    if (listingReports.some((r) => r.status === 'ERROR')) warnings.push('SOURCE_UNAVAILABLE');
    if (mileageKm === null) warnings.push('MILEAGE_NOT_PROVIDED');
    if (estimate?.confidence === 'LOW') warnings.push('LOW_CONFIDENCE');

    // The owner is personal data; the valuation result (which the caller may store) never carries it.
    const { owner: _owner, ...vehicleSummary } = vehicle;
    return {
      assetType: 'VEHICLE',
      status: estimate ? 'OK' : 'INSUFFICIENT_DATA',
      valuedAt: now.toISOString(),
      request: { plateNo: req.plateNo, mileageKm },
      vehicle: vehicleSummary,
      estimate: estimate ? { ...estimate, currency: 'MNT', method: 'MARKET_COMPARABLES_V1' } : null,
      // Calc returns one outcome per input, in input order.
      comparables: merged.map(({ source, listing }, i) => toComparable(source, listing, outcomes[i])),
      sources: [
        { id: REGISTRY_ID, kind: 'GOVERNMENT_REGISTRY', status: 'OK', count: 1, errorCode: null, fetchedAt: now.toISOString() },
        ...listingReports,
      ],
      parameters: numericParameters(settings),
      warnings,
    };
  }

  private async fetchVehicle(plateNo: string, timeoutMs: number, base: CallBase): Promise<VehicleInfo> {
    let vehicle: VehicleInfo | null;
    try {
      const raw = await callWithTimeout(REGISTRY_ID, timeoutMs, base, (ctx) => this.registry.lookup(plateNo, ctx));
      vehicle = raw === null ? null : this.checked(REGISTRY_ID, VehicleInfo, raw, base);
    } catch (error) {
      // Source id and code only: adapter messages may carry the plate or owner data.
      this.log('error', 'registry_failed', { source: REGISTRY_ID, code: errorCodeOf(error), correlationId: base.correlationId });
      throw new BadGatewayException({
        code: 'REGISTRY_UNAVAILABLE',
        message:
          'The vehicle registry (АТҮТ) did not answer. Try again in a few minutes; if it keeps failing, enter the collateral value manually.',
      });
    }
    if (!vehicle) {
      throw new NotFoundException({
        code: 'VEHICLE_NOT_FOUND',
        message: 'No vehicle is registered under this plate number. Check the plate number and try again.',
      });
    }
    return vehicle;
  }

  // Adapters are external code: whatever they return is checked before it reaches the calculation.
  // On a violation the log names the offending fields (path and zod code, never the values) so the adapter can be fixed.
  private checked<S extends ZodTypeAny>(integration: string, schema: S, value: unknown, base: CallBase): z.output<S> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.slice(0, MAX_LOGGED_ISSUES).map((issue) => `${issue.path.join('.')}:${issue.code}`);
    this.log('warn', 'adapter_contract_violation', { source: integration, issues, correlationId: base.correlationId });
    throw new IntegrationError(integration, 'BAD_RESPONSE', `${integration} returned a payload that does not match the adapter contract`);
  }

  // One JSON object per line, always with the correlationId (CLAUDE.md §3.2 rule 10); never the plate, owner or adapter messages.
  private log(level: 'warn' | 'error', event: string, fields: Record<string, string | string[]>): void {
    this.logger[level](JSON.stringify({ event, ...fields }));
  }

  /** Never rejects: one failing ads site must not fail the valuation (it becomes an ERROR source report). */
  private async searchSource(
    source: VehicleListingSource,
    query: VehicleListingQuery,
    timeoutMs: number,
    base: CallBase,
  ): Promise<SourceResult> {
    const fetchedAt = base.now.toISOString();
    try {
      const raw = await callWithTimeout(source.id, timeoutMs, base, (ctx) => source.search(query, ctx));
      const listings = this.checked(source.id, ListingsSchema, raw, base);
      const report: SourceReport = { id: source.id, kind: 'CLASSIFIED_ADS', status: 'OK', count: listings.length, errorCode: null, fetchedAt };
      return { report, listings };
    } catch (error) {
      const errorCode = errorCodeOf(error);
      this.log('warn', 'listing_source_failed', { source: source.id, code: errorCode, correlationId: base.correlationId });
      return { report: { id: source.id, kind: 'CLASSIFIED_ADS', status: 'ERROR', count: null, errorCode, fetchedAt }, listings: [] };
    }
  }
}

const toComparable = (source: string, l: VehicleListing, o: ComparableOutcome): MarketComparable => ({
  source,
  externalId: l.externalId,
  url: l.url,
  title: l.title,
  year: l.year,
  mileageKm: l.mileageKm,
  listedPrice: l.price,
  currency: l.currency,
  postedAt: l.postedAt,
  priceMnt: o.priceMnt,
  adjustedPriceMnt: o.adjustedPriceMnt,
  included: o.included,
  exclusionReason: o.exclusionReason,
});

// Recorded in the response so a valuation can be reproduced later (the response is storable as collateral_valuation.method_json).
const numericParameters = (settings: VehiclePricingSettings): Record<string, number> =>
  Object.fromEntries(Object.entries(settings).filter(([, value]) => typeof value === 'number'));
