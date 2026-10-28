import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AutoValuationResponse, VehicleLookupResponse } from '@los/contracts';
import { AppModule } from '../../app.module';
import { CLOCK } from '../../common/clock';
import type { IntegrationContext } from '../../integrations/integration.types';
import { VEHICLE_REGISTRY } from '../../integrations/vehicle-registry/vehicle-registry.port';
import { ValuationModule } from './valuation.module';
import { VALUATION_SETTINGS } from './valuation-settings.port';
import { DemoValuationSettings } from './demo-valuation-settings';

const NOW = new Date('2026-10-28T09:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function createApp(mode: 'mock' | 'real'): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ INTEGRATION_MODE: mode })] }),
      ValuationModule,
    ],
  })
    .overrideProvider(CLOCK)
    .useValue({ now: () => NOW })
    .compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useLogger(false);
  await app.init();
  return app;
}

const post = (app: INestApplication, path: 'auto' | 'vehicle-lookup', body?: unknown, correlationId?: string) => {
  const req = request(app.getHttpServer()).post(`/api/valuate/${path}`);
  return (correlationId ? req.set('x-correlation-id', correlationId) : req).send(body);
};

// ConfigService reads process.env before the `load` factories, so a real INTEGRATION_MODE must not leak into these tests.
let savedMode: string | undefined;
beforeAll(() => {
  savedMode = process.env.INTEGRATION_MODE;
  delete process.env.INTEGRATION_MODE;
});
afterAll(() => {
  if (savedMode === undefined) delete process.env.INTEGRATION_MODE;
  else process.env.INTEGRATION_MODE = savedMode;
});

