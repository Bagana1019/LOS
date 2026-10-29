import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HaircutRuleView } from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import { DEMO_HAIRCUTS, seedValuation } from '../../../prisma/seed-data';
import { HAS_DB, as, asNobody, createApp } from '../../../test/app';

// FR-14.2 — haircut rules over HTTP and a real database; every describe block works in its own organisation.

const VEHICLE_BODY = {
  assetType: 'VEHICLE',
  description: { plateNo: '9999УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012 }, // not in the registry: the haircut is resolved all the same
};

describe.skipIf(!HAS_DB)('haircut rules (FR-14.2)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const http = () => request(app.getHttpServer());
  const put = (body: unknown, headers: Record<string, string>) => http().put('/api/haircuts').set(headers).send(body as object);
  const get = (query: string, headers: Record<string, string>) => http().get(`/api/haircuts${query}`).set(headers);
  const del = (id: string, headers: Record<string, string>) => http().delete(`/api/haircuts/${id}`).set(headers);
  const rowsOf = (orgId: string, where: Record<string, unknown> = {}) => db.haircutRule.findMany({ where: { orgId, ...where } });

  beforeAll(async () => {
    app = await createApp();
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('access', () => {
    const rule = { productId: null, assetType: 'LAND', haircutRate: 0.5 };

    it('reading needs application:read (401 / 403 / 200 for every staff role)', async () => {
      const org = randomUUID();
      expect((await http().get('/api/haircuts')).status).toBe(401);
      expect((await get('', asNobody(org))).status).toBe(403);
      for (const user of ['officerA', 'manager', 'approver', 'admin'] as const) expect((await get('', as(user, org))).status, user).toBe(200);
    });

    it('PUT and DELETE need settings:manage: ADMIN only', async () => {
      const org = randomUUID();
      const created = await put(rule, as('admin', org));
      expect(created.status).toBe(200);
      for (const user of ['officerA', 'manager', 'approver'] as const) {
        expect((await put(rule, as(user, org))).status, user).toBe(403);
        expect((await del(created.body.id, as(user, org))).status, user).toBe(403);
      }
      expect((await put(rule, asNobody(org))).status).toBe(403);
      expect((await http().put('/api/haircuts').send(rule)).status).toBe(401);
      expect((await rowsOf(org))[0].isActive).toBe(true); // nobody but the admin changed anything
    });
  });

  describe('GET /haircuts', () => {
    const ORG = randomUUID();
    const admin = as('admin', ORG);
    beforeAll(async () => {
      await seedValuation(db, ORG);
    });

    it('lists the seeded org-wide rules', async () => {
      const res = await get('', admin);
      expect(res.status).toBe(200);
      const rules = HaircutRuleView.array().parse(res.body);
      expect(rules).toHaveLength(8);
      expect(Object.fromEntries(rules.map((r) => [r.assetType, r.haircutRate]))).toEqual(DEMO_HAIRCUTS);
      expect(rules.every((r) => r.productId === null && r.isActive)).toBe(true);
    });

    it('filters by asset type and by product; productId=null means the org-wide rules', async () => {
      const product = randomUUID();
      await put({ productId: product, assetType: 'VEHICLE', haircutRate: 0.55 }, admin);
      await put({ productId: product, assetType: 'LAND', haircutRate: 0.45 }, admin);

      expect(HaircutRuleView.array().parse((await get('?assetType=VEHICLE', admin)).body)).toHaveLength(2); // org-wide + product
      expect(HaircutRuleView.array().parse((await get(`?productId=${product}`, admin)).body).map((r) => r.assetType).sort()).toEqual(['LAND', 'VEHICLE']);
      expect(HaircutRuleView.array().parse((await get(`?productId=${product}&assetType=LAND`, admin)).body)).toMatchObject([{ productId: product, assetType: 'LAND', haircutRate: 0.45 }]);
      expect(HaircutRuleView.array().parse((await get('?productId=null', admin)).body)).toHaveLength(8);
      expect((await get('?productId=other-product', admin)).body).toEqual([]);
    });

    it('rejects an unknown asset type (400)', async () => {
      expect((await get('?assetType=SPACESHIP', admin)).status).toBe(400);
    });

    it('is scoped to the organisation', async () => {
      expect((await get('', as('admin', randomUUID()))).body).toEqual([]);
    });
  });

  describe('PUT /haircuts (upsert by org, product or none, asset type)', () => {
    it('creates a product rule, then updates the same row', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      const product = randomUUID();
      const created = await put({ productId: product, assetType: 'APARTMENT', haircutRate: 0.7 }, admin);
      expect(created.status).toBe(200);
      expect(HaircutRuleView.parse(created.body)).toMatchObject({ productId: product, assetType: 'APARTMENT', haircutRate: 0.7, isActive: true });
      const updated = await put({ productId: product, assetType: 'APARTMENT', haircutRate: 0.65 }, admin);
      expect(updated.body).toMatchObject({ id: created.body.id, haircutRate: 0.65 });
      expect(await rowsOf(org)).toHaveLength(1);
      expect(await rowsOf(org, { createdBy: as('admin')['x-user-id'] })).toHaveLength(1);
    });

    it('a NULL product (all products) is also one row per asset type: the existing rule is updated, not duplicated', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      await seedValuation(db, org);
      const seeded = (await rowsOf(org, { assetType: 'LAND' }))[0];
      const res = await put({ productId: null, assetType: 'LAND', haircutRate: 0.55 }, admin);
      expect(res.body).toMatchObject({ id: seeded.id, productId: null, haircutRate: 0.55 });
      expect(await rowsOf(org, { assetType: 'LAND', productId: null })).toHaveLength(1);
      expect(await rowsOf(org)).toHaveLength(8);
    });

    it('parallel upserts of one NULL-product rule leave exactly one row', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => put({ productId: null, assetType: 'HOUSE', haircutRate: 0.5 + i / 100 }, admin)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await rowsOf(org, { assetType: 'HOUSE' })).toHaveLength(1);
    });

    it('the same asset type with another product or none are different rules', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      await put({ productId: null, assetType: 'VEHICLE', haircutRate: 0.7 }, admin);
      await put({ productId: 'p-1', assetType: 'VEHICLE', haircutRate: 0.6 }, admin);
      await put({ productId: 'p-2', assetType: 'VEHICLE', haircutRate: 0.5 }, admin);
      expect(await rowsOf(org)).toHaveLength(3);
    });

    it('accepts 0 and 1 and four decimals', async () => {
      const org = randomUUID();
      for (const haircutRate of [0, 1, 0.1234]) {
        const res = await put({ productId: null, assetType: 'OTHER', haircutRate }, as('admin', org));
        expect(res.status).toBe(200);
        expect(res.body.haircutRate).toBe(haircutRate);
      }
    });

    it('rejects a rate outside 0…1, more than four decimals, an unknown asset type and an empty product id (400)', async () => {
      const admin = as('admin', randomUUID());
      for (const bad of [
        { productId: null, assetType: 'LAND', haircutRate: 1.01 },
        { productId: null, assetType: 'LAND', haircutRate: -0.1 },
        { productId: null, assetType: 'LAND', haircutRate: 0.12345 },
        { productId: null, assetType: 'SPACESHIP', haircutRate: 0.5 },
        { productId: '', assetType: 'LAND', haircutRate: 0.5 },
        { productId: '   ', assetType: 'LAND', haircutRate: 0.5 },
        { assetType: 'LAND', haircutRate: 0.5 },
        {},
      ]) {
        const res = await put(bad, admin);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('DELETE /haircuts/:id (soft delete)', () => {
    it('sets is_active = false: the rule leaves the default list, stays in includeInactive, and a new PUT brings it back', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      const created = await put({ productId: null, assetType: 'LIVESTOCK', haircutRate: 0.4 }, admin);

      const res = await del(created.body.id, admin);
      expect(res.status).toBe(200);
      expect(HaircutRuleView.parse(res.body)).toMatchObject({ id: created.body.id, isActive: false, haircutRate: 0.4 });
      expect((await get('', admin)).body).toEqual([]);
      expect((await get('?includeInactive=true', admin)).body).toHaveLength(1);
      expect(await rowsOf(org)).toHaveLength(1); // the row is kept

      expect((await del(created.body.id, admin)).status).toBe(200); // idempotent

      const back = await put({ productId: null, assetType: 'LIVESTOCK', haircutRate: 0.35 }, admin);
      expect(back.body).toMatchObject({ id: created.body.id, isActive: true, haircutRate: 0.35 });
    });

    it('404 for an unknown rule or a rule of another organisation, 400 for a malformed id', async () => {
      const org = randomUUID();
      const created = await put({ productId: null, assetType: 'EQUIPMENT', haircutRate: 0.4 }, as('admin', org));
      expect((await del(randomUUID(), as('admin', org))).status).toBe(404);
      const other = await del(created.body.id, as('admin', randomUUID()));
      expect(other.status).toBe(404);
      expect(other.body.code).toBe('HAIRCUT_NOT_FOUND');
      expect((await rowsOf(org))[0].isActive).toBe(true);
      expect((await del('not-a-uuid', as('admin', org))).status).toBe(400);
    });
  });

  describe('resolution in the valuation (FR-14.2): PRODUCT_RULE > PRODUCT_JSON > ORG_RULE > DEMO_DEFAULT', () => {
    it('follows the four levels as rules are added and removed', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      const officer = as('officerA', org);
      const product = randomUUID();
      const haircutOf = async (over: { productId?: string | null; productHaircutRate?: number | null } = {}) => {
        const res = await http()
          .post('/api/valuate/collateral/suggest')
          .set(officer)
          .send({ collateralId: randomUUID(), applicationId: randomUUID(), productId: null, productHaircutRate: null, externalValuationThreshold: null, validityDays: 90, ...VEHICLE_BODY, ...over });
        expect(res.status).toBe(200);
        return res.body.haircut as { rate: number; source: string };
      };

      // 4. nothing configured: the DEMO table (VEHICLE 0.70)
      expect(await haircutOf({ productId: product })).toEqual({ rate: 0.7, source: 'DEMO_DEFAULT' });
      // 3. the org-wide rule (product_id NULL)
      const orgRule = await put({ productId: null, assetType: 'VEHICLE', haircutRate: 0.66 }, admin);
      expect(await haircutOf({ productId: product })).toEqual({ rate: 0.66, source: 'ORG_RULE' });
      expect(await haircutOf()).toEqual({ rate: 0.66, source: 'ORG_RULE' }); // no product at all
      // 2. product.haircut_json sent by origination beats the org-wide rule
      expect(await haircutOf({ productId: product, productHaircutRate: 0.6 })).toEqual({ rate: 0.6, source: 'PRODUCT_JSON' });
      // 1. the product's own rule beats everything
      const productRule = await put({ productId: product, assetType: 'VEHICLE', haircutRate: 0.55 }, admin);
      expect(await haircutOf({ productId: product, productHaircutRate: 0.6 })).toEqual({ rate: 0.55, source: 'PRODUCT_RULE' });
      // another product is not affected by it
      expect(await haircutOf({ productId: randomUUID(), productHaircutRate: 0.6 })).toEqual({ rate: 0.6, source: 'PRODUCT_JSON' });
      // a rule for another asset type is not used
      await put({ productId: product, assetType: 'LAND', haircutRate: 0.1 }, admin);
      expect(await haircutOf({ productId: product, productHaircutRate: 0.6 })).toEqual({ rate: 0.55, source: 'PRODUCT_RULE' });

      // deleting walks back down the list
      await del(productRule.body.id, admin);
      expect(await haircutOf({ productId: product, productHaircutRate: 0.6 })).toEqual({ rate: 0.6, source: 'PRODUCT_JSON' });
      expect(await haircutOf({ productId: product })).toEqual({ rate: 0.66, source: 'ORG_RULE' });
      await del(orgRule.body.id, admin);
      expect(await haircutOf({ productId: product })).toEqual({ rate: 0.7, source: 'DEMO_DEFAULT' });
    });

    it('a saved valuation applies the stored rule: market value × rate, with the source recorded', async () => {
      const org = randomUUID();
      const admin = as('admin', org);
      const product = randomUUID();
      await put({ productId: product, assetType: 'INVENTORY', haircutRate: 0.35 }, admin);
      const res = await http()
        .post('/api/valuate/collateral')
        .set(as('officerA', org))
        .send({
          collateralId: randomUUID(), applicationId: randomUUID(), productId: product, productHaircutRate: 0.9, externalValuationThreshold: null, validityDays: 90,
          assetType: 'INVENTORY', description: { name: 'Бараа', stocktakeValue: 30_000_000, stocktakeDate: '2026-10-01' }, marketValue: 30_000_000,
        });
      expect(res.status).toBe(201);
      expect(res.body.valuation).toMatchObject({ haircutRate: 0.35, haircutSource: 'PRODUCT_RULE', collateralValue: 10_500_000 });
    });
  });
});
