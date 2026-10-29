import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollateralValuationRecord, DomainEvent, SaveCollateralValuationResponse, SuggestValuationResponse, ValuationHistoryResponse } from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import { HAS_DB, ORG, as, asNobody, createApp } from '../../../test/app';

// FR-14.1–14.3, FR-14.6 over HTTP and a real database: AppModule + supertest, deterministic mock integrations, fixed clock (2026-10-29 11:00 Ulaanbaatar).
// The DEMO prices come from prisma/seed.ts (global-setup seeds a fresh schema), so every number below is DEMO arithmetic, not market data.

const M = 1_000_000;
const PREFIX = '/api/valuate/collateral';

const subject = (over: Record<string, unknown> = {}) => ({
  collateralId: randomUUID(),
  applicationId: randomUUID(),
  productId: null,
  productHaircutRate: null,
  externalValuationThreshold: null,
  validityDays: 90,
  ...over,
});
const vehicle = (plateNo: string, make: string, model: string, manufactureYear: number, mileageKm?: number) => ({
  assetType: 'VEHICLE',
  description: { plateNo, make, model, manufactureYear, ...(mileageKm === undefined ? {} : { mileageKm }) },
});
const apartment = (address: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  assetType: 'APARTMENT',
  description: { address: { province: 'Улаанбаатар', ...address }, propertyId: 'P-100', areaM2: 60, floor: 5, totalFloors: 12, buildYear: 2010, purpose: 'RESIDENTIAL', ...over },
});
const inventory = (stocktakeValue = 30 * M) => ({ assetType: 'INVENTORY', description: { name: 'Хүнсний бараа', stocktakeValue, stocktakeDate: '2026-10-01' } });