describe('valuation endpoints with mock integrations', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp('mock');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/valuate/auto', () => {
    it('suggests a market value for УЕН5246 (Toyota Prius 2012)', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: 90_000 });
      expect(res.status).toBe(200);
      const body = AutoValuationResponse.parse(res.body);
      expect(body.status).toBe('OK');
      expect(body.valuedAt).toBe(NOW.toISOString());
      expect(body.vehicle).toMatchObject({ plateNo: 'УЕН5246', make: 'Toyota', model: 'Prius', manufactureYear: 2012 });
      expect(body.request).toEqual({ plateNo: 'УЕН5246', mileageKm: 90_000 });
      expect(body.vehicle).not.toHaveProperty('owner'); // personal data stays out of the storable result
      expect(JSON.stringify(res.body)).not.toMatch(/Эрдэнэ|УЕ00000001/);
      const estimate = body.estimate!;
      expect(estimate.marketValue).toBeGreaterThan(24_000_000);
      expect(estimate.marketValue).toBeLessThan(27_000_000);
      expect(estimate.lowValue).toBeLessThanOrEqual(estimate.marketValue);
      expect(estimate.highValue).toBeGreaterThanOrEqual(estimate.marketValue);
      expect(estimate).toMatchObject({ currency: 'MNT', method: 'MARKET_COMPARABLES_V1' });
      expect(estimate.sampleSize).toBeGreaterThanOrEqual(estimate.confidence === 'LOW' ? 3 : 5);
      expect(body.warnings).toEqual([]);
      expect(body.parameters).toMatchObject({ usdMnt: 3500, minComparables: 3, externalTimeoutMs: 15_000 });
    });

    it('reports every source and explains each excluded comparable', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: 90_000 });
      const body = AutoValuationResponse.parse(res.body);
      expect(body.sources.map((s) => [s.id, s.kind, s.status])).toEqual([
        ['ATUT', 'GOVERNMENT_REGISTRY', 'OK'],
        ['MOCK_UNEGUI', 'CLASSIFIED_ADS', 'OK'],
        ['MOCK_ADS_B', 'CLASSIFIED_ADS', 'OK'],
      ]);
      const reasons = new Set(body.comparables.filter((c) => !c.included).map((c) => c.exclusionReason));
      expect(reasons).toEqual(new Set(['OUTLIER', 'STALE_LISTING', 'MODEL_MISMATCH']));
      expect(body.comparables.some((c) => c.currency === 'USD' && c.included)).toBe(true);
      expect(body.estimate!.sampleSize).toBe(body.comparables.filter((c) => c.included).length);
    });

    it.each(['уен 5246', ' уен-5246 ', '5246УЕН'])('normalises the plate typed as %j', async (typed) => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: typed, mileageKm: 90_000 });
      expect(res.status).toBe(200);
      expect(res.body.vehicle.make).toBe('Toyota');
      expect(res.body.status).toBe('OK');
    });

    it('accepts a null mileage like a missing one', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: null });
      expect(res.status).toBe(200);
      expect(res.body.request.mileageKm).toBeNull();
      expect(res.body.warnings).toContain('MILEAGE_NOT_PROVIDED');
    });

    it('flags a missing mileage but still values the vehicle', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OK');
      expect(res.body.warnings).toContain('MILEAGE_NOT_PROVIDED');
    });

    it('returns 404 VEHICLE_NOT_FOUND for an unregistered plate', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: '9999ХХХ' });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'VEHICLE_NOT_FOUND', message: expect.any(String) });
    });

    it.each([
      ['Latin letters', { assetType: 'VEHICLE', plateNo: 'UEN5246' }, 'plateNo'],
      ['too few digits', { assetType: 'VEHICLE', plateNo: 'УЕН524' }, 'plateNo'],
      ['too many letters', { assetType: 'VEHICLE', plateNo: 'УЕНА5246' }, 'plateNo'],
      ['an empty plate', { assetType: 'VEHICLE', plateNo: '' }, 'plateNo'],
      ['a missing plate', { assetType: 'VEHICLE' }, 'plateNo'],
      ['a missing assetType', { plateNo: 'УЕН5246' }, 'assetType'],
      ['an unsupported assetType', { assetType: 'APARTMENT', plateNo: 'УЕН5246' }, 'assetType'],
      ['a zero mileage', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: 0 }, 'mileageKm'],
      ['a negative mileage', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: -1 }, 'mileageKm'],
      ['a fractional mileage', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: 10.5 }, 'mileageKm'],
    ])('returns 400 VALIDATION_ERROR for %s', async (_label, payload, field) => {
      const res = await post(app, 'auto', payload);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.issues).toEqual(expect.arrayContaining([{ path: field, message: expect.any(String) }]));
    });

    it('returns 400 VALIDATION_ERROR for an empty body', async () => {
      const res = await post(app, 'auto');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('does not echo the rejected plate back in the validation issues', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'UEN5246' });
      expect(JSON.stringify(res.body)).not.toContain('UEN5246');
    });

    it('returns 200 INSUFFICIENT_DATA when the ad sites hold too few comparables (7001УБЭ)', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: '7001УБЭ', mileageKm: 40_000 });
      expect(res.status).toBe(200);
      const body = AutoValuationResponse.parse(res.body);
      expect(body.status).toBe('INSUFFICIENT_DATA');
      expect(body.estimate).toBeNull();
      expect(body.comparables).toHaveLength(2);
      expect(body.vehicle.make).toBe('Lexus');
    });

    it('returns 200 INSUFFICIENT_DATA when the ad sites hold no comparable at all (3030БАА)', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: '3030БАА' });
      expect(res.status).toBe(200);
      const body = AutoValuationResponse.parse(res.body);
      expect(body.status).toBe('INSUFFICIENT_DATA');
      expect(body.estimate).toBeNull();
      expect(body.comparables).toEqual([]);
    });
  });

  describe('POST /api/valuate/vehicle-lookup', () => {
    it('returns the registry record including the owner', async () => {
      const res = await post(app, 'vehicle-lookup', { plateNo: 'уен 5246' });
      expect(res.status).toBe(200);
      const body = VehicleLookupResponse.parse(res.body);
      expect(body.fetchedAt).toBe(NOW.toISOString());
      expect(body.vehicle).toMatchObject({ plateNo: 'УЕН5246', make: 'Toyota', model: 'Prius', manufactureYear: 2012 });
      expect(body.vehicle.owner).toEqual({ registerNo: expect.any(String), name: expect.any(String) });
    });

    it('returns 404 VEHICLE_NOT_FOUND for an unregistered plate', async () => {
      const res = await post(app, 'vehicle-lookup', { plateNo: '9999ХХХ' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('VEHICLE_NOT_FOUND');
    });

    it('returns 400 VALIDATION_ERROR for a Latin plate', async () => {
      const res = await post(app, 'vehicle-lookup', { plateNo: 'UEN5246' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('correlation id', () => {
    it('echoes the X-Correlation-Id of the request', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246' }, 'corr-abc.123');
      expect(res.headers['x-correlation-id']).toBe('corr-abc.123');
    });

    it('generates one when the request has none', async () => {
      const lookup = await post(app, 'vehicle-lookup', { plateNo: 'УЕН5246' });
      const auto = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246' });
      expect(lookup.headers['x-correlation-id']).toMatch(UUID);
      expect(auto.headers['x-correlation-id']).toMatch(UUID);
      expect(auto.headers['x-correlation-id']).not.toBe(lookup.headers['x-correlation-id']);
    });

    it('replaces a value that is not a plain id', async () => {
      const res = await post(app, 'vehicle-lookup', { plateNo: 'УЕН5246' }, 'not a plain id <script>');
      expect(res.headers['x-correlation-id']).toMatch(UUID);
    });

    it('is also set on validation errors, which are raised before the handler runs', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'UEN5246' }, 'corr-400');
      expect(res.status).toBe(400);
      expect(res.headers['x-correlation-id']).toBe('corr-400');
    });

    it('is also set on error responses raised by the service', async () => {
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: '9999ХХХ' }, 'corr-404');
      expect(res.status).toBe(404);
      expect(res.headers['x-correlation-id']).toBe('corr-404');
    });
  });
});

