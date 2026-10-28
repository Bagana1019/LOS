import { afterEach, describe, it, expect, vi } from 'vitest';
import { BadGatewayException, Logger, NotFoundException, type HttpException } from '@nestjs/common';
import { AutoValuationResponse, VehicleLookupResponse, type AutoValuationRequest, type VehicleInfo } from '@los/contracts';
import type { Clock } from '../../common/clock';
import { IntegrationError, type IntegrationContext } from '../../integrations/integration.types';
import type { VehicleListing, VehicleListingQuery, VehicleListingSource } from '../../integrations/listings/vehicle-listing-source.port';
import type { VehicleRegistry } from '../../integrations/vehicle-registry/vehicle-registry.port';
import { AutoValuationService } from './auto-valuation.service';
import type { VehiclePricingSettings } from './valuation-settings.port';

const NOW = new Date('2026-10-28T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// Sentinel personal data: must never show up in log output.
const PLATE = 'УЕН5246';
const OWNER_NAME = 'Секрет Эзэмшигч';
const OWNER_REGISTER = 'ЗЗ12345678';
const VEHICLE: VehicleInfo = {
  plateNo: PLATE,
  vin: 'TESTVIN0000000001',
  make: 'Toyota',
  model: 'Prius',
  manufactureYear: 2012,
  importYear: 2016,
  engineCc: 1798,
  fuelType: 'HYBRID',
  color: 'Цагаан',
  owner: { registerNo: OWNER_REGISTER, name: OWNER_NAME },
  registeredAt: '2016-05-20',
};

const SETTINGS: VehiclePricingSettings = {
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
  externalTimeoutMs: 200,
};

const REQ: AutoValuationRequest = { assetType: 'VEHICLE', plateNo: PLATE, mileageKm: 100_000 };

const ad = (externalId: string, overrides: Partial<VehicleListing> = {}): VehicleListing => ({
  externalId,
  url: `https://example.invalid/${externalId}`,
  title: `Toyota Prius ${externalId}`,
  make: 'Toyota',
  model: 'Prius',
  year: 2012,
  mileageKm: 100_000,
  price: 25_000_000,
  currency: 'MNT',
  postedAt: daysAgo(1),
  ...overrides,
});

const listingSource = (id: string, listings: VehicleListing[]) => ({
  id,
  search: vi.fn(async (_query: VehicleListingQuery, _ctx: IntegrationContext) => listings),
});
const failingSource = (id: string, error: unknown) => ({
  id,
  search: vi.fn(async (_query: VehicleListingQuery, _ctx: IntegrationContext): Promise<VehicleListing[]> => {
    throw error;
  }),
});
const hangingSource = (id: string) => ({
  id,
  search: vi.fn((_query: VehicleListingQuery, _ctx: IntegrationContext) => new Promise<VehicleListing[]>(() => undefined)),
});
const registryReturning = (vehicle: VehicleInfo | null) => ({
  lookup: vi.fn(async (_plateNo: string, _ctx: IntegrationContext) => vehicle),
});

function build(opts: { registry?: VehicleRegistry; sources?: VehicleListingSource[]; settings?: Partial<VehiclePricingSettings> } = {}) {
  const settings = { ...SETTINGS, ...opts.settings };
  const registry = opts.registry ?? registryReturning(VEHICLE);
  return new AutoValuationService(registry, opts.sources ?? [], { vehiclePricing: async () => settings }, clock);
}

const rejection = async (pending: Promise<unknown>): Promise<HttpException> => {
  try {
    await pending;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected the promise to reject');
};

// Five included comparables (24, 25, 25, 26, 26.6 M after adjustment), one other model, spread over two sites.
const siteA = () =>
  listingSource('SITE_A', [
    ad('a1', { price: 24_000_000 }),
    ad('a2', { price: 25_000_000 }),
    ad('a3', { price: 26_000_000 }),
    ad('a4', { model: 'Prius Alpha', price: 30_000_000 }),
  ]);
const siteB = () => listingSource('SITE_B', [ad('b1', { price: 25_000_000 }), ad('b2', { year: 2013, price: 28_000_000 })]);

afterEach(() => vi.restoreAllMocks());

describe('AutoValuationService.lookupVehicle', () => {
  it('returns the registry record with the request time', async () => {
    const registry = registryReturning(VEHICLE);
    const res = await build({ registry }).lookupVehicle(PLATE, 'corr-1');
    expect(res).toEqual({ vehicle: VEHICLE, fetchedAt: NOW.toISOString() });
    expect(() => VehicleLookupResponse.parse(res)).not.toThrow();
    expect(registry.lookup).toHaveBeenCalledOnce();
    const [plate, ctx] = registry.lookup.mock.calls[0];
    expect(plate).toBe(PLATE);
    expect(ctx).toMatchObject({ correlationId: 'corr-1', now: NOW });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws NotFound VEHICLE_NOT_FOUND when the plate is not registered', async () => {
    const error = await rejection(build({ registry: registryReturning(null) }).lookupVehicle(PLATE, 'corr-1'));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getResponse()).toMatchObject({ code: 'VEHICLE_NOT_FOUND', message: expect.any(String) });
  });

  it.each([
    ['an IntegrationError', new IntegrationError('ATUT', 'UNAVAILABLE', 'connection refused')],
    ['an unexpected error', new TypeError('boom')],
  ])('throws BadGateway REGISTRY_UNAVAILABLE on %s', async (_label, cause) => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const registry = { lookup: vi.fn(async () => Promise.reject(cause)) };
    const error = await rejection(build({ registry }).lookupVehicle(PLATE, 'corr-1'));
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.getResponse()).toMatchObject({ code: 'REGISTRY_UNAVAILABLE', message: expect.stringContaining('Try again') });
  });

  it('throws BadGateway REGISTRY_UNAVAILABLE when the registry does not answer in time', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const registry = { lookup: vi.fn(() => new Promise<VehicleInfo | null>(() => undefined)) };
    const error = await rejection(build({ registry, settings: { externalTimeoutMs: 20 } }).lookupVehicle(PLATE, 'corr-1'));
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.getResponse()).toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
    expect(String(logError.mock.calls[0][0])).toContain('"code":"TIMEOUT"');
  });
});

