import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { IntegrationContext } from '../integration.types';
import { MOCK_VEHICLES } from '../vehicle-registry/mock-vehicles';
import type { VehicleListing } from './vehicle-listing-source.port';
import { MOCK_ADS_B_SEEDS, MOCK_UNEGUI_SEEDS, type MockListingSeed } from './mock-listings';
import { MockVehicleListingSource, createMockListingSources } from './mock-vehicle-listing-source';

const NOW = new Date('2026-10-28T09:00:00.000Z');
const ctx = (now: Date = NOW): IntegrationContext => ({ correlationId: 'test', now, signal: new AbortController().signal });
const DAY_MS = 86_400_000;

const seed = (over: Partial<MockListingSeed> = {}): MockListingSeed => ({
  externalId: 'T-1',
  title: 'Toyota Prius 2012',
  make: 'Toyota',
  model: 'Prius',
  year: 2012,
  mileageKm: 90_000,
  price: 25_000_000,
  currency: 'MNT',
  daysAgo: 3,
  ...over,
});

const ListingShape = z.object({
  externalId: z.string().min(1),
  url: z.string().startsWith('https://example.invalid/mock/'),
  title: z.string().min(1),
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int(),
  mileageKm: z.number().int().nonnegative().nullable(),
  price: z.number().positive(),
  currency: z.enum(['MNT', 'USD']),
  postedAt: z.string().datetime(),
});

describe('MockVehicleListingSource', () => {
  const query = { make: 'Toyota', model: 'Prius', yearFrom: 2011, yearTo: 2013 };

  it('keeps only the make, a model starting with the query model, and the year range (inclusive)', async () => {
    const source = new MockVehicleListingSource('T', [
      seed({ externalId: 'ok-2011', year: 2011 }),
      seed({ externalId: 'ok-2013', year: 2013 }),
      seed({ externalId: 'too-old', year: 2010 }),
      seed({ externalId: 'too-new', year: 2014 }),
      seed({ externalId: 'other-make', make: 'Lexus' }),
      seed({ externalId: 'other-model', model: 'Aqua' }),
    ]);
    const found = await source.search(query, ctx());
    expect(found.map((l) => l.externalId)).toEqual(['ok-2011', 'ok-2013']);
  });

  it('compares make and model ignoring case, spaces and punctuation', async () => {
    const source = new MockVehicleListingSource('T', [seed({ make: 'TOYOTA', model: 'land-cruiser  Prado' })]);
    expect(await source.search({ ...query, make: 'toyota', model: 'Land Cruiser Prado' }, ctx())).toHaveLength(1);
  });

  it('simulates fuzzy site search: "Prius Alpha" is returned for "Prius" but not the other way round', async () => {
    const source = new MockVehicleListingSource('T', [seed({ externalId: 'plain' }), seed({ externalId: 'alpha', model: 'Prius Alpha' })]);
    expect((await source.search(query, ctx())).map((l) => l.externalId)).toEqual(['plain', 'alpha']);
    expect((await source.search({ ...query, model: 'Prius Alpha' }, ctx())).map((l) => l.externalId)).toEqual(['alpha']);
  });

  it('derives postedAt from ctx.now minus daysAgo, so the same query on another day shifts the dates', async () => {
    const source = new MockVehicleListingSource('T', [seed({ daysAgo: 0 }), seed({ externalId: 'T-2', daysAgo: 10 })]);
    const [today, tenDays] = await source.search(query, ctx());
    expect(today.postedAt).toBe(NOW.toISOString());
    expect(tenDays.postedAt).toBe(new Date(NOW.getTime() - 10 * DAY_MS).toISOString());

    const later = new Date(NOW.getTime() + 5 * DAY_MS);
    const [, shifted] = await source.search(query, ctx(later));
    expect(shifted.postedAt).toBe(new Date(later.getTime() - 10 * DAY_MS).toISOString());
  });

  it('builds a non-resolvable example URL from the source id and keeps the seed values', async () => {
    const source = new MockVehicleListingSource('MY_SRC', [seed({ price: 7_300, currency: 'USD', mileageKm: null })]);
    expect(await source.search(query, ctx())).toEqual([
      {
        externalId: 'T-1',
        url: 'https://example.invalid/mock/MY_SRC/T-1',
        title: 'Toyota Prius 2012',
        make: 'Toyota',
        model: 'Prius',
        year: 2012,
        mileageKm: null,
        price: 7_300,
        currency: 'USD',
        postedAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString(),
      },
    ]);
    expect(source.id).toBe('MY_SRC');
  });

  it('is deterministic and returns an empty list when nothing matches', async () => {
    const source = new MockVehicleListingSource('T', [seed()]);
    expect(await source.search(query, ctx())).toEqual(await source.search(query, ctx()));
    expect(await source.search({ ...query, make: 'Honda' }, ctx())).toEqual([]);
    expect(await new MockVehicleListingSource('EMPTY', []).search(query, ctx())).toEqual([]);
  });
});