describe('valuation endpoints with INTEGRATION_MODE=real (adapters are stubs)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp('real');
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['auto', 'vehicle-lookup'] as const)('POST /api/valuate/%s returns 502 REGISTRY_UNAVAILABLE', async (path) => {
    const res = await post(app, path, { assetType: 'VEHICLE', plateNo: 'УЕН5246' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'REGISTRY_UNAVAILABLE', message: expect.stringContaining('Try again') });
    expect(JSON.stringify(res.body)).not.toContain('УЕН5246');
  });

  it('still validates the request before calling any integration', async () => {
    const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'UEN5246' });
    expect(res.status).toBe(400);
  });
});

describe('wiring', () => {
  it('hands the registry the normalised plate and the request correlation id', async () => {
    const lookup = vi.fn(async (_plateNo: string, _ctx: IntegrationContext) => null);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ INTEGRATION_MODE: 'mock' })] }), ValuationModule],
    })
      .overrideProvider(VEHICLE_REGISTRY)
      .useValue({ lookup })
      .compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.init();
    try {
      await post(app, 'auto', { assetType: 'VEHICLE', plateNo: ' уен-5246 ' }, 'corr-wire-1');
      expect(lookup).toHaveBeenCalledOnce();
      expect(lookup.mock.calls[0][0]).toBe('УЕН5246');
      expect(lookup.mock.calls[0][1]).toMatchObject({ correlationId: 'corr-wire-1' });
    } finally {
      await app.close();
    }
  });

  it('applies externalTimeoutMs from the settings to the registry call', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ INTEGRATION_MODE: 'mock' })] }), ValuationModule],
    })
      .overrideProvider(VEHICLE_REGISTRY)
      .useValue({ lookup: () => new Promise(() => undefined) })
      .overrideProvider(VALUATION_SETTINGS)
      .useValue({ vehiclePricing: async () => ({ ...(await new DemoValuationSettings().vehiclePricing()), externalTimeoutMs: 25 }) })
      .compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.init();
    try {
      const res = await post(app, 'vehicle-lookup', { plateNo: 'УЕН5246' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('REGISTRY_UNAVAILABLE');
    } finally {
      await app.close();
    }
  });

  it('boots the real AppModule: health and a valuation work through the global prefix', async () => {
    const saved = process.env.INTEGRATION_MODE;
    process.env.INTEGRATION_MODE = 'mock';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useLogger(false);
    await app.init();
    try {
      const health = await request(app.getHttpServer()).get('/api/health');
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ service: 'valuation', ok: true });
      const res = await post(app, 'auto', { assetType: 'VEHICLE', plateNo: 'УЕН5246', mileageKm: 90_000 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OK');
    } finally {
      await app.close();
      if (saved === undefined) delete process.env.INTEGRATION_MODE;
      else process.env.INTEGRATION_MODE = saved;
    }
  });
});
