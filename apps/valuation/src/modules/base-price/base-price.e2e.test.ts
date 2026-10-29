import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BasePriceView } from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import { DEMO_BASE_PRICES, seedValuation } from '../../../prisma/seed-data';
import { HAS_DB, as, asNobody, createApp } from '../../../test/app';

// FR-14.1, FR-14.5 — base-price list with versions over HTTP and a real database. Every test works in its own organisation
// (a random org id seeded with the DEMO prices), so nothing here touches the prices other test files rely on.

describe.skipIf(!HAS_DB)('base prices (FR-14.1, FR-14.5)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const ORG = randomUUID();
  const admin = () => as('admin', ORG);
  const officer = () => as('officerA', ORG);
  const http = () => request(app.getHttpServer());
  const list = (query = '', headers: Record<string, string> = officer()) => http().get(`/api/base-prices${query}`).set(headers);
  const create = (body: unknown, headers: Record<string, string> = admin()) => http().post('/api/base-prices').set(headers).send(body as object);
  const importAll = (items: unknown, headers: Record<string, string> = admin()) => http().post('/api/base-prices/import').set(headers).send({ items });
  const count = (where: Record<string, unknown> = {}) => db.basePrice.count({ where: { orgId: ORG, ...where } });
  // jsonb returns the properties in its own order, so keys are compared by content
  const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const priceOf = (res: request.Response, key: Record<string, unknown>) => (res.body as { key: Record<string, unknown>; unitPrice: number }[]).find((p) => sameKey(p.key, key))?.unitPrice;

  beforeAll(async () => {
    app = await createApp();
    db = app.get(PrismaService);
    await seedValuation(db, ORG);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('access', () => {
    it('reading needs application:read: 401 without identity, 403 without the permission, 200 for every staff role', async () => {
      expect((await http().get('/api/base-prices')).status).toBe(401);
      expect((await list('', asNobody(ORG))).status).toBe(403);
      for (const user of ['officerA', 'manager', 'approver', 'admin'] as const) expect((await list('', as(user, ORG))).status).toBe(200);
    });

    it('writing needs settings:manage: only ADMIN (403 for everybody else)', async () => {
      const item = { assetType: 'LIVESTOCK', key: { livestockType: 'HORSE', ageGroup: 'ADULT' }, unitPrice: 2_000_000, validFrom: '2026-10-01' };
      for (const user of ['officerA', 'manager', 'approver'] as const) {
        expect((await create(item, as(user, ORG))).status, user).toBe(403);
        expect((await importAll([item], as(user, ORG))).status, user).toBe(403);
      }
      expect((await create(item, asNobody(ORG))).status).toBe(403);
      expect((await create(item, { 'x-user-id': 'u' })).status).toBe(401);
    });
  });

  describe('GET /base-prices', () => {
    it('lists the effective price of every key, sorted; the DEMO seed has 65', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      const items = (res.body as unknown[]).map((i) => BasePriceView.parse(i));
      expect(items).toHaveLength(DEMO_BASE_PRICES.length);
      expect(items.every((i) => i.version === 1 && i.validFrom === '2026-01-01')).toBe(true);
      expect(items.map((i) => i.assetType)).toEqual([...items.map((i) => i.assetType)].sort());
    });

    it('filters by asset type', async () => {
      const apartments = BasePriceView.array().parse((await list('?assetType=APARTMENT')).body);
      expect(apartments).toHaveLength(12); // 9 districts + 3 khoroo prices
      expect(apartments.every((a) => a.assetType === 'APARTMENT')).toBe(true);
      expect(BasePriceView.array().parse((await list('?assetType=LIVESTOCK')).body)).toHaveLength(10);
    });

    it('rejects an unknown asset type or history flag (400)', async () => {
      expect((await list('?assetType=INVENTORY')).status).toBe(400);
      expect((await list('?history=maybe')).status).toBe(400);
    });

    it('is scoped to the organisation', async () => {
      expect((await list('', as('officerA', randomUUID()))).body).toEqual([]);
    });
  });

  describe('POST /base-prices: a change is a new version of the same key', () => {
    const khoroo = { assetType: 'APARTMENT', key: { district: 'Баянзүрх', khoroo: '5-р хороо' }, validFrom: '2026-10-01' };

    it('version = max + 1; the list shows the new price, the history keeps the old one', async () => {
      const res = await create({ ...khoroo, unitPrice: 4_800_000 });
      expect(res.status).toBe(201);
      expect(BasePriceView.parse(res.body)).toMatchObject({ assetType: 'APARTMENT', key: { district: 'Баянзүрх', khoroo: '5-р хороо' }, unitPrice: 4_800_000, validFrom: '2026-10-01', version: 2, createdBy: as('admin')['x-user-id'] });

      const effective = (await list('?assetType=APARTMENT')).body as { key: Record<string, unknown>; unitPrice: number; version: number }[];
      expect(effective).toHaveLength(12);
      expect(effective.find((p) => p.key.khoroo === '5-р хороо' && p.key.district === 'Баянзүрх')).toMatchObject({ unitPrice: 4_800_000, version: 2 });

      const history = BasePriceView.array().parse((await list('?assetType=APARTMENT&history=true')).body);
      expect(history).toHaveLength(13);
      expect(history.filter((p) => p.key.khoroo === '5-р хороо' && p.key.district === 'Баянзүрх').map((p) => [p.version, p.unitPrice])).toEqual([[2, 4_800_000], [1, 4_600_000]]);
    });

    it('the suggestion uses the new price', async () => {
      const res = await http()
        .post('/api/valuate/collateral/suggest')
        .set(officer())
        .send({
          collateralId: randomUUID(), applicationId: randomUUID(), productId: null, productHaircutRate: null, externalValuationThreshold: null, validityDays: 90,
          assetType: 'APARTMENT',
          description: { address: { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо' }, propertyId: 'P-1', areaM2: 60, floor: 5, totalFloors: 12, buildYear: 2010, purpose: 'RESIDENTIAL' },
        });
      expect(res.body.suggestion.marketValue).toBe(259_200_000); // 4.8M × 60 × 0.9
      expect(res.body.suggestion.basis).toMatchObject({ basePriceVersion: 2, basePriceValidFrom: '2026-10-01' });
    });

    it('trims the key and ignores property order: it is the same key, so the version goes up', async () => {
      const before = await count({ assetType: 'VEHICLE' });
      const res = await create({ assetType: 'VEHICLE', key: { year: 2012, model: '  Prius ', make: ' Toyota' }, unitPrice: 45_000_000, validFrom: '2026-10-02' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ key: { make: 'Toyota', model: 'Prius', year: 2012 }, version: 2 });
      expect(await count({ assetType: 'VEHICLE' })).toBe(before + 1);
    });

    it('collapses inner blanks and drops the registry\'s "дүүрэг" suffix of a district', async () => {
      const res = await create({ assetType: 'HOUSE', key: { district: '  Налайх   дүүрэг ' }, unitPrice: 1_350_000, validFrom: '2026-10-03' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ key: { district: 'Налайх' }, version: 2 });
      const lands = await create({ assetType: 'LAND', key: { district: 'Баянзүрх', khoroo: '  5-р   хороо' }, unitPrice: 1_500_000, validFrom: '2026-10-03' });
      expect(lands.body).toMatchObject({ key: { district: 'Баянзүрх', khoroo: '5-р хороо' }, version: 1 }); // a new key (the seed has only the district)
    });

    it('a brand new key starts at version 1', async () => {
      const res = await create({ assetType: 'VEHICLE', key: { make: 'Honda', model: 'Fit', year: 2014 }, unitPrice: 19_000_000, validFrom: '2026-10-01' });
      expect(res.body.version).toBe(1);
    });

    it('a price valid from a future date is not effective yet but is in the history', async () => {
      const key = { livestockType: 'CAMEL', ageGroup: 'ADULT' };
      const res = await create({ assetType: 'LIVESTOCK', key, unitPrice: 4_000_000, validFrom: '2026-12-01' }); // today is 2026-10-29
      expect(res.body.version).toBe(2);
      expect(priceOf(await list('?assetType=LIVESTOCK'), key)).toBe(3_500_000);
      const history = (await list('?assetType=LIVESTOCK&history=true')).body as { key: Record<string, unknown>; version: number }[];
      expect(history.filter((p) => p.key.livestockType === 'CAMEL' && p.key.ageGroup === 'ADULT').map((p) => p.version)).toEqual([2, 1]);

      // the same price list a month later
      const later = await createApp(new Date('2026-12-01T03:00:00.000Z'));
      try {
        const effective = await request(later.getHttpServer()).get('/api/base-prices?assetType=LIVESTOCK').set(officer());
        expect(priceOf(effective, key)).toBe(4_000_000);
      } finally {
        await later.close();
      }
    });

    it('the effective version is the highest version that has started (a back-dated correction wins)', async () => {
      const key = { livestockType: 'GOAT', ageGroup: 'ADULT' };
      await create({ assetType: 'LIVESTOCK', key, unitPrice: 210_000, validFrom: '2026-09-01' });
      const fix = await create({ assetType: 'LIVESTOCK', key, unitPrice: 205_000, validFrom: '2026-06-01' });
      expect(fix.body.version).toBe(3);
      expect(priceOf(await list('?assetType=LIVESTOCK'), key)).toBe(205_000);
    });

    it('refuses a key that does not belong to the asset type (422)', async () => {
      for (const bad of [
        { assetType: 'VEHICLE', key: { district: 'Баянзүрх' } },
        { assetType: 'APARTMENT', key: { make: 'Toyota', model: 'Prius', year: 2012 } },
        { assetType: 'LIVESTOCK', key: { district: 'Баянзүрх' } },
        { assetType: 'LAND', key: { livestockType: 'HORSE', ageGroup: 'ADULT' } },
      ]) {
        const res = await create({ ...bad, unitPrice: 1_000_000, validFrom: '2026-10-01' });
        expect(res.status, JSON.stringify(bad)).toBe(422);
        expect(res.body.code).toBe('BASE_PRICE_KEY_MISMATCH');
      }
    });

    it('rejects invalid input (400): price, date format, a date that does not exist, asset type without prices', async () => {
      const ok = { assetType: 'LAND', key: { district: 'Баянгол' }, unitPrice: 2_000_000, validFrom: '2026-10-01' };
      for (const bad of [{ ...ok, unitPrice: 0 }, { ...ok, unitPrice: -1 }, { ...ok, unitPrice: 2e12 }, { ...ok, validFrom: '01.10.2026' }, { ...ok, validFrom: '2026-02-30' }, { ...ok, assetType: 'INVENTORY' }, { ...ok, key: {} }, {}]) {
        const res = await create(bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('parallel changes of one key get distinct consecutive versions', async () => {
      const key = { make: 'Mazda', model: 'Demio', year: 2013 };
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => create({ assetType: 'VEHICLE', key, unitPrice: 10_000_000 + i, validFrom: '2026-10-01' })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      expect(results.map((r) => r.body.version).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('POST /base-prices/import (all or nothing)', () => {
    const horse = (price: number, validFrom = '2026-10-10') => ({ assetType: 'LIVESTOCK', key: { livestockType: 'HORSE', ageGroup: 'YOUNG' }, unitPrice: price, validFrom });

    it('imports a batch: new keys start at 1, existing keys continue their version, the same key twice goes up in order', async () => {
      const before = await count();
      const res = await importAll([
        horse(950_000),
        horse(960_000, '2026-10-20'),
        { assetType: 'VEHICLE', key: { make: 'Kia', model: 'Rio', year: 2016 }, unitPrice: 17_000_000, validFrom: '2026-10-10' },
        { assetType: 'LAND', key: { district: 'Сонгинохайрхан' }, unitPrice: 850_000, validFrom: '2026-10-10' },
      ]);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ created: 4, byAssetType: { LIVESTOCK: 2, VEHICLE: 1, LAND: 1 } });
      expect(await count()).toBe(before + 4);
      const rows = await db.basePrice.findMany({ where: { orgId: ORG, assetType: 'LIVESTOCK', keyJson: { equals: { livestockType: 'HORSE', ageGroup: 'YOUNG' } } }, orderBy: { version: 'asc' } });
      expect(rows.map((r) => [r.version, Number(r.unitPrice)])).toEqual([[1, 900_000], [2, 950_000], [3, 960_000]]);
      expect(priceOf(await list('?assetType=LIVESTOCK'), { livestockType: 'HORSE', ageGroup: 'YOUNG' })).toBe(960_000);
      expect(rows.filter((r) => r.version > 1).every((r) => r.createdBy === as('admin')['x-user-id'])).toBe(true); // version 1 is the seed
    });

    it('canonicalises keys like POST does', async () => {
      const res = await importAll([{ assetType: 'APARTMENT', key: { district: ' Хан-Уул дүүрэг ', khoroo: ' 11-р хороо' }, unitPrice: 5_900_000, validFrom: '2026-10-11' }]);
      expect(res.status).toBe(201);
      const row = await db.basePrice.findFirstOrThrow({ where: { orgId: ORG, assetType: 'APARTMENT', keyJson: { equals: { district: 'Хан-Уул', khoroo: '11-р хороо' } } }, orderBy: { version: 'desc' } });
      expect(row.version).toBe(2);
    });

    it('one invalid item rejects the whole batch (422 with the item numbers) and nothing is written', async () => {
      const before = await count();
      const res = await importAll([
        horse(1),
        { assetType: 'VEHICLE', key: { district: 'Баянзүрх' }, unitPrice: 5_000_000, validFrom: '2026-10-10' }, // key of another asset type
        horse(2, '2026-10-12'),
        horse(3, '2026-10-11'),
        horse(3, '2026-10-11'), // the same key and date twice
      ]);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('BASE_PRICE_IMPORT_INVALID');
      expect(res.body.details.totalIssues).toBe(2);
      expect(res.body.details.issues.map((i: { index: number; code: string }) => [i.index, i.code])).toEqual([
        [1, 'BASE_PRICE_KEY_MISMATCH'],
        [4, 'BASE_PRICE_DUPLICATE'],
      ]);
      expect(await count()).toBe(before);
    });

    it('a calendar date that does not exist is rejected by the contract (400, path points at the item) and nothing is written', async () => {
      const before = await count();
      const res = await importAll([horse(1), horse(2, '2026-02-30')]);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.details)).toContain('validFrom');
      expect(await count()).toBe(before);
    });

    it('is atomic in the database too: a failure halfway rolls back the rows already inserted', async () => {
      const before = await count();
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION valuation.test_block_price() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.unit_price = 777.77 THEN RAISE EXCEPTION 'blocked by test'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER test_block_price BEFORE INSERT ON valuation.base_price FOR EACH ROW EXECUTE FUNCTION valuation.test_block_price()');
      try {
        const res = await importAll([horse(1_000_001), horse(777.77, '2026-10-12'), horse(1_000_002, '2026-10-13')]);
        expect(res.status).toBe(500);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_block_price ON valuation.base_price');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS valuation.test_block_price()');
      }
      expect(await count()).toBe(before);
    });

    it('takes 1 to 5000 items: 0 and 5001 are 400, 5000 is imported in one go (the HTTP body limit allows it)', async () => {
      expect((await importAll([])).status).toBe(400);
      const item = (i: number) => ({ assetType: 'VEHICLE', key: { make: 'Bulk', model: `Модел ${i}`, year: 2000 + (i % 25) }, unitPrice: 1_000_000 + i, validFrom: '2026-10-10' });
      expect((await importAll(Array.from({ length: 5001 }, (_, i) => item(i)))).status).toBe(400);
      const before = await count();
      const res = await importAll(Array.from({ length: 5000 }, (_, i) => item(i)));
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(5000);
      expect(await count()).toBe(before + 5000);
    }, 60_000);

    it('a second import of the same file adds a version to every key', async () => {
      const items = [horse(1_100_000, '2026-10-14')];
      await importAll(items);
      const again = await importAll(items);
      expect(again.status).toBe(201);
      const versions = (await db.basePrice.findMany({ where: { orgId: ORG, assetType: 'LIVESTOCK', unitPrice: 1_100_000 } })).map((r) => r.version);
      expect(versions).toHaveLength(2);
      expect(new Set(versions).size).toBe(2);
    });
  });
});