describe('AutoValuationService.autoValuateVehicle', () => {
  it('suggests the median of the adjusted comparables', async () => {
    const res = await build({ sources: [siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
    expect(res.status).toBe('OK');
    expect(res.assetType).toBe('VEHICLE');
    expect(res.valuedAt).toBe(NOW.toISOString());
    const { owner: _owner, ...summary } = VEHICLE;
    expect(res.vehicle).toEqual(summary);
    expect(res.request).toEqual({ plateNo: PLATE, mileageKm: 100_000 });
    expect(res.estimate).toEqual({
      marketValue: 25_000_000,
      lowValue: 25_000_000,
      highValue: 26_000_000,
      meanValue: 25_320_000,
      sampleSize: 5,
      confidence: 'MEDIUM',
      currency: 'MNT',
      method: 'MARKET_COMPARABLES_V1',
    });
    expect(res.warnings).toEqual([]);
  });

  it('validates against the AutoValuationResponse schema', async () => {
    const full = await build({ sources: [siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
    const empty = await build({ sources: [listingSource('SITE_A', [])] }).autoValuateVehicle({ ...REQ, mileageKm: undefined }, 'corr-1');
    expect(AutoValuationResponse.parse(full)).toEqual(full);
    expect(AutoValuationResponse.parse(empty)).toEqual(empty);
  });

  it('reports the registry and every listing source', async () => {
    const res = await build({ sources: [siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
    const fetchedAt = NOW.toISOString();
    expect(res.sources).toEqual([
      { id: 'ATUT', kind: 'GOVERNMENT_REGISTRY', status: 'OK', count: 1, errorCode: null, fetchedAt },
      { id: 'SITE_A', kind: 'CLASSIFIED_ADS', status: 'OK', count: 4, errorCode: null, fetchedAt },
      { id: 'SITE_B', kind: 'CLASSIFIED_ADS', status: 'OK', count: 2, errorCode: null, fetchedAt },
    ]);
  });

  it('lists comparables source by source in the order returned, without cross-site de-duplication', async () => {
    const sources = [listingSource('SITE_A', [ad('x1'), ad('x2')]), listingSource('SITE_B', [ad('x1'), ad('y1')])];
    const res = await build({ sources }).autoValuateVehicle(REQ, 'corr-1');
    expect(res.comparables.map((c) => `${c.source}:${c.externalId}`)).toEqual(['SITE_A:x1', 'SITE_A:x2', 'SITE_B:x1', 'SITE_B:y1']);
  });

  it('maps every listing field and the pricing outcome onto its comparable', async () => {
    const res = await build({ sources: [siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
    const [a1, , , a4, , b2] = res.comparables;
    expect(a1).toEqual({
      source: 'SITE_A',
      externalId: 'a1',
      url: 'https://example.invalid/a1',
      title: 'Toyota Prius a1',
      year: 2012,
      mileageKm: 100_000,
      listedPrice: 24_000_000,
      currency: 'MNT',
      postedAt: daysAgo(1),
      priceMnt: 24_000_000,
      adjustedPriceMnt: 24_000_000,
      included: true,
      exclusionReason: null,
    });
    expect(a4).toMatchObject({ externalId: 'a4', adjustedPriceMnt: null, included: false, exclusionReason: 'MODEL_MISMATCH' });
    // One year newer than the subject: 5% cheaper after adjustment.
    expect(b2.adjustedPriceMnt).toBeCloseTo(26_600_000, 0);
    expect(b2.included).toBe(true);
  });

  it('adjusts for the mileage difference and converts USD with the configured rate', async () => {
    const sources = [
      listingSource('SITE_A', [
        ad('km', { year: 2013, mileageKm: 80_000, price: 30_000_000 }),
        ad('usd', { price: 7_000, currency: 'USD', mileageKm: null }),
      ]),
    ];
    const res = await build({ sources, settings: { usdMnt: 3600 } }).autoValuateVehicle(REQ, 'corr-1');
    // 1 - 0.05 (one year newer) - 0.02 (20,000 km less than the subject)
    expect(res.comparables[0].adjustedPriceMnt).toBeCloseTo(27_900_000, 0);
    expect(res.comparables[1]).toMatchObject({ priceMnt: 25_200_000, adjustedPriceMnt: 25_200_000 });
  });

  it('asks every source for the make, model and year range around the manufacture year', async () => {
    const [a, b] = [listingSource('SITE_A', []), listingSource('SITE_B', [])];
    await build({ sources: [a, b], settings: { yearTolerance: 2 } }).autoValuateVehicle(REQ, 'corr-7');
    for (const source of [a, b]) {
      expect(source.search).toHaveBeenCalledOnce();
      const [query, ctx] = source.search.mock.calls[0];
      expect(query).toEqual({ make: 'Toyota', model: 'Prius', yearFrom: 2010, yearTo: 2014 });
      expect(ctx).toMatchObject({ correlationId: 'corr-7', now: NOW });
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('looks the vehicle up by the plate of the request', async () => {
    const registry = registryReturning(VEHICLE);
    await build({ registry }).autoValuateVehicle(REQ, 'corr-1');
    expect(registry.lookup.mock.calls[0][0]).toBe(PLATE);
  });

  it('queries all sources in parallel', async () => {
    let releaseA!: () => void;
    const aWaitsForB = new Promise<void>((resolve) => (releaseA = resolve));
    const a = {
      id: 'SITE_A',
      search: vi.fn(async () => {
        await aWaitsForB;
        return [ad('a1')];
      }),
    };
    const b = {
      id: 'SITE_B',
      search: vi.fn(async () => {
        releaseA();
        return [ad('b1')];
      }),
    };
    const res = await build({ sources: [a, b] }).autoValuateVehicle(REQ, 'corr-1');
    // Run one after the other, A would never be released and would end in a TIMEOUT.
    expect(res.sources.map((s) => s.status)).toEqual(['OK', 'OK', 'OK']);
    expect(res.comparables.map((c) => c.externalId)).toEqual(['a1', 'b1']);
  });

  it('records every numeric setting as a parameter, including the timeout', async () => {
    const res = await build({ sources: [siteA()] }).autoValuateVehicle(REQ, 'corr-1');
    expect(res.parameters).toEqual(SETTINGS);
  });

  describe('when a listing source fails', () => {
    it('still values the vehicle from the other sources and flags SOURCE_UNAVAILABLE', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const sources = [
        listingSource('SITE_A', [ad('a1', { price: 24_000_000 }), ad('a2'), ad('a3', { price: 26_000_000 })]),
        failingSource('SITE_B', new IntegrationError('SITE_B', 'UNAVAILABLE', 'down')),
      ];
      const res = await build({ sources }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.status).toBe('OK');
      expect(res.estimate?.marketValue).toBe(25_000_000);
      expect(res.sources[2]).toEqual({
        id: 'SITE_B',
        kind: 'CLASSIFIED_ADS',
        status: 'ERROR',
        count: null,
        errorCode: 'UNAVAILABLE',
        fetchedAt: NOW.toISOString(),
      });
      expect(res.warnings).toContain('SOURCE_UNAVAILABLE');
      expect(warn).toHaveBeenCalledOnce();
    });

    it('reports a non-integration error as UNEXPECTED', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const sources = [failingSource('SITE_A', new TypeError('x is not iterable')), siteB()];
      const res = await build({ sources }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.sources[1]).toMatchObject({ id: 'SITE_A', status: 'ERROR', count: null, errorCode: 'UNEXPECTED' });
      expect(res.sources[2]).toMatchObject({ id: 'SITE_B', status: 'OK' });
    });

    it('gives up on a source that does not answer within the timeout and aborts its call', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const hanging = hangingSource('SITE_A');
      const res = await build({ sources: [hanging, siteB()], settings: { externalTimeoutMs: 20 } }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.sources[1]).toMatchObject({ id: 'SITE_A', status: 'ERROR', count: null, errorCode: 'TIMEOUT' });
      expect(res.sources[2]).toMatchObject({ id: 'SITE_B', status: 'OK', count: 2 });
      expect(hanging.search.mock.calls[0][1].signal.aborted).toBe(true);
      expect(res.comparables.map((c) => c.source)).toEqual(['SITE_B', 'SITE_B']);
      expect(res.warnings).toContain('SOURCE_UNAVAILABLE');
    });

    it('reports INSUFFICIENT_DATA when all sources fail', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const sources = [
        failingSource('SITE_A', new IntegrationError('SITE_A', 'BAD_RESPONSE', 'x')),
        failingSource('SITE_B', new Error('y')),
      ];
      const res = await build({ sources }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.status).toBe('INSUFFICIENT_DATA');
      expect(res.estimate).toBeNull();
      expect(res.comparables).toEqual([]);
      expect(res.sources.map((s) => s.status)).toEqual(['OK', 'ERROR', 'ERROR']);
      expect(res.warnings).toEqual(['SOURCE_UNAVAILABLE']);
      expect(() => AutoValuationResponse.parse(res)).not.toThrow();
    });
  });

  describe('when there is too little data', () => {
    it('reports INSUFFICIENT_DATA below minComparables but still lists the comparables', async () => {
      const res = await build({ sources: [listingSource('SITE_A', [ad('a1'), ad('a2')])] }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.status).toBe('INSUFFICIENT_DATA');
      expect(res.estimate).toBeNull();
      expect(res.comparables).toHaveLength(2);
      expect(res.comparables.every((c) => c.included)).toBe(true);
      expect(res.warnings).toEqual([]);
    });

    it('does not count excluded comparables towards minComparables', async () => {
      const sources = [listingSource('SITE_A', [ad('a1'), ad('a2'), ad('a3', { model: 'Prius Alpha' })])];
      expect((await build({ sources }).autoValuateVehicle(REQ, 'corr-1')).status).toBe('INSUFFICIENT_DATA');
    });

    it('reports INSUFFICIENT_DATA when the sources return nothing, or when none is configured', async () => {
      const none = await build({ sources: [listingSource('SITE_A', [])] }).autoValuateVehicle(REQ, 'corr-1');
      const unconfigured = await build({ sources: [] }).autoValuateVehicle(REQ, 'corr-1');
      expect(none.status).toBe('INSUFFICIENT_DATA');
      expect(unconfigured.status).toBe('INSUFFICIENT_DATA');
      expect(unconfigured.sources.map((s) => s.id)).toEqual(['ATUT']);
      expect(unconfigured.warnings).toEqual([]);
    });
  });

  describe('warnings', () => {
    it('flags MILEAGE_NOT_PROVIDED and skips the mileage adjustment', async () => {
      const listings = ['a1', 'a2', 'a3'].map((id) => ad(id, { mileageKm: 20_000 }));
      const sources = [listingSource('SITE_A', listings)];
      const res = await build({ sources }).autoValuateVehicle({ assetType: 'VEHICLE', plateNo: PLATE }, 'corr-1');
      expect(res.warnings).toContain('MILEAGE_NOT_PROVIDED');
      expect(res.comparables.map((c) => c.adjustedPriceMnt)).toEqual([25_000_000, 25_000_000, 25_000_000]);
    });

    it('treats a null mileage like a missing one and echoes it as null', async () => {
      const res = await build({ sources: [siteA()] }).autoValuateVehicle({ ...REQ, mileageKm: null }, 'corr-1');
      expect(res.warnings).toContain('MILEAGE_NOT_PROVIDED');
      expect(res.request.mileageKm).toBeNull();
    });

    it('flags LOW_CONFIDENCE for a thin sample, keeping status OK', async () => {
      const sources = [listingSource('SITE_A', [ad('a1'), ad('a2'), ad('a3')])];
      const res = await build({ sources }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.status).toBe('OK');
      expect(res.estimate?.confidence).toBe('LOW');
      expect(res.warnings).toEqual(['LOW_CONFIDENCE']);
    });

    it('lists the warnings in a stable order', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const sources = [listingSource('SITE_A', [ad('a1'), ad('a2'), ad('a3')]), failingSource('SITE_B', new Error('down'))];
      const res = await build({ sources }).autoValuateVehicle({ assetType: 'VEHICLE', plateNo: PLATE }, 'corr-1');
      expect(res.warnings).toEqual(['SOURCE_UNAVAILABLE', 'MILEAGE_NOT_PROVIDED', 'LOW_CONFIDENCE']);
    });
  });

  describe('when the registry cannot identify the vehicle', () => {
    it('throws NotFound VEHICLE_NOT_FOUND and does not query the ad sites', async () => {
      const source = siteA();
      const error = await rejection(build({ registry: registryReturning(null), sources: [source] }).autoValuateVehicle(REQ, 'corr-1'));
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toMatchObject({ code: 'VEHICLE_NOT_FOUND' });
      expect(source.search).not.toHaveBeenCalled();
    });

    it('throws BadGateway REGISTRY_UNAVAILABLE and does not query the ad sites', async () => {
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const source = siteA();
      const registry = { lookup: vi.fn(async () => Promise.reject(new IntegrationError('ATUT', 'NOT_IMPLEMENTED', 'stub'))) };
      const error = await rejection(build({ registry, sources: [source] }).autoValuateVehicle(REQ, 'corr-1'));
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(error.getResponse()).toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
      expect(source.search).not.toHaveBeenCalled();
    });
  });

  describe('settings and deadline', () => {
    it('fails loudly (RangeError, HTTP 500) when a setting is not a finite number, instead of valuing with a check switched off', async () => {
      const service = build({ sources: [siteA()], settings: { maxListingAgeDays: NaN } });
      await expect(service.autoValuateVehicle(REQ, 'corr-1')).rejects.toThrow(RangeError);
    });

    it('gives the ads sites only what is left of externalTimeoutMs after the registry answered', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const registry = {
        lookup: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return VEHICLE;
        }),
      };
      const started = performance.now();
      const res = await build({ registry, sources: [hangingSource('SITE_A')], settings: { externalTimeoutMs: 200 } }).autoValuateVehicle(REQ, 'corr-1');
      const elapsed = performance.now() - started;
      expect(res.sources[1]).toMatchObject({ id: 'SITE_A', status: 'ERROR', errorCode: 'TIMEOUT' });
      // Sequential budgets would take 120 + 200 ms; one shared budget stays near 200 ms.
      expect(elapsed).toBeLessThan(290);
    });
  });

  describe('owner data', () => {
    it('is returned by the lookup but never by the valuation result', async () => {
      const lookup = await build().lookupVehicle(PLATE, 'corr-1');
      expect(lookup.vehicle.owner).toEqual({ registerNo: OWNER_REGISTER, name: OWNER_NAME });
      const valuation = await build({ sources: [siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
      expect(JSON.stringify(valuation)).not.toContain(OWNER_NAME);
      expect(JSON.stringify(valuation)).not.toContain(OWNER_REGISTER);
    });
  });

  describe('adapter payload validation', () => {
    it.each([
      ['a vehicle without a make', { ...VEHICLE, make: undefined }],
      ['a vehicle without an owner', { ...VEHICLE, owner: undefined }],
      ['a string model year', { ...VEHICLE, manufactureYear: '2012' }],
      ['a non-object', 'Toyota Prius'],
    ])('answers 502 REGISTRY_UNAVAILABLE for %s', async (_label, payload) => {
      const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const registry = { lookup: vi.fn(async () => payload as unknown as VehicleInfo) };
      const error = await rejection(build({ registry }).autoValuateVehicle(REQ, 'corr-1'));
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(error.getResponse()).toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
      expect(String(logError.mock.calls[0][0])).toContain('"code":"BAD_RESPONSE"');
    });

    it.each([
      ['a payload that is not an array', { listings: [] }],
      ['null', null],
      ['a listing without a make', [ad('a1'), { ...ad('a2'), make: undefined }]],
      ['a listing priced as a string', [{ ...ad('a1'), price: '25000000' }]],
      ['a listing with an unknown currency', [{ ...ad('a1'), currency: 'EUR' }]],
      ['a listing without a year', [{ ...ad('a1'), year: undefined }]],
      ['a listing with a negative mileage', [{ ...ad('a1'), mileageKm: -5 }]],
      ['a listing priced at Infinity', [{ ...ad('a1'), price: Infinity }]],
      ['a listing whose url is not http(s)', [{ ...ad('a1'), url: 'javascript:alert(1)' }]],
      ['a listing with a 10,000 character title', [{ ...ad('a1'), title: 'x'.repeat(10_000) }]],
      ['more listings than the per-source limit', Array.from({ length: 1001 }, (_, i) => ad(`n${i}`))],
    ])('reports a source returning %s as BAD_RESPONSE and still values from the others', async (_label, payload) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const bad = { id: 'SITE_BAD', search: vi.fn(async () => payload as unknown as VehicleListing[]) };
      const res = await build({ sources: [bad, siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.sources[1]).toEqual({
        id: 'SITE_BAD',
        kind: 'CLASSIFIED_ADS',
        status: 'ERROR',
        count: null,
        errorCode: 'BAD_RESPONSE',
        fetchedAt: NOW.toISOString(),
      });
      expect(res.status).toBe('OK');
      expect(res.warnings).toContain('SOURCE_UNAVAILABLE');
      expect(res.comparables.every((c) => c.source !== 'SITE_BAD')).toBe(true);
    });

    it('logs which fields broke the contract (path and code), never their values', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const bad = { id: 'SITE_BAD', search: vi.fn(async () => [{ ...ad('a1'), make: 12345, price: 'SECRET-PRICE' }] as unknown as VehicleListing[]) };
      await build({ sources: [bad] }).autoValuateVehicle(REQ, 'corr-7');
      const events = warn.mock.calls.map((args) => JSON.parse(String(args[0])));
      expect(events[0]).toEqual({
        event: 'adapter_contract_violation',
        source: 'SITE_BAD',
        issues: ['0.make:invalid_type', '0.price:invalid_type'],
        correlationId: 'corr-7',
      });
      expect(JSON.stringify(events)).not.toContain('SECRET-PRICE');
    });

    it('caps the logged issues at five', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const broken = Array.from({ length: 20 }, (_, i) => ({ ...ad(`n${i}`), make: i }));
      const bad = { id: 'SITE_BAD', search: vi.fn(async () => broken as unknown as VehicleListing[]) };
      await build({ sources: [bad] }).autoValuateVehicle(REQ, 'corr-8');
      expect(JSON.parse(String(warn.mock.calls[0][0])).issues).toHaveLength(5);
    });

    it('excludes a placeholder price such as 1 ("negotiable") as INVALID_PRICE instead of averaging it in', async () => {
      const sources = [listingSource('SITE_A', [ad('neg', { price: 1 }), ad('a1'), ad('a2'), ad('a3')])];
      const res = await build({ sources }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.comparables[0]).toMatchObject({ externalId: 'neg', priceMnt: 1, included: false, exclusionReason: 'INVALID_PRICE' });
      expect(res.estimate?.marketValue).toBe(25_000_000);
    });

    it('passes a listing priced at zero on to the calculation, which excludes it as INVALID_PRICE', async () => {
      const res = await build({ sources: [listingSource('SITE_A', [ad('free', { price: 0 }), ad('a1'), ad('a2'), ad('a3')])] }).autoValuateVehicle(REQ, 'corr-1');
      expect(res.sources[1]).toMatchObject({ status: 'OK', count: 4 });
      expect(res.comparables[0]).toMatchObject({ externalId: 'free', included: false, exclusionReason: 'INVALID_PRICE' });
    });
  });

  describe('logging', () => {
    const LEVELS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;
    const spyOnLogger = () => LEVELS.map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    const logged = (spies: ReturnType<typeof spyOnLogger>): string =>
      spies.flatMap((spy) => spy.mock.calls).map((args) => JSON.stringify(args)).join('\n');

    it('logs source id, error code and correlation id of a failed ad site, and no personal data', async () => {
      const spies = spyOnLogger();
      // Adapter messages are free text and may carry the plate or the owner: they must not be logged.
      const leaky = new IntegrationError('SITE_A', 'BAD_RESPONSE', `bad page for ${PLATE} owned by ${OWNER_NAME} ${OWNER_REGISTER}`);
      await build({ sources: [failingSource('SITE_A', leaky), siteB()] }).autoValuateVehicle(REQ, 'corr-42');
      const output = logged(spies);
      expect(output).toContain('SITE_A');
      expect(output).toContain('BAD_RESPONSE');
      expect(output).toContain('corr-42');
      for (const secret of [PLATE, OWNER_NAME, OWNER_REGISTER]) expect(output).not.toContain(secret);
    });

    it('logs source id and error code of a registry failure, and no personal data', async () => {
      const spies = spyOnLogger();
      const leaky = new IntegrationError('ATUT', 'UNAVAILABLE', `lookup of ${PLATE} failed, owner ${OWNER_NAME} ${OWNER_REGISTER}`);
      const registry = { lookup: vi.fn(async () => Promise.reject(leaky)) };
      await rejection(build({ registry }).autoValuateVehicle(REQ, 'corr-43'));
      const output = logged(spies);
      expect(output).toContain('ATUT');
      expect(output).toContain('UNAVAILABLE');
      expect(output).toContain('corr-43');
      for (const secret of [PLATE, OWNER_NAME, OWNER_REGISTER]) expect(output).not.toContain(secret);
    });

    it('writes one JSON object per event', async () => {
      const [, , warn] = spyOnLogger();
      await build({ sources: [failingSource('SITE_A', new IntegrationError('SITE_A', 'TIMEOUT', 'x'))] }).autoValuateVehicle(REQ, 'corr-9');
      expect(warn.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({ event: 'listing_source_failed', source: 'SITE_A', code: 'TIMEOUT', correlationId: 'corr-9' });
    });

    it('logs nothing on a successful valuation', async () => {
      const spies = spyOnLogger();
      await build({ sources: [siteA(), siteB()] }).autoValuateVehicle(REQ, 'corr-1');
      await build({ sources: [siteA()] }).lookupVehicle(PLATE, 'corr-1');
      expect(logged(spies)).toBe('');
    });
  });
});
