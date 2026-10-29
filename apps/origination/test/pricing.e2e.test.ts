import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPricingTiers } from '../prisma/seeds/pricing-tiers';
import { PrismaService } from '../src/prisma.service';
import { HAS_DB, as, createApp } from './app';

const ORG2 = '00000000-0000-4000-8000-0000000009a2';
const ROLES = ['officerA', 'manager', 'approver', 'admin'] as const;
const BASE = '/api/loan-terms/pricing';
const tier = (code: string, minScore: number, interestRate: number, feeRate: number, over: Record<string, unknown> = {}) =>
  ({ code, name: `Tier ${code}`, band: minScore >= 650 ? 'GREEN' : minScore >= 350 ? 'YELLOW' : 'RED', minScore, interestRate, feeRate, isDefault: false, ...over });
const FLAT = [tier('HI', 500, 24, 0.01), tier('LO', 0, 30, 0.02, { isDefault: true })];

describe.skipIf(!HAS_DB)('origination risk-based pricing (FR-5.5, BR-6, BR-14)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const api = () => request(app.getHttpServer());
  const quote = (body: object, user: (typeof ROLES)[number] = 'officerA', org?: string) =>
    api().post(`${BASE}/quote`).set(as(user)).set(org ? { 'x-org-id': org } : {}).send(body);
  const activeSets = (productId: string | null, orgId: string = SEED.org.id) => db.pricingTier.findMany({ where: { orgId, productId, isActive: true } });

  beforeAll(async () => {
    app = await createApp();
    db = app.get(PrismaService);
    await db.product.upsert({
      where: { orgId_code: { orgId: ORG2, code: 'CONSUMER' } }, update: {},
      create: { orgId: ORG2, id: 'org2-consumer', code: 'CONSUMER', name: 'Org2', productType: 'CONSUMER', minAmount: 1, maxAmount: 1_000_000, minTerm: 1, maxTerm: 12, minRate: 10, maxRate: 50 },
    });
  });
  afterAll(async () => {
    await db.pricingTier.deleteMany({ where: { orgId: ORG2 } });
    await db.product.deleteMany({ where: { orgId: ORG2 } });
    await app.close();
  });

  describe('access', () => {
    it('needs gateway identity, and the customer portal (no staff role) is refused', async () => {
      expect((await api().get(`${BASE}/tiers`)).status).toBe(401);
      expect((await api().post(`${BASE}/quote`).send({})).status).toBe(401);
      const customer = { 'x-customer-id': 'c-1', 'x-org-id': SEED.org.id };
      expect((await api().get(`${BASE}/tiers`).set(customer)).status).toBe(403);
      expect((await api().post(`${BASE}/quote`).set(customer).send({ productId: SEED.products.consumer, soscoScore: 700 })).status).toBe(403);
    });
    it('every staff role may read tiers and ask for a quote; only ADMIN may change tiers', async () => {
      for (const u of ROLES) {
        expect((await api().get(`${BASE}/tiers`).set(as(u))).status, u).toBe(200);
        expect((await quote({ productId: SEED.products.consumer, soscoScore: 700 }, u)).status, u).toBe(200);
      }
      for (const u of ['officerA', 'manager', 'approver'] as const) {
        expect((await api().put(`${BASE}/tiers`).set(as(u)).send({ tiers: FLAT })).status, u).toBe(403);
      }
    });
  });

  describe('seeded org-wide rate card', () => {
    it('is the DEMO card: annual-percent rate, fractional fee, one default tier, rates fall as the score rises (BR-14)', async () => {
      const res = await api().get(`${BASE}/tiers`).set(as('officerA'));
      expect(res.body).toMatchObject({ scope: 'DEFAULT', productId: null, version: 1 });
      expect(res.body.tiers.map((t: { code: string }) => t.code)).toEqual(['E', 'D', 'C', 'B', 'A']); // minScore asc
      expect(res.body.tiers.filter((t: { isDefault: boolean }) => t.isDefault).map((t: { code: string }) => t.code)).toEqual(['C']);
      const [e, , , , a] = res.body.tiers;
      expect(a).toMatchObject({ band: 'GREEN', minScore: 800, interestRate: 18, feeRate: 0.005 });
      expect(e).toMatchObject({ band: 'RED', minScore: 0, interestRate: 42, feeRate: 0.03 });
    });
    it('a product without its own card falls back to the org-wide one; an empty productId means org-wide', async () => {
      expect((await api().get(`${BASE}/tiers?productId=${SEED.products.consumer}`).set(as('officerA'))).body).toMatchObject({ scope: 'DEFAULT', productId: null });
      expect((await api().get(`${BASE}/tiers?productId=`).set(as('officerA'))).body).toMatchObject({ scope: 'DEFAULT' });
    });
    it('seeding again (also concurrently, also for a fresh org) never creates a second version or a second active set', async () => {
      expect(await seedPricingTiers(db, SEED.org.id)).toBe(false);
      expect((await activeSets(null)).length).toBe(5);
      const created = await Promise.all(Array.from({ length: 4 }, () => seedPricingTiers(db, ORG2)));
      expect(created.filter(Boolean).length).toBe(1);
      expect(await activeSets(null, ORG2)).toHaveLength(5);
      expect(await db.pricingTier.count({ where: { orgId: ORG2, productId: null } })).toBe(5);
    });
  });

  describe('quote (FR-5.5)', () => {
    const consumer = SEED.products.consumer; // 18–42 %
    it('a green score gets a lower rate and fee than a red score', async () => {
      const green = (await quote({ productId: consumer, soscoScore: 860, amount: 10_000_000 })).body;
      const red = (await quote({ productId: consumer, soscoScore: 240, amount: 10_000_000 })).body;
      expect(green).toMatchObject({ basis: 'SCORE', tier: { code: 'A', band: 'GREEN' }, interestRate: 18, feeRate: 0.005, feeAmount: 50_000, rateBound: null, productRateBounds: { minRate: 18, maxRate: 42 }, config: { scope: 'DEFAULT', productId: null } });
      expect(red).toMatchObject({ tier: { code: 'E', band: 'RED' }, interestRate: 42, feeRate: 0.03, feeAmount: 300_000, rateBound: null });
      expect(green.interestRate).toBeLessThan(red.interestRate);
      expect(green.feeRate).toBeLessThan(red.feeRate);
    });
    it('prices score 0 with the lowest tier and falls back to the default tier while there is no score', async () => {
      expect((await quote({ productId: consumer, soscoScore: 0 })).body).toMatchObject({ basis: 'SCORE', tier: { code: 'E' }, interestRate: 42 });
      expect((await quote({ productId: consumer, soscoScore: null, amount: 1_000 })).body).toMatchObject({ basis: 'DEFAULT_TIER', soscoScore: null, tier: { code: 'C' }, interestRate: 28, feeAmount: 15 });
    });
    it('clamps to the product [min_rate, max_rate] and names the side (BR-6)', async () => {
      const vehicle = SEED.products.vehicle; // 20–36 %
      expect((await quote({ productId: vehicle, soscoScore: 900 })).body).toMatchObject({ tierInterestRate: 18, interestRate: 20, rateBound: 'MIN', productRateBounds: { minRate: 20, maxRate: 36 } });
      expect((await quote({ productId: vehicle, soscoScore: 0 })).body).toMatchObject({ tierInterestRate: 42, interestRate: 36, rateBound: 'MAX' });
      expect((await quote({ productId: vehicle, soscoScore: 700 })).body).toMatchObject({ interestRate: 22, rateBound: null });
    });
    it('rejects unknown, foreign-org and inactive products with 404, before looking at the tiers', async () => {
      expect((await quote({ productId: 'nope', soscoScore: 700 })).body).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
      expect((await quote({ productId: 'org2-consumer', soscoScore: 700 })).status).toBe(404); // org 2's product, asked as org 1
      expect((await api().get(`${BASE}/tiers?productId=org2-consumer`).set(as('officerA'))).status).toBe(404);
      await db.product.update({ where: { id: SEED.products.business }, data: { isActive: false } });
      try { expect((await quote({ productId: SEED.products.business, soscoScore: 700 })).status).toBe(404); }
      finally { await db.product.update({ where: { id: SEED.products.business }, data: { isActive: true } }); }
    });
    it('is scoped to the organisation: org 2 has the product but no card yet → 404 PRICING_NOT_CONFIGURED, then its own once saved', async () => {
      await db.pricingTier.deleteMany({ where: { orgId: ORG2 } });
      const res = await quote({ productId: 'org2-consumer', soscoScore: 700 }, 'officerA', ORG2);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PRICING_NOT_CONFIGURED');
      expect((await api().get(`${BASE}/tiers`).set(as('officerA')).set('x-org-id', ORG2)).body.code).toBe('PRICING_NOT_CONFIGURED');
      await seedPricingTiers(db, ORG2);
      expect((await quote({ productId: 'org2-consumer', soscoScore: 700 }, 'officerA', ORG2)).body).toMatchObject({ interestRate: 22, productRateBounds: { minRate: 10, maxRate: 50 } });
      expect((await api().put(`${BASE}/tiers`).set(as('admin')).set('x-org-id', ORG2).send({ tiers: FLAT })).body.version).toBe(2);
      expect((await api().get(`${BASE}/tiers`).set(as('officerA'))).body.version).toBe(1); // org 1 unchanged
    });
    it('validates the body (400) — score range, amount, product id', async () => {
      const bad = [{ soscoScore: 1000.5 }, { soscoScore: -1 }, { soscoScore: '700' }, { soscoScore: undefined }, { amount: 0 }, { amount: JSON.parse('1e999') }, { productId: '' }, { productId: 'a\u0000b' }];
      for (const over of bad) {
        const res = await quote({ productId: SEED.products.consumer, soscoScore: 700, ...over });
        expect(res.status, JSON.stringify(over)).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('saving tiers (ADMIN)', () => {
    const business = SEED.products.business;
    it('a product card overrides the org-wide one for that product only, and stamps quotes with its version', async () => {
      const res = await api().put(`${BASE}/tiers`).set(as('admin')).send({ productId: business, tiers: FLAT });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ scope: 'PRODUCT', productId: business, version: 1, updatedBy: SEED.users.admin.id });
      expect((await quote({ productId: business, soscoScore: 900 })).body).toMatchObject({ interestRate: 24, rateBound: null, config: { scope: 'PRODUCT', productId: business, version: 1 } });
      expect((await quote({ productId: SEED.products.consumer, soscoScore: 900 })).body.config).toMatchObject({ scope: 'DEFAULT', version: 1 });
      expect((await api().put(`${BASE}/tiers`).set(as('admin')).send({ productId: business, tiers: FLAT })).body.version).toBe(2);
      expect((await quote({ productId: business, soscoScore: 900 })).body.config.version).toBe(2);
    });
    it('keeps history: a re-save deactivates the previous version, never deletes it, and leaves exactly one active card', async () => {
      const versions = await db.pricingTier.groupBy({ by: ['version', 'isActive'], where: { orgId: SEED.org.id, productId: business }, _count: true, orderBy: { version: 'asc' } });
      expect(versions).toEqual([{ version: 1, isActive: false, _count: 2 }, { version: 2, isActive: true, _count: 2 }]);
    });
    it('audits before/after and queues SettingsChanged in the same transaction', async () => {
      const evBefore = await db.outbox.count({ where: { type: 'SettingsChanged' } });
      const res = await api().put(`${BASE}/tiers`).set(as('admin')).set('x-correlation-id', 'corr-price-1').send({ productId: business, tiers: FLAT });
      expect(res.status).toBe(200);
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: 'PRICING_TIERS', entityId: business, correlationId: 'corr-price-1' } });
      expect(audit).toMatchObject({ action: 'PRICING_TIERS_REPLACED', actorId: SEED.users.admin.id });
      expect(audit.beforeJson).toMatchObject({ version: res.body.version - 1 });
      expect(audit.afterJson).toMatchObject({ version: res.body.version, tiers: expect.arrayContaining([expect.objectContaining({ code: 'HI', interestRate: 24 })]) });
      const events = await db.outbox.findMany({ where: { type: 'SettingsChanged' }, orderBy: { createdAt: 'desc' }, take: 1 });
      expect(await db.outbox.count({ where: { type: 'SettingsChanged' } })).toBe(evBefore + 1);
      expect(events[0]!.payload).toMatchObject({ key: 'pricing.tiers', productId: business, correlationId: 'corr-price-1', actorId: SEED.users.admin.id });
    });
    it('the org-wide card is saved with productId null/omitted', async () => {
      const ev = await api().put(`${BASE}/tiers`).set(as('admin')).send({ productId: null, tiers: [tier('ALL', 0, 25, 0.01, { isDefault: true })] });
      expect(ev.body).toMatchObject({ scope: 'DEFAULT', productId: null, version: 2 });
      const audit = await db.auditLog.findFirstOrThrow({ where: { entity: 'PRICING_TIERS', entityId: 'DEFAULT' }, orderBy: { at: 'desc' } });
      expect(audit.beforeJson).toMatchObject({ version: 1 });
      // restore the seeded card for the other tests / later runs
      await api().put(`${BASE}/tiers`).set(as('admin')).send({ tiers: (await db.pricingTier.findMany({ where: { orgId: SEED.org.id, productId: null, version: 1 }, orderBy: { minScore: 'asc' } })).map((r) => tier(r.code, r.minScore, r.interestRate.toNumber(), r.feeRate.toNumber(), { name: r.name, band: r.band, isDefault: r.isDefault })) });
      expect((await quote({ productId: SEED.products.consumer, soscoScore: 860 })).body).toMatchObject({ interestRate: 18, config: { scope: 'DEFAULT', version: 3 } });
    });
    it('stores 4-decimal values exactly (float noise is snapped) and returns them as numbers', async () => {
      const res = await api().put(`${BASE}/tiers`).set(as('admin')).send({ productId: business, tiers: [tier('X', 0, 0.1 + 0.2, 0.0575, { isDefault: true })] });
      expect(res.body.tiers[0]).toMatchObject({ interestRate: 0.3, feeRate: 0.0575 });
    });
    it('never leaves two active cards, even when several admins save the same scope at once', async () => {
      const vehicle = SEED.products.vehicle;
      const results = await Promise.all(Array.from({ length: 8 }, () => api().put(`${BASE}/tiers`).set(as('admin')).send({ productId: vehicle, tiers: FLAT })));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(results.map((r) => r.body.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const active = await activeSets(vehicle);
      expect(active).toHaveLength(2);
      expect(new Set(active.map((r) => r.version)).size).toBe(1);
    });

    describe('invalid cards are refused and leave no trace', () => {
      const cases: [string, object[], string][] = [
        ['higher score priced above a lower one (rate)', [tier('HI', 500, 30, 0.01), tier('LO', 0, 24, 0.02, { isDefault: true })], 'INTEREST_RATE_NOT_MONOTONIC'],
        ['higher score priced above a lower one (fee)', [tier('HI', 500, 20, 0.05), tier('LO', 0, 24, 0.02, { isDefault: true })], 'FEE_RATE_NOT_MONOTONIC'],
        ['no tier starting at 0', [tier('HI', 500, 20, 0.01, { isDefault: true }), tier('LO', 100, 24, 0.02)], 'FIRST_TIER_NOT_ZERO'],
        ['two default tiers', [tier('HI', 500, 20, 0.01, { isDefault: true }), tier('LO', 0, 24, 0.02, { isDefault: true })], 'DEFAULT_TIER_COUNT'],
        ['no default tier', [tier('HI', 500, 20, 0.01), tier('LO', 0, 24, 0.02)], 'DEFAULT_TIER_COUNT'],
        ['duplicate code', [tier('HI', 500, 20, 0.01), tier('HI', 0, 24, 0.02, { isDefault: true })], 'DUPLICATE_CODE'],
        ['duplicate minScore', [tier('A', 0, 20, 0.01, { isDefault: true }), tier('B', 0, 24, 0.02)], 'DUPLICATE_MIN_SCORE'],
      ];
      it.each(cases)('422 %s', async (_name, tiers, issue) => {
        const counts = async () => [await db.pricingTier.count(), await db.auditLog.count(), await db.outbox.count()];
        const before = await counts();
        const res = await api().put(`${BASE}/tiers`).set(as('admin')).send({ productId: SEED.products.consumer, tiers });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_TIER_SET');
        expect(res.body.details.map((i: { code: string }) => i.code)).toContain(issue);
        expect(await counts()).toEqual(before);
      });
      it('400 for malformed input: percent/fraction ranges, 5 decimals, score range, bad code, empty or oversized set', async () => {
        const put = (body: object) => api().put(`${BASE}/tiers`).set(as('admin')).send(body);
        const ok = tier('OK', 0, 24, 0.01, { isDefault: true });
        for (const bad of [{ interestRate: 100.5 }, { feeRate: 1.5 }, { interestRate: 24.12345 }, { feeRate: -0.1 }, { minScore: 1001 }, { code: 'bad code' }, { band: 'BLUE' }, { name: 'a\u0000b' }]) {
          const res = await put({ tiers: [{ ...ok, ...bad }] });
          expect(res.status, JSON.stringify(bad)).toBe(400);
          expect(res.body.code).toBe('VALIDATION_FAILED');
        }
        expect((await put({ tiers: [] })).status).toBe(400);
        expect((await put({ tiers: Array.from({ length: 11 }, (_, i) => tier(`T${i}`, i, 20, 0.01, { isDefault: i === 0 })) })).status).toBe(400);
        expect((await put({ productId: 'nope', tiers: [ok] })).body.code).toBe('PRODUCT_NOT_FOUND');
      });
    });
  });
});
