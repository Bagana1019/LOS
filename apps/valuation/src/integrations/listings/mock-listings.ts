// Demo datasets of the mock classified-ads sources. ALL prices, mileages and ids are FICTIONAL demo values, not market data.
// Designed against the default demo parameters (usdMnt 3500, yearTolerance 1, maxListingAgeDays 90, yearAdjustmentRate 0.05,
// mileageAdjustmentPer10kKm 0.01) so that each fixture plate (see README.md) ends in a different outcome:
//   Toyota Prius 2012, 90 000 km  -> OK, enough ads, one cheap + one expensive outlier, one stale ad, one USD ad, one other model
//   Toyota Land Cruiser Prado 2015 -> OK, 8 ads with a wider spread
//   Hyundai Sonata 2017           -> OK, 5 ads
//   Lexus LX 570 2018             -> 2 ads, too few for an estimate
//   Daewoo Damas 2005             -> no ads

export interface MockListingSeed {
  externalId: string;
  title: string;
  make: string;
  model: string;
  year: number;
  mileageKm: number | null;
  price: number;
  currency: 'MNT' | 'USD';
  /** Age of the ad relative to the request time (`ctx.now`). */
  daysAgo: number;
}

type Ad = Pick<MockListingSeed, 'year' | 'mileageKm' | 'price' | 'daysAgo'> & Partial<Pick<MockListingSeed, 'currency' | 'model' | 'title'>>;

const ads = (prefix: string, make: string, model: string, items: Ad[]): MockListingSeed[] =>
  items.map((a, i) => ({
    externalId: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    title: a.title ?? `${make} ${a.model ?? model} ${a.year}`,
    make,
    model: a.model ?? model,
    year: a.year,
    mileageKm: a.mileageKm,
    price: a.price,
    currency: a.currency ?? 'MNT',
    daysAgo: a.daysAgo,
  }));

export const MOCK_UNEGUI_SEEDS: readonly MockListingSeed[] = [
  ...ads('UN-PRIUS', 'Toyota', 'Prius', [
    { year: 2012, mileageKm: 84_000, price: 25_800_000, daysAgo: 3 },
    { year: 2012, mileageKm: 120_000, price: 24_500_000, daysAgo: 10 },
    { year: 2013, mileageKm: 60_000, price: 27_900_000, daysAgo: 5 },
    { year: 2011, mileageKm: 150_000, price: 22_800_000, daysAgo: 21 },
    { year: 2012, mileageKm: null, price: 26_300_000, daysAgo: 14 },
    { year: 2012, mileageKm: 95_000, price: 9_900_000, daysAgo: 2, title: 'Toyota Prius 2012 urgent sale' }, // absurdly cheap
    { year: 2012, mileageKm: 100_000, price: 7_300, currency: 'USD', daysAgo: 8 },
    { year: 2012, mileageKm: 110_000, price: 25_000_000, daysAgo: 200 }, // stale
    { year: 2012, mileageKm: 80_000, price: 31_000_000, daysAgo: 6, model: 'Prius Alpha' }, // different model, same prefix
  ]),
  ...ads('UN-PRADO', 'Toyota', 'Land Cruiser Prado', [
    { year: 2015, mileageKm: 95_000, price: 88_000_000, daysAgo: 4 },
    { year: 2015, mileageKm: 120_000, price: 84_000_000, daysAgo: 9 },
    { year: 2016, mileageKm: 70_000, price: 94_500_000, daysAgo: 3 },
    { year: 2014, mileageKm: 140_000, price: 80_500_000, daysAgo: 18 },
    { year: 2015, mileageKm: null, price: 86_000_000, daysAgo: 12 },
  ]),
  ...ads('UN-SONATA', 'Hyundai', 'Sonata', [
    { year: 2017, mileageKm: 70_000, price: 31_500_000, daysAgo: 5 },
    { year: 2018, mileageKm: 50_000, price: 34_000_000, daysAgo: 11 },
    { year: 2016, mileageKm: 95_000, price: 28_500_000, daysAgo: 20 },
  ]),
  ...ads('UN-LX', 'Lexus', 'LX 570', [{ year: 2018, mileageKm: 60_000, price: 285_000_000, daysAgo: 7 }]),
  // Same make as the fixture vehicles but a model that must never match the queries above.
  ...ads('UN-LX450', 'Lexus', 'LX 450d', [{ year: 2018, mileageKm: 40_000, price: 310_000_000, daysAgo: 6 }]),
];

export const MOCK_ADS_B_SEEDS: readonly MockListingSeed[] = [
  ...ads('B-PRIUS', 'Toyota', 'Prius', [
    { year: 2012, mileageKm: 90_000, price: 26_000_000, daysAgo: 4 },
    { year: 2013, mileageKm: 70_000, price: 28_400_000, daysAgo: 12 },
    { year: 2012, mileageKm: 130_000, price: 24_200_000, daysAgo: 30 },
    { year: 2011, mileageKm: 140_000, price: 23_500_000, daysAgo: 40 },
    { year: 2012, mileageKm: 99_000, price: 61_000_000, daysAgo: 6, title: 'Toyota Prius 2012 like new' }, // absurdly expensive
    { year: 2012, mileageKm: 105_000, price: 25_500_000, daysAgo: 9 },
  ]),
  ...ads('B-PRADO', 'Toyota', 'Land Cruiser Prado', [
    { year: 2015, mileageKm: 110_000, price: 85_500_000, daysAgo: 7 },
    { year: 2016, mileageKm: 80_000, price: 93_000_000, daysAgo: 15 },
    { year: 2015, mileageKm: 100_000, price: 89_000_000, daysAgo: 25 },
  ]),
  ...ads('B-SONATA', 'Hyundai', 'Sonata', [
    { year: 2017, mileageKm: 85_000, price: 30_000_000, daysAgo: 8 },
    { year: 2017, mileageKm: null, price: 31_000_000, daysAgo: 16 },
  ]),
  ...ads('B-LX', 'Lexus', 'LX 570', [{ year: 2018, mileageKm: 75_000, price: 270_000_000, daysAgo: 13 }]),
];