describe.skipIf(!HAS_DB)('collateral valuation endpoints (FR-14)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const logLines: string[] = [];
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: unknown, headers: Record<string, string> = as('officerA')) => http().post(`${PREFIX}${path}`).set(headers).send(body as object);
  const suggest = async (body: Record<string, unknown>, headers = as('officerA')) => {
    const res = await post('/suggest', subject(body), headers);
    expect(res.status).toBe(200);
    return SuggestValuationResponse.parse(res.body);
  };

  beforeAll(async () => {
    app = await createApp(undefined, (line) => logLines.push(line));
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('access', () => {
    const routes: [string, string, unknown][] = [
      ['post', `${PREFIX}/suggest`, subject(inventory())],
      ['post', PREFIX, subject({ ...inventory(), marketValue: 1000 })],
      ['post', `${PREFIX}/external`, subject({ ...inventory(), appraiser: 'A', valuedAt: '2026-10-01', marketValue: 1000, reportFileId: randomUUID() })],
      ['get', `${PREFIX}/${randomUUID()}/history`, undefined],
    ];

    it.each(routes)('%s %s needs an identity (401)', async (method, path, body) => {
      const req = method === 'post' ? http().post(path).send(body as object) : http().get(path);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it.each(routes)('%s %s needs application:read (403 for a role without it)', async (method, path, body) => {
      const req = method === 'post' ? http().post(path).set(asNobody()).send(body as object) : http().get(path).set(asNobody());
      const res = await req;
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it.each(['officerA', 'officerB', 'manager', 'approver', 'admin'] as const)('%s may call suggest (ADMIN has no application:write, origination forwards the caller as is)', async (user) => {
      expect((await post('/suggest', subject(inventory()), as(user))).status).toBe(200);
    });
  });

  describe('POST /valuate/collateral/suggest', () => {
    it('VEHICLE with ads in the market: VEHICLE_MARKET_COMPARABLES with a range and a confidence', async () => {
      const r = await suggest(vehicle('УЕН5246', 'Toyota', 'Prius', 2012, 90_000));
      const s = r.suggestion;
      expect(s).toMatchObject({ available: true, method: 'VEHICLE_MARKET_COMPARABLES', unavailableReason: null });
      expect(s.marketValue!).toBeGreaterThan(24 * M);
      expect(s.marketValue!).toBeLessThan(27 * M);
      expect(s.lowValue!).toBeLessThanOrEqual(s.marketValue!);
      expect(s.highValue!).toBeGreaterThanOrEqual(s.marketValue!);
      expect(s.confidence).not.toBeNull();
      expect(s.warnings).toContain('DEMO_PARAMETERS');
      expect(s.basis).toMatchObject({ estimateMethod: 'MARKET_COMPARABLES_V1', vehicleSource: 'REGISTRY', descriptionMatchesRegistry: true });
      expect(r.haircut).toEqual({ rate: 0.7, source: 'ORG_RULE' }); // seeded org-wide rule
      expect(r.manualValueRequired).toBe(false);
    });

    it('VEHICLE with too few ads (Lexus LX 570 2018): falls back to base price × depreciation = 375M × 0.76 = 285M', async () => {
      const r = await suggest(vehicle('7001УБЭ', 'Lexus', 'LX 570', 2018, 60_000));
      expect(r.suggestion).toMatchObject({ available: true, method: 'VEHICLE_BASE_PRICE', marketValue: 285 * M, confidence: null, lowValue: null, highValue: null });
      expect(r.suggestion.basis).toMatchObject({ fallbackReason: 'INSUFFICIENT_MARKET_DATA', basePrice: 375 * M, ageYears: 8, depreciationRate: 0.24, mileageDeductionRate: 0 });
    });

    it('VEHICLE: a high mileage lowers the base-price value (200,000 km on an 8-year-old car: −8%)', async () => {
      const r = await suggest(vehicle('7001УБЭ', 'Lexus', 'LX 570', 2018, 200_000));
      expect(r.suggestion.marketValue).toBe(262_200_000); // 285,000,000 × 0.92
    });

    it('VEHICLE without any ads (Daewoo Damas 2005): 10M × 0.5 (depreciation capped) = 5M, mileage not provided', async () => {
      const r = await suggest(vehicle('3030БАА', 'Daewoo', 'Damas', 2005));
      expect(r.suggestion).toMatchObject({ available: true, method: 'VEHICLE_BASE_PRICE', marketValue: 5 * M });
      expect(r.suggestion.warnings).toEqual(['MILEAGE_NOT_PROVIDED', 'DEMO_PARAMETERS']);
    });

    it('VEHICLE: Land Cruiser Prado 1234УБА is priced from the ads (about 87 M)', async () => {
      const r = await suggest(vehicle('1234УБА', 'Toyota', 'Land Cruiser Prado', 2015, 100_000));
      expect(r.suggestion.method).toBe('VEHICLE_MARKET_COMPARABLES');
      expect(r.suggestion.marketValue!).toBeGreaterThan(80 * M);
      expect(r.suggestion.marketValue!).toBeLessThan(95 * M);
    });

    it('VEHICLE: a plate that is not in the registry is unavailable VEHICLE_NOT_FOUND (200, not an error)', async () => {
      const r = await suggest(vehicle('9999УБА', 'Toyota', 'Prius', 2012, 90_000));
      expect(r.suggestion).toMatchObject({ available: false, method: null, marketValue: null, unavailableReason: 'VEHICLE_NOT_FOUND' });
    });

    it('VEHICLE: the response and the logs carry neither the plate nor the registry owner', async () => {
      logLines.length = 0;
      const res = await post('/suggest', subject(vehicle('УЕН5246', 'Toyota', 'Prius', 2012, 90_000)));
      expect(res.status).toBe(200);
      const logs = logLines.join('\n');
      for (const secret of ['УЕН5246', 'УЕ00000001', 'Бат-Эрдэнэ', 'MOCKVIN0000000001']) {
        expect(JSON.stringify(res.body)).not.toContain(secret);
        expect(logs).not.toContain(secret);
      }
    });

    it('APARTMENT: khoroo price × area × coefficients = 4.6M × 60 × 0.9 = 248,400,000', async () => {
      const r = await suggest(apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' }));
      expect(r.suggestion).toMatchObject({ available: true, method: 'REALTY_BASE_PRICE', marketValue: 248_400_000 });
      expect(r.suggestion.basis).toMatchObject({ keyMatch: 'KHOROO', unitPricePerM2: 4_600_000, buildingAgeCoefficient: 0.9, basePriceVersion: 1, basePriceValidFrom: '2026-01-01' });
      expect(r.haircut).toEqual({ rate: 0.8, source: 'ORG_RULE' });
    });

    it('APARTMENT: an unknown khoroo falls back to the district price (4.2M × 60 × 0.9)', async () => {
      const r = await suggest(apartment({ district: 'Баянзүрх', khoroo: '77-р хороо' }));
      expect(r.suggestion.marketValue).toBe(226_800_000);
      expect(r.suggestion.basis).toMatchObject({ keyMatch: 'DISTRICT' });
    });

    it('APARTMENT outside the price list is unavailable NO_BASE_PRICE', async () => {
      const r = await suggest(apartment({ district: 'Дархан', khoroo: '4-р баг' }));
      expect(r.suggestion).toMatchObject({ available: false, marketValue: null, unavailableReason: 'NO_BASE_PRICE' });
    });

    it('HOUSE: Налайх 100 m², built 2020: 1.3M × 100 = 130M; commercial purpose × 1.15', async () => {
      const house = (purpose: string) => ({ assetType: 'HOUSE', description: { address: { province: 'Улаанбаатар', district: 'Налайх' }, certificateNo: 'H-1', areaM2: 100, buildYear: 2020, purpose } });
      expect((await suggest(house('RESIDENTIAL'))).suggestion.marketValue).toBe(130 * M);
      expect((await suggest(house('COMMERCIAL'))).suggestion.marketValue).toBe(149.5 * M);
    });

    it('LAND: Хан-Уул 500 m² × 1.8M = 900M; agricultural land counts 30%', async () => {
      const land = (landUse: string) => ({ assetType: 'LAND', description: { address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, propertyId: 'L-1', areaM2: 500, landUse } });
      const r = await suggest(land('RESIDENTIAL'));
      expect(r.suggestion).toMatchObject({ method: 'LAND_BASE_PRICE', marketValue: 900 * M });
      expect(r.haircut).toEqual({ rate: 0.6, source: 'ORG_RULE' });
      expect((await suggest(land('AGRICULTURAL'))).suggestion.marketValue).toBe(270 * M);
    });

    it('LIVESTOCK: 40 adult horses × 1.8M = 72M; 100 young sheep × 140,000 = 14M', async () => {
      expect((await suggest({ assetType: 'LIVESTOCK', description: { livestockType: 'HORSE', ageGroup: 'ADULT', headCount: 40 } })).suggestion).toMatchObject({ method: 'LIVESTOCK_UNIT_PRICE', marketValue: 72 * M });
      expect((await suggest({ assetType: 'LIVESTOCK', description: { livestockType: 'SHEEP', ageGroup: 'YOUNG', headCount: 100 } })).suggestion.marketValue).toBe(14 * M);
    });

    it('INVENTORY, EQUIPMENT, OTHER: the officer enters the value (MANUAL_VALUE_ASSET); INVENTORY echoes the stocktake', async () => {
      const i = await suggest(inventory());
      expect(i.suggestion).toMatchObject({ available: false, unavailableReason: 'MANUAL_VALUE_ASSET', basis: { stocktakeValue: 30 * M, stocktakeDate: '2026-10-01' } });
      expect(i.manualValueRequired).toBe(true);
      expect(i.haircut).toEqual({ rate: 0.5, source: 'ORG_RULE' });
      expect((await suggest({ assetType: 'EQUIPMENT', description: { name: 'Экскаватор' } })).suggestion.unavailableReason).toBe('MANUAL_VALUE_ASSET');
      expect((await suggest({ assetType: 'OTHER', description: { name: 'Бусад' } })).suggestion.unavailableReason).toBe('MANUAL_VALUE_ASSET');
    });

    it('echoes the external-valuation threshold', async () => {
      expect((await suggest({ ...inventory(), externalValuationThreshold: 100 * M })).externalValuationThreshold).toBe(100 * M);
    });

    it('does not store anything', async () => {
      const body = subject(inventory());
      await post('/suggest', body);
      expect(await db.collateral.count({ where: { collateralId: body.collateralId } })).toBe(0);
    });

    describe('validation', () => {
      it('rejects a body that does not match the contract (400 VALIDATION_FAILED)', async () => {
        for (const bad of [{}, subject({ ...inventory(), validityDays: 0 }), subject({ ...inventory(), collateralId: 'nope' }), subject({ assetType: 'SPACESHIP', description: {} }), subject({ ...inventory(), productHaircutRate: 1.5 })]) {
          const res = await post('/suggest', bad);
          expect(res.status).toBe(400);
          expect(res.body.code).toBe('VALIDATION_FAILED');
        }
      });

      it('re-checks the description with the asset type\'s schema; the paths start with "description."', async () => {
        const res = await post('/suggest', subject({ assetType: 'APARTMENT', description: { address: { province: 'Улаанбаатар', district: 'Баянзүрх' }, areaM2: 60 } }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.details.map((d: { path: string }) => d.path)).toContain('description.propertyId');
      });
    });

    describe('INTEGRATION_MODE=real (the registry adapter is not implemented yet)', () => {
      it('the registry cannot answer: the vehicle is priced from the base price using the typed description (no 5xx)', async () => {
        const saved = process.env.INTEGRATION_MODE;
        process.env.INTEGRATION_MODE = 'real';
        let real: INestApplication;
        try {
          real = await createApp();
        } finally {
          if (saved === undefined) delete process.env.INTEGRATION_MODE;
          else process.env.INTEGRATION_MODE = saved;
        }
        try {
          const res = await request(real.getHttpServer()).post(`${PREFIX}/suggest`).set(as('officerA')).send(subject(vehicle('7001УБЭ', 'Lexus', 'LX 570', 2018, 60_000)));
          expect(res.status).toBe(200);
          expect(res.body.suggestion).toMatchObject({ available: true, method: 'VEHICLE_BASE_PRICE', marketValue: 285 * M });
          expect(res.body.suggestion.basis).toMatchObject({ fallbackReason: 'REGISTRY_UNAVAILABLE', vehicleSource: 'DESCRIPTION' });
          // a vehicle with no base price cannot be priced at all, and says why
          const none = await request(real.getHttpServer()).post(`${PREFIX}/suggest`).set(as('officerA')).send(subject(vehicle('1111УБА', 'Tesla', 'Model 3', 2021, 10_000)));
          expect(none.body.suggestion).toMatchObject({ available: false, unavailableReason: 'SOURCE_UNAVAILABLE' });
        } finally {
          await real.close();
        }
      });
    });

    describe('when the base prices are old', () => {
      it('adds BASE_PRICE_STALE (the DEMO prices are valid from 2026-01-01; a year later they are over the limit)', async () => {
        const late = await createApp(new Date('2027-03-01T03:00:00.000Z'));
        try {
          const res = await request(late.getHttpServer()).post(`${PREFIX}/suggest`).set(as('officerA')).send(subject(apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' })));
          expect(res.status).toBe(200);
          expect(res.body.suggestion.warnings).toEqual(['BASE_PRICE_STALE', 'DEMO_PARAMETERS']);
        } finally {
          await late.close();
        }
      });
    });
  });

  describe('POST /valuate/collateral (save)', () => {
    const outboxOf = async (collateralId: string) => (await db.outbox.findMany({ where: { type: 'ValuationCompleted', payload: { path: ['collateralId'], equals: collateralId } } })).map((o) => o.payload as Record<string, unknown>);
    const save = (body: Record<string, unknown>, headers = as('officerA')) => post('', subject(body), headers);

    it('docs/04 AC: 30,000,000 × 0.7 = 21,000,000 (product.haircut_json 0.7)', async () => {
      const res = await save({ ...inventory(), marketValue: 30 * M, productHaircutRate: 0.7 });
      expect(res.status).toBe(201);
      const body = SaveCollateralValuationResponse.parse(res.body);
      expect(body.valuation).toMatchObject({ marketValue: 30 * M, haircutRate: 0.7, haircutSource: 'PRODUCT_JSON', collateralValue: 21 * M, source: 'INTERNAL', method: 'INVENTORY_STOCKTAKE' });
    });

    it('docs/04 AC again with a VEHICLE: 30,000,000 (officer\'s figure) × 0.7 (seeded org rule) = 21,000,000', async () => {
      const res = await save({ ...vehicle('УЕН5246', 'Toyota', 'Prius', 2012, 90_000), marketValue: 30 * M, overrideReason: 'Зах зээлийн судалгаагаар' });
      expect(res.status).toBe(201);
      expect(res.body.valuation).toMatchObject({ marketValue: 30 * M, haircutRate: 0.7, haircutSource: 'ORG_RULE', collateralValue: 21 * M, method: 'MANUAL', overrideReason: 'Зах зээлийн судалгаагаар' });
      expect(res.body.valuation.suggestedValue).toBeGreaterThan(24 * M);
    });

    it('follows the system suggestion when no value is sent; valuedAt is now; validUntil = + validity days', async () => {
      const body = subject({ ...apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' }), validityDays: 30, externalValuationThreshold: 200 * M });
      const res = await post('', body);
      expect(res.status).toBe(201);
      expect(res.body.valuation).toMatchObject({
        collateralId: body.collateralId,
        marketValue: 248_400_000,
        suggestedValue: 248_400_000,
        method: 'REALTY_BASE_PRICE',
        haircutRate: 0.8,
        collateralValue: 198_720_000,
        overrideReason: null,
        valuedAt: '2026-10-29T03:00:00.000Z',
        validUntil: '2026-11-28T03:00:00.000Z',
        externalRequired: true, // 248.4M ≥ 200M
        createdBy: as('officerA')['x-user-id'],
      });
      expect(res.body.suggestion).toMatchObject({ available: true, marketValue: 248_400_000 });
      expect(CollateralValuationRecord.safeParse(res.body.valuation).success).toBe(true);
    });

    it('writes the projection, the valuation row and the ValuationCompleted outbox row together', async () => {
      const body = subject({ ...apartment({ district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Номин ТЦ-ийн ард, 12 тоот' }), productId: 'prod-77' });
      const res = await http().post(PREFIX).set(as('officerA')).set('x-correlation-id', 'corr-save-1').send(body);
      expect(res.status).toBe(201);

      const projection = await db.collateral.findUniqueOrThrow({ where: { orgId_collateralId: { orgId: ORG, collateralId: body.collateralId } } });
      expect(projection).toMatchObject({ applicationId: body.applicationId, productId: 'prod-77', assetType: 'APARTMENT', createdBy: as('officerA')['x-user-id'] });
      expect(projection.descriptionJson).toMatchObject({ propertyId: 'P-100', areaM2: 60 });
      expect(JSON.stringify(projection.descriptionJson)).not.toContain('Номин'); // street address is not kept

      const rows = await db.collateralValuation.findMany({ where: { collateralRefId: projection.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: res.body.valuation.id, orgId: ORG, source: 'INTERNAL', method: 'REALTY_BASE_PRICE', haircutSource: 'ORG_RULE', externalRequired: false, appraiser: null, reportFileId: null });
      expect(Number(rows[0].marketValue)).toBe(248_400_000);
      expect(Number(rows[0].collateralValue)).toBe(198_720_000);
      expect(Number(rows[0].haircutRate)).toBe(0.8);
      expect(Number(rows[0].suggestedValue)).toBe(248_400_000);
      expect(rows[0].methodJson).toMatchObject({ suggestion: { method: 'REALTY_BASE_PRICE', marketValue: 248_400_000 }, haircut: { rate: 0.8, source: 'ORG_RULE' } });

      const events = await outboxOf(body.collateralId);
      expect(events).toHaveLength(1);
      expect(DomainEvent.parse(events[0])).toMatchObject({
        type: 'ValuationCompleted',
        version: 1,
        orgId: ORG,
        correlationId: 'corr-save-1',
        actorId: as('officerA')['x-user-id'],
        collateralId: body.collateralId,
        applicationId: body.applicationId,
        valuationId: res.body.valuation.id,
        assetType: 'APARTMENT',
        source: 'INTERNAL',
        marketValue: 248_400_000,
        haircutRate: 0.8,
        collateralValue: 198_720_000,
        valuedAt: '2026-10-29T03:00:00.000Z',
        validUntil: '2027-01-27T03:00:00.000Z',
        externalRequired: false,
      });
      const published = await db.outbox.findFirstOrThrow({ where: { id: String(events[0].eventId) } });
      expect(published.publishedAt).toBeNull(); // the relay (off in tests) publishes it later
    });

    it('keeps the plate out of the stored method_json and the event (it is only in the projection)', async () => {
      const body = subject({ ...vehicle('УЕН5246', 'Toyota', 'Prius', 2012, 90_000) });
      const res = await post('', body);
      expect(res.status).toBe(201);
      const projection = await db.collateral.findUniqueOrThrow({ where: { orgId_collateralId: { orgId: ORG, collateralId: body.collateralId } } });
      const row = await db.collateralValuation.findFirstOrThrow({ where: { collateralRefId: projection.id } });
      expect(JSON.stringify(row.methodJson)).not.toMatch(/УЕН5246|owner/i);
      expect(JSON.stringify(await outboxOf(body.collateralId))).not.toContain('УЕН5246');
      expect(JSON.stringify(res.body)).not.toContain('УЕН5246');
    });

    describe('override reason matrix (FR-14.2)', () => {
      const aptBody = () => apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' }); // suggestion 248,400,000

      it('a value equal to the suggestion needs no reason', async () => {
        expect((await save({ ...aptBody(), marketValue: 248_400_000 })).status).toBe(201);
        expect((await save({ ...aptBody(), marketValue: 248_400_000.004 })).status).toBe(201); // equal after rounding to 2 decimals
      });

      it('a different value without a reason is 422 OVERRIDE_REASON_REQUIRED and nothing is stored', async () => {
        const body = subject({ ...aptBody(), marketValue: 250 * M });
        const res = await post('', body);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('OVERRIDE_REASON_REQUIRED');
        expect(await db.collateral.count({ where: { collateralId: body.collateralId } })).toBe(0);
        expect(await outboxOf(body.collateralId)).toEqual([]);
      });

      it('a different value with a reason is saved as MANUAL next to the suggestion', async () => {
        const res = await save({ ...aptBody(), marketValue: 250 * M, overrideReason: 'Засвар, нэмэлт тохижилт' });
        expect(res.status).toBe(201);
        expect(res.body.valuation).toMatchObject({ method: 'MANUAL', marketValue: 250 * M, suggestedValue: 248_400_000, overrideReason: 'Засвар, нэмэлт тохижилт' });
      });

      it('a reason that is too short is rejected by the contract (400)', async () => {
        expect((await save({ ...aptBody(), marketValue: 250 * M, overrideReason: 'ab' })).status).toBe(400);
      });

      it('no suggestion (NO_BASE_PRICE) and no value: 422 MARKET_VALUE_REQUIRED', async () => {
        const res = await save(apartment({ district: 'Дархан' }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('MARKET_VALUE_REQUIRED');
        expect(res.body.details).toEqual({ unavailableReason: 'NO_BASE_PRICE' });
      });

      it('no suggestion, a value but no reason: 422 OVERRIDE_REASON_REQUIRED; with a reason: saved as MANUAL', async () => {
        expect((await save({ ...apartment({ district: 'Дархан' }), marketValue: 90 * M })).body.code).toBe('OVERRIDE_REASON_REQUIRED');
        const ok = await save({ ...apartment({ district: 'Дархан' }), marketValue: 90 * M, overrideReason: 'Үнэлгээчний зөвлөгөө' });
        expect(ok.status).toBe(201);
        expect(ok.body.valuation).toMatchObject({ method: 'MANUAL', suggestedValue: null, haircutRate: 0.8 });
      });

      it('an unknown plate behaves the same way (VEHICLE_NOT_FOUND is a missing suggestion, not an error)', async () => {
        const noValue = await save(vehicle('9999УБА', 'Toyota', 'Prius', 2012, 90_000));
        expect(noValue.status).toBe(422);
        expect(noValue.body.details).toEqual({ unavailableReason: 'VEHICLE_NOT_FOUND' });
        expect((await save({ ...vehicle('9999УБА', 'Toyota', 'Prius', 2012, 90_000), marketValue: 25 * M, overrideReason: 'Гар аргаар' })).status).toBe(201);
      });

      it.each([
        ['INVENTORY', inventory(), 'INVENTORY_STOCKTAKE'],
        ['EQUIPMENT', { assetType: 'EQUIPMENT', description: { name: 'Экскаватор', serialNo: 'SN-1' } }, 'MANUAL'],
        ['OTHER', { assetType: 'OTHER', description: { name: 'Бусад' } }, 'MANUAL'],
      ])('%s: the officer\'s value is saved without a reason (method %s); without a value it is 422', async (_name, asset, method) => {
        const res = await save({ ...asset, marketValue: 12 * M });
        expect(res.status).toBe(201);
        expect(res.body.valuation).toMatchObject({ method, overrideReason: null, suggestedValue: null });
        expect((await save(asset)).body.code).toBe('MARKET_VALUE_REQUIRED');
      });
    });

    describe('external valuation threshold (FR-14.3)', () => {
      it.each([
        [100 * M, 100 * M, true],
        [100 * M - 1, 100 * M, false],
        [250 * M, null, false],
      ])('market value %s with threshold %s → externalRequired %s', async (value, threshold, expected) => {
        const res = await save({ ...inventory(), marketValue: value, externalValuationThreshold: threshold });
        expect(res.body.valuation.externalRequired).toBe(expected);
      });
    });

    describe('haircut priority through the stored rules', () => {
      it('uses product.haircut_json over the seeded org rule, and DEMO_DEFAULT is the last resort in an org without rules', async () => {
        const viaJson = await save({ ...inventory(), marketValue: 10 * M, productHaircutRate: 0.65 });
        expect(viaJson.body.valuation).toMatchObject({ haircutRate: 0.65, haircutSource: 'PRODUCT_JSON' });
        const emptyOrg = { ...as('officerA'), 'x-org-id': randomUUID() };
        const demo = await save({ ...inventory(), marketValue: 10 * M }, emptyOrg);
        expect(demo.body.valuation).toMatchObject({ haircutRate: 0.5, haircutSource: 'DEMO_DEFAULT', collateralValue: 5 * M });
      });
    });

    it('a second valuation of the same collateral adds a row and keeps one projection; history is newest first', async () => {
      const collateralId = randomUUID();
      const base = { collateralId, ...apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' }) };
      const first = await save({ ...base });
      const second = await save({ ...base, marketValue: 240 * M, overrideReason: 'Дахин үнэлгээ' });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await db.collateral.count({ where: { collateralId } })).toBe(1);

      const history = ValuationHistoryResponse.parse((await http().get(`${PREFIX}/${collateralId}/history`).set(as('officerA'))).body);
      expect(history.items.map((i) => i.id)).toEqual([second.body.valuation.id, first.body.valuation.id]);
      expect(history.items[0]).toMatchObject({ collateralId, marketValue: 240 * M, method: 'MANUAL' });
    });

    it('concurrent valuations of one collateral all succeed with a single projection row', async () => {
      const collateralId = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => save({ collateralId, ...inventory(), marketValue: 10 * M })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      expect(await db.collateral.count({ where: { collateralId } })).toBe(1);
      expect(await outboxOf(collateralId)).toHaveLength(6);
    });

    it('is atomic: when the outbox insert fails, neither the projection nor the valuation is kept', async () => {
      const body = subject({ ...inventory(), marketValue: 10 * M });
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION valuation.test_block_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox blocked by test'; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER test_block_outbox BEFORE INSERT ON valuation.outbox FOR EACH ROW EXECUTE FUNCTION valuation.test_block_outbox()');
      try {
        const res = await post('', body);
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('INTERNAL');
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_block_outbox ON valuation.outbox');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS valuation.test_block_outbox()');
      }
      expect(await db.collateral.count({ where: { collateralId: body.collateralId } })).toBe(0);
      expect(await db.collateralValuation.count({ where: { collateral: { collateralId: body.collateralId } } })).toBe(0);
      expect(await outboxOf(body.collateralId)).toEqual([]);
      expect((await post('', body)).status).toBe(201); // and the service works again
    });

    it('rejects an invalid body (400): no market value of 0, unknown asset type, bad uuid', async () => {
      for (const bad of [{ ...inventory(), marketValue: 0 }, { ...inventory(), marketValue: -5 }, { ...inventory(), marketValue: 2e12 }, { ...inventory(), applicationId: 'x' }]) {
        const res = await save(bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('POST /valuate/collateral/external (FR-14.3)', () => {
    const external = (body: Record<string, unknown>, headers = as('officerA')) =>
      post('/external', subject({ appraiser: 'Жишээ Үнэлгээ ХХК', valuedAt: '2026-10-27', marketValue: 260 * M, reportFileId: randomUUID(), ...apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' }), validityDays: 365, ...body }), headers);

    it('records the licensed appraisal: EXTERNAL_LICENSED, EXTERNAL_APPRAISAL, haircut applied, report file kept, suggestion for comparison', async () => {
      const reportFileId = randomUUID();
      const body = { collateralId: randomUUID(), reportFileId, licenseNo: 'LIC-001', note: 'Албан ёсны тайлан', externalValuationThreshold: 200 * M };
      const res = await external(body);
      expect(res.status).toBe(201);
      const parsed = SaveCollateralValuationResponse.parse(res.body);
      expect(parsed.valuation).toMatchObject({
        collateralId: body.collateralId,
        source: 'EXTERNAL_LICENSED',
        method: 'EXTERNAL_APPRAISAL',
        appraiser: 'Жишээ Үнэлгээ ХХК',
        licenseNo: 'LIC-001',
        marketValue: 260 * M,
        suggestedValue: 248_400_000,
        haircutRate: 0.8,
        haircutSource: 'ORG_RULE',
        collateralValue: 208 * M,
        overrideReason: null,
        reportFileId,
        externalRequired: true,
        valuedAt: '2026-10-26T16:00:00.000Z', // 27 Oct 00:00 in Ulaanbaatar
        validUntil: '2027-10-26T16:00:00.000Z', // + 365 days
      });
      expect(parsed.suggestion.marketValue).toBe(248_400_000);

      const row = await db.collateralValuation.findUniqueOrThrow({ where: { id: parsed.valuation.id } });
      expect(row.methodJson).toMatchObject({ note: 'Албан ёсны тайлан' });
      const events = await db.outbox.findMany({ where: { type: 'ValuationCompleted', payload: { path: ['collateralId'], equals: body.collateralId } } });
      expect(events).toHaveLength(1);
      expect(DomainEvent.parse(events[0].payload)).toMatchObject({ source: 'EXTERNAL_LICENSED', marketValue: 260 * M, collateralValue: 208 * M, externalRequired: true, valuationId: parsed.valuation.id, validUntil: '2027-10-26T16:00:00.000Z' });
    });

    it('does not ask for an override reason even when it differs from the suggestion', async () => {
      const res = await external({ marketValue: 999 * M });
      expect(res.status).toBe(201);
      expect(res.body.valuation.overrideReason).toBeNull();
    });

    it('an explicit validUntil is the last day of validity', async () => {
      const res = await external({ validUntil: '2027-03-01' });
      expect(res.body.valuation.validUntil).toBe('2027-03-01T15:59:59.999Z');
    });

    it('suggestedValue is empty when the system has no suggestion', async () => {
      const res = await external({ ...apartment({ district: 'Дархан' }) });
      expect(res.status).toBe(201);
      expect(res.body.valuation.suggestedValue).toBeNull();
      expect(res.body.suggestion).toMatchObject({ available: false, unavailableReason: 'NO_BASE_PRICE' });
    });

    it('a valuation dated today is fine, tomorrow is 422 VALUED_AT_IN_FUTURE', async () => {
      expect((await external({ valuedAt: '2026-10-29' })).status).toBe(201);
      const res = await external({ valuedAt: '2026-10-30' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALUED_AT_IN_FUTURE');
    });

    it('validUntil must be after valuedAt (422 VALID_UNTIL_INVALID)', async () => {
      for (const validUntil of ['2026-10-27', '2026-10-01']) {
        const res = await external({ valuedAt: '2026-10-27', validUntil });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALID_UNTIL_INVALID');
      }
    });

    it('dates that do not exist, a missing appraiser or report, and a bad file id are 400', async () => {
      const invalid: Record<string, unknown>[] = [{ valuedAt: '2026-02-30' }, { valuedAt: '29.10.2026' }, { validUntil: '2027-13-01' }, { appraiser: '' }, { reportFileId: 'not-a-uuid' }, { marketValue: 0 }];
      for (const bad of invalid) {
        const res = await external(bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const noReport = subject({ appraiser: 'A', valuedAt: '2026-10-27', marketValue: 1000, ...inventory() });
      expect((await post('/external', noReport)).status).toBe(400);
    });

    it('nothing is stored when the request is refused', async () => {
      const collateralId = randomUUID();
      await external({ collateralId, valuedAt: '2026-12-31' });
      expect(await db.collateral.count({ where: { collateralId } })).toBe(0);
    });

    it('external valuation of a vehicle shows the market suggestion next to the appraiser\'s figure', async () => {
      const res = await external({ ...vehicle('УЕН5246', 'Toyota', 'Prius', 2012, 90_000), marketValue: 27 * M });
      expect(res.status).toBe(201);
      expect(res.body.suggestion.method).toBe('VEHICLE_MARKET_COMPARABLES');
      expect(res.body.valuation.suggestedValue).toBe(res.body.suggestion.marketValue);
    });
  });

  describe('GET /valuate/collateral/:collateralId/history (FR-14.6)', () => {
    const history = (collateralId: string, headers = as('officerA')) => http().get(`${PREFIX}/${collateralId}/history`).set(headers);

    it('orders by valuation date, newest first: a back-dated external report sits below a newer internal valuation', async () => {
      const collateralId = randomUUID();
      const asset = { collateralId, ...apartment({ district: 'Баянзүрх', khoroo: '5-р хороо' }) };
      const internal1 = await post('', subject(asset));
      const ext = await post('/external', subject({ ...asset, appraiser: 'Үнэлгээчин', valuedAt: '2026-09-01', marketValue: 255 * M, reportFileId: randomUUID(), validityDays: 365 }));
      const internal2 = await post('', subject({ ...asset, marketValue: 240 * M, overrideReason: 'Дахин үнэлгээ' }));
      expect([internal1.status, ext.status, internal2.status]).toEqual([201, 201, 201]);

      const res = await history(collateralId);
      expect(res.status).toBe(200);
      const body = ValuationHistoryResponse.parse(res.body);
      expect(body.items.map((i) => i.id)).toEqual([internal2.body.valuation.id, internal1.body.valuation.id, ext.body.valuation.id]);
      expect(body.items.map((i) => i.source)).toEqual(['INTERNAL', 'INTERNAL', 'EXTERNAL_LICENSED']);
    });

    it('is scoped to the organisation: another org sees nothing of it', async () => {
      const collateralId = randomUUID();
      await post('', subject({ collateralId, ...inventory(), marketValue: 5 * M }));
      expect((await history(collateralId)).body.items).toHaveLength(1);
      const otherOrg = { ...as('officerA'), 'x-org-id': randomUUID() };
      expect((await history(collateralId, otherOrg)).body).toEqual({ items: [] });
    });

    it('a collateral without valuations has an empty history (200)', async () => {
      const res = await history(randomUUID());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });

    it('rejects an id that is not a uuid (400)', async () => {
      const res = await history('not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('every role that may read applications may read the history', async () => {
      for (const user of ['officerA', 'manager', 'approver', 'admin'] as const) expect((await history(randomUUID(), as(user))).status).toBe(200);
    });
  });
});