describe('shipped mock datasets', () => {
  const sources = createMockListingSources();
  const searchAll = async (plateNo: string) => {
    const v = MOCK_VEHICLES.find((x) => x.plateNo === plateNo)!;
    const q = { make: v.make, model: v.model, yearFrom: v.manufactureYear - 1, yearTo: v.manufactureYear + 1 };
    const perSource = await Promise.all(sources.map((s) => s.search(q, ctx())));
    return perSource.flat();
  };

  it('exposes the two mock sources with stable ids, as fresh instances each time', () => {
    expect(sources.map((s) => s.id)).toEqual(['MOCK_UNEGUI', 'MOCK_ADS_B']);
    expect(createMockListingSources()[0]).not.toBe(sources[0]);
  });

  it('has the designed number of ads per fixture vehicle (Prius 15, Prado 8, Sonata 5, LX 570 exactly 2, Damas 0)', async () => {
    expect((await searchAll('УЕН5246')).length).toBe(15);
    expect((await searchAll('1234УБА')).length).toBe(8);
    expect((await searchAll('5678УНА')).length).toBe(5);
    expect((await searchAll('7001УБЭ')).length).toBe(2);
    expect((await searchAll('3030БАА')).length).toBe(0);
  });

  it('spreads the Prius ads over both sources and covers every edge case the pricing must handle', async () => {
    const perSource = await Promise.all(sources.map((s) => s.search({ make: 'Toyota', model: 'Prius', yearFrom: 2011, yearTo: 2013 }, ctx())));
    expect(perSource.map((l) => l.length)).toEqual([9, 6]);
    const all = perSource.flat();
    expect(all.some((l) => l.currency === 'USD')).toBe(true);
    expect(all.some((l) => l.mileageKm === null)).toBe(true);
    expect(all.some((l) => l.model === 'Prius Alpha')).toBe(true);
    expect(all.some((l) => Date.parse(l.postedAt) < NOW.getTime() - 90 * DAY_MS)).toBe(true);
    expect(all.some((l) => l.currency === 'MNT' && l.price < 12_000_000)).toBe(true);
    expect(all.some((l) => l.currency === 'MNT' && l.price > 50_000_000)).toBe(true);
  });

  it('keeps the Lexus LX 570 ads one per source and never matches the decoy LX 450d', async () => {
    const perSource = await Promise.all(sources.map((s) => s.search({ make: 'Lexus', model: 'LX 570', yearFrom: 2017, yearTo: 2019 }, ctx())));
    expect(perSource.map((l) => l.length)).toEqual([1, 1]);
    const decoys = [...MOCK_UNEGUI_SEEDS, ...MOCK_ADS_B_SEEDS].filter((s) => s.model === 'LX 450d');
    expect(decoys.length).toBeGreaterThan(0);
  });

  it('keeps Prado and Sonata prices inside the documented demo ranges (MNT)', async () => {
    const prado = await searchAll('1234УБА');
    expect(prado.every((l) => l.currency === 'MNT' && l.price >= 80_000_000 && l.price <= 95_000_000)).toBe(true);
    const sonata = await searchAll('5678УНА');
    expect(sonata.every((l) => l.currency === 'MNT' && l.price >= 28_000_000 && l.price <= 34_000_000)).toBe(true);
  });

  it('only produces well-formed listings with unique ids per source and no future dates', async () => {
    for (const source of sources) {
      const all: VehicleListing[] = [];
      for (const v of MOCK_VEHICLES) {
        all.push(...(await source.search({ make: v.make, model: v.model, yearFrom: 1990, yearTo: 2030 }, ctx())));
      }
      expect(all.length).toBeGreaterThan(0);
      for (const l of all) {
        expect(ListingShape.safeParse(l).success, `${source.id}/${l.externalId}`).toBe(true);
        expect(Date.parse(l.postedAt)).toBeLessThanOrEqual(NOW.getTime());
        expect(l.url).toBe(`https://example.invalid/mock/${source.id}/${l.externalId}`);
      }
      expect(new Set(all.map((l) => l.externalId)).size).toBe(all.length);
    }
  });
});
