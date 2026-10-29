import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BasePriceInput } from '@los/contracts';
import { MOCK_VEHICLES } from '../src/integrations/vehicle-registry/mock-vehicles';
import { canonicalKey, keyMatchesAssetType } from '../src/modules/base-price/base-price.keys';
import { PrismaService } from '../src/prisma.service';
import { DEMO_BASE_PRICES, DEMO_HAIRCUTS, DEMO_VALID_FROM, seedValuation } from '../prisma/seed-data';
import { HAS_DB, createApp } from './app';

// docs/04 Модуль 0 + Модуль 6: the seed (haircut rules + DEMO base prices) is create-only and idempotent.

const DISTRICTS = ['Баянзүрх', 'Сүхбаатар', 'Хан-Уул', 'Баянгол', 'Чингэлтэй', 'Сонгинохайрхан', 'Налайх', 'Багануур', 'Багахангай'];
const ofType = (t: string) => DEMO_BASE_PRICES.filter((p) => p.assetType === t);

describe('DEMO base price data', () => {
  it('every item is valid input for POST /base-prices and already in canonical form', () => {
    for (const p of DEMO_BASE_PRICES) {
      const parsed = BasePriceInput.parse({ assetType: p.assetType, key: p.key, unitPrice: p.unitPrice, validFrom: DEMO_VALID_FROM });
      expect(keyMatchesAssetType(p.assetType, parsed.key), JSON.stringify(p)).toBe(true);
      expect(canonicalKey(parsed.key), JSON.stringify(p)).toEqual(p.key);
    }
  });

  it('has no duplicate keys', () => {
    const seen = new Set(DEMO_BASE_PRICES.map((p) => `${p.assetType}${JSON.stringify(Object.entries(p.key).sort())}`));
    expect(seen.size).toBe(DEMO_BASE_PRICES.length);
  });

  it('covers the nine districts of Ulaanbaatar for APARTMENT, HOUSE and LAND, with land below apartments', () => {
    for (const type of ['APARTMENT', 'HOUSE', 'LAND']) {
      const districtOnly = ofType(type).filter((p) => !('khoroo' in p.key));
      expect(districtOnly.map((p) => p.key.district).sort(), type).toEqual([...DISTRICTS].sort());
    }
    for (const d of DISTRICTS) {
      const price = (type: string) => ofType(type).find((p) => p.key.district === d && !('khoroo' in p.key))!.unitPrice;
      expect(price('LAND'), d).toBeLessThan(price('APARTMENT'));
      expect(price('HOUSE'), d).toBeLessThan(price('APARTMENT'));
    }
  });

  it('apartment prices are 3–6 million ₮/m²', () => {
    for (const p of ofType('APARTMENT')) {
      expect(p.unitPrice, JSON.stringify(p.key)).toBeGreaterThanOrEqual(3_000_000);
      expect(p.unitPrice, JSON.stringify(p.key)).toBeLessThanOrEqual(6_000_000);
    }
  });

  it('livestock: five kinds × adult/young, a young animal costs less', () => {
    const livestock = ofType('LIVESTOCK');
    expect(livestock).toHaveLength(10);
    for (const kind of ['HORSE', 'CATTLE', 'SHEEP', 'GOAT', 'CAMEL']) {
      const adult = livestock.find((p) => p.key.livestockType === kind && p.key.ageGroup === 'ADULT')!;
      const young = livestock.find((p) => p.key.livestockType === kind && p.key.ageGroup === 'YOUNG')!;
      expect(young.unitPrice, kind).toBeLessThan(adult.unitPrice);
    }
  });

  it('has a base price for the exact make/model/year of every mock registry vehicle, and for neighbouring years', () => {
    const vehicles = ofType('VEHICLE');
    for (const v of MOCK_VEHICLES) {
      const years = vehicles.filter((p) => p.key.make === v.make && p.key.model === v.model).map((p) => Number(p.key.year));
      expect(years, `${v.make} ${v.model}`).toContain(v.manufactureYear);
      expect(years.length, `${v.make} ${v.model}`).toBeGreaterThanOrEqual(3);
      expect(years).toContain(v.manufactureYear - 1);
      expect(years).toContain(v.manufactureYear + 1);
    }
  });

  it('haircuts are the DEMO table of docs/05 §9', () => {
    expect(DEMO_HAIRCUTS).toEqual({ VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 });
  });
});

describe.skipIf(!HAS_DB)('seedValuation (database)', () => {
  let app: INestApplication;
  let db: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    db = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates the rules and prices once; a second run creates nothing', async () => {
    const org = randomUUID();
    expect(await seedValuation(db, org)).toEqual({ haircuts: 8, basePrices: DEMO_BASE_PRICES.length });
    expect(await seedValuation(db, org)).toEqual({ haircuts: 0, basePrices: 0 });
    expect(await db.haircutRule.count({ where: { orgId: org } })).toBe(8);
    expect(await db.basePrice.count({ where: { orgId: org } })).toBe(DEMO_BASE_PRICES.length);
    expect(await db.basePrice.count({ where: { orgId: org, version: 1 } })).toBe(DEMO_BASE_PRICES.length);
  });

  it('the global test seed is in place for the seeded organisation (idempotent over the global-setup run)', async () => {
    const { SEED } = await import('@los/database');
    expect(await seedValuation(db, SEED.org.id)).toEqual({ haircuts: 0, basePrices: 0 });
  });

  it('never overwrites an admin\'s changes: an edited rule and a new price version survive; a deleted row is recreated', async () => {
    const org = randomUUID();
    await seedValuation(db, org);
    const rule = await db.haircutRule.findFirstOrThrow({ where: { orgId: org, assetType: 'VEHICLE', productId: null } });
    await db.haircutRule.update({ where: { id: rule.id }, data: { haircutRate: 0.42, isActive: false } });
    const price = await db.basePrice.findFirstOrThrow({ where: { orgId: org, assetType: 'LAND', keyJson: { equals: { district: 'Налайх' } } } });
    await db.basePrice.create({ data: { orgId: org, assetType: 'LAND', keyJson: { district: 'Налайх' }, unitPrice: 555_555, validFrom: new Date('2026-06-01'), version: 2 } });
    const removed = await db.basePrice.findFirstOrThrow({ where: { orgId: org, assetType: 'LIVESTOCK', keyJson: { equals: { livestockType: 'HORSE', ageGroup: 'ADULT' } } } });
    await db.basePrice.delete({ where: { id: removed.id } });

    expect(await seedValuation(db, org)).toEqual({ haircuts: 0, basePrices: 1 });

    const after = await db.haircutRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([Number(after.haircutRate), after.isActive]).toEqual([0.42, false]);
    expect(await db.basePrice.count({ where: { orgId: org, assetType: 'LAND', keyJson: { equals: { district: 'Налайх' } } } })).toBe(2); // v1 + the admin's v2, no new v1
    expect(Number(price.unitPrice)).not.toBe(555_555);
    expect(await db.basePrice.count({ where: { orgId: org, assetType: 'LIVESTOCK', keyJson: { equals: { livestockType: 'HORSE', ageGroup: 'ADULT' } } } })).toBe(1);
  });
});
