import { describe, it, expect } from 'vitest';
import { estimateMarketPrice, percentile } from './market-price';
import type { ComparableOutcome, MarketListingInput, MarketPriceParams, MarketPriceSubject } from './market-price';
// FR-14.2

const M = 1_000_000;
const asOf = new Date('2026-06-30T00:00:00Z');

const params: MarketPriceParams = {
  usdMnt: 3_400,
  minPriceMnt: 1_000_000,
  yearTolerance: 2,
  maxListingAgeDays: 90,
  yearAdjustmentRate: 0.05,
  mileageAdjustmentPer10kKm: 0.01,
  maxTotalAdjustment: 0.3,
  outlierIqrFactor: 1.5,
  outlierMinRelativeSpread: 0.05,
  outlierMinSample: 5,
  minComparables: 3,
  highConfidenceMinSample: 8,
  highConfidenceMaxCv: 0.1,
  mediumConfidenceMinSample: 4,
  mediumConfidenceMaxCv: 0.25,
  roundToMnt: 0,
};
const subject: MarketPriceSubject = { make: 'Toyota', model: 'Prius', year: 2015, mileageKm: 100_000 };

const listing = (o: Partial<MarketListingInput> = {}): MarketListingInput => ({
  id: 'L',
  make: 'Toyota',
  model: 'Prius',
  year: 2015,
  mileageKm: 100_000,
  price: 40 * M,
  currency: 'MNT',
  postedAt: '2026-06-20T00:00:00Z',
  ...o,
});
// Comparable listings that share the subject's year and mileage, so adjusted price == listed price.
const priced = (...prices: number[]): MarketListingInput[] => prices.map((price, i) => listing({ id: `L${i}`, price }));
const one = (o: Partial<MarketListingInput>, p: Partial<MarketPriceParams> = {}): ComparableOutcome =>
  estimateMarketPrice(subject, [listing(o)], { ...params, ...p }, asOf).outcomes[0];
const run = (listings: MarketListingInput[], p: Partial<MarketPriceParams> = {}, s: MarketPriceSubject = subject) =>
  estimateMarketPrice(s, listings, { ...params, ...p }, asOf);

describe('percentile', () => {
  it('returns NaN for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('returns the only element of a single-element sample for any p', () => {
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 0.25)).toBe(7);
    expect(percentile([7], 1)).toBe(7);
  });

  it('interpolates linearly between two elements', () => {
    expect(percentile([10, 20], 0)).toBe(10);
    expect(percentile([10, 20], 0.25)).toBe(12.5);
    expect(percentile([10, 20], 0.5)).toBe(15);
    expect(percentile([10, 20], 1)).toBe(20);
  });

  it('gives exact quartiles when (n - 1) * p is an integer', () => {
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(nine, 0.25)).toBe(3);
    expect(percentile(nine, 0.5)).toBe(5);
    expect(percentile(nine, 0.75)).toBe(7);
  });

  it('interpolates quartiles of an even-sized sample (R-7)', () => {
    const four = [1, 2, 3, 4];
    expect(percentile(four, 0.25)).toBe(1.75);
    expect(percentile(four, 0.5)).toBe(2.5);
    expect(percentile(four, 0.75)).toBe(3.25);
  });
});

describe('estimateMarketPrice: exclusions', () => {
  it('excludes a non-positive or non-finite price as INVALID_PRICE', () => {
    for (const price of [0, -5, NaN, Infinity, -Infinity]) {
      expect(one({ price })).toEqual({
        id: 'L',
        priceMnt: null,
        adjustedPriceMnt: null,
        included: false,
        exclusionReason: 'INVALID_PRICE',
      });
    }
  });

  it('excludes an unknown or differently-cased currency as UNSUPPORTED_CURRENCY', () => {
    for (const currency of ['EUR', 'mnt', 'usd', '']) {
      expect(one({ currency })).toMatchObject({ priceMnt: null, adjustedPriceMnt: null, included: false, exclusionReason: 'UNSUPPORTED_CURRENCY' });
    }
  });

  it('excludes USD listings when usdMnt is not positive', () => {
    for (const usdMnt of [0, -3_400]) {
      expect(one({ currency: 'USD', price: 10_000 }, { usdMnt })).toMatchObject({
        priceMnt: null,
        included: false,
        exclusionReason: 'UNSUPPORTED_CURRENCY',
      });
    }
  });

  it('excludes a USD price whose conversion overflows', () => {
    expect(one({ currency: 'USD', price: 1e306 }, { usdMnt: 3_500 })).toEqual({
      id: 'L',
      priceMnt: null,
      adjustedPriceMnt: null,
      included: false,
      exclusionReason: 'INVALID_PRICE',
    });
  });

  it('excludes a placeholder price below minPriceMnt as INVALID_PRICE and keeps the MNT price', () => {
    expect(one({ price: 1 })).toEqual({ id: 'L', priceMnt: 1, adjustedPriceMnt: null, included: false, exclusionReason: 'INVALID_PRICE' });
    expect(one({ price: 999_999 }).exclusionReason).toBe('INVALID_PRICE');
    expect(one({ price: 1_000_000 }).included).toBe(true); // the limit itself is a valid price
    expect(one({ currency: 'USD', price: 100 }).exclusionReason).toBe('INVALID_PRICE'); // 340,000 MNT after conversion
  });

  it('converts USD to MNT with usdMnt', () => {
    expect(one({ currency: 'USD', price: 10_000 })).toEqual({
      id: 'L',
      priceMnt: 34 * M,
      adjustedPriceMnt: 34 * M,
      included: true,
      exclusionReason: null,
    });
  });

  it('excludes a different make or a different model as MODEL_MISMATCH and keeps the MNT price', () => {
    expect(one({ make: 'Honda' })).toEqual({
      id: 'L',
      priceMnt: 40 * M,
      adjustedPriceMnt: null,
      included: false,
      exclusionReason: 'MODEL_MISMATCH',
    });
    expect(one({ model: 'Aqua' })).toMatchObject({ priceMnt: 40 * M, exclusionReason: 'MODEL_MISMATCH' });
    expect(one({ model: 'Prius Alpha' })).toMatchObject({ exclusionReason: 'MODEL_MISMATCH' });
    expect(one({ model: 'Pri' })).toMatchObject({ exclusionReason: 'MODEL_MISMATCH' });
  });

  it('keeps "+" and a decimal point significant when matching models', () => {
    expect(one({ model: 'Prius+' })).toMatchObject({ exclusionReason: 'MODEL_MISMATCH' });
    const plus = { ...subject, model: 'Prius+' };
    expect(estimateMarketPrice(plus, [listing({ model: 'prius +' })], params, asOf).outcomes[0].included).toBe(true);
    const vitz = { ...subject, model: 'Vitz 1.0' };
    expect(estimateMarketPrice(vitz, [listing({ model: 'Vitz 10' })], params, asOf).outcomes[0].exclusionReason).toBe('MODEL_MISMATCH');
    expect(estimateMarketPrice(vitz, [listing({ model: 'vitz 1.0' })], params, asOf).outcomes[0].included).toBe(true);
  });

  it('never matches an empty make or model', () => {
    const blank = { ...subject, make: '', model: ' - ' };
    expect(estimateMarketPrice(blank, [listing({ make: '', model: '-' })], params, asOf).outcomes[0].exclusionReason).toBe('MODEL_MISMATCH');
  });

  it('matches make and model after case, punctuation, whitespace and full-width normalisation', () => {
    expect(one({ make: ' TOYOTA ', model: 'ＰＲＩＵＳ' }).included).toBe(true);
    expect(one({ model: 'pri-us' }).included).toBe(true);

    const prado = { ...subject, model: 'Land Cruiser Prado' };
    const out = estimateMarketPrice(prado, [listing({ model: 'land-cruiser  prado' }), listing({ model: 'Land Cruiser' })], params, asOf).outcomes;
    expect(out.map((o) => o.exclusionReason)).toEqual([null, 'MODEL_MISMATCH']);

    const cyrillic = { ...subject, make: 'Тойота', model: 'Приус' };
    const cyr = estimateMarketPrice(cyrillic, [listing({ make: 'ТОЙОТА', model: 'приус' })], params, asOf).outcomes;
    expect(cyr[0].included).toBe(true);
  });

  it('keeps listings within yearTolerance and excludes the rest as YEAR_OUT_OF_RANGE', () => {
    expect(one({ year: 2017 }).included).toBe(true);
    expect(one({ year: 2013 }).included).toBe(true);
    expect(one({ year: 2018 })).toMatchObject({ priceMnt: 40 * M, adjustedPriceMnt: null, exclusionReason: 'YEAR_OUT_OF_RANGE' });
    expect(one({ year: 2012 })).toMatchObject({ included: false, exclusionReason: 'YEAR_OUT_OF_RANGE' });
  });

  it('treats a listing as stale only when it is older than maxListingAgeDays', () => {
    expect(one({ postedAt: '2026-04-01T00:00:00Z' }).included).toBe(true); // exactly 90 days
    expect(one({ postedAt: '2026-03-31T23:59:00Z' })).toMatchObject({
      priceMnt: 40 * M,
      adjustedPriceMnt: null,
      included: false,
      exclusionReason: 'STALE_LISTING',
    });
    expect(one({ postedAt: '2026-03-31T00:00:00Z' }).exclusionReason).toBe('STALE_LISTING');
  });

  it('treats an unparseable posting date as stale and accepts a future one', () => {
    expect(one({ postedAt: 'yesterday-ish' }).exclusionReason).toBe('STALE_LISTING');
    expect(one({ postedAt: '' }).exclusionReason).toBe('STALE_LISTING');
    expect(one({ postedAt: '2026-07-05T00:00:00Z' }).included).toBe(true);
  });

  it('understands ISO 8601 offsets in the +HH:MM, +HHMM and Z forms in any letter case', () => {
    expect(one({ postedAt: '2026-04-01T09:00:00+0900' }).included).toBe(true); // 00:00Z, exactly 90 days
    expect(one({ postedAt: '2026-04-01T00:00:00z' }).included).toBe(true);
    expect(one({ postedAt: '2026-04-01t00:00:00Z' }).included).toBe(true);
    expect(one({ postedAt: '  2026-04-01T00:00:00Z \n' }).included).toBe(true);
    expect(one({ postedAt: '2026-04-01T09:00:00+0900' }).adjustedPriceMnt).toBe(40 * M);
  });

  it('treats every non-ISO date shape as unparseable (stale), because Date.parse on them depends on the host time zone', () => {
    for (const postedAt of ['2026/07/30', 'Jul 30, 2026 00:00', 'Thu, 30 Jul 2026 00:00:00', '2026-7-30', '20260630', '+002026-06-30T00:00:00', '2026-06-30T25:00:00', '2026-13-01']) {
      expect(one({ postedAt }).exclusionReason, postedAt).toBe('STALE_LISTING');
    }
  });

  it('gives the same answer in every host time zone', () => {
    const shapes = ['2026-04-01T00:00:00', '2026-04-01 00:00', '2026-04-01', '2026/07/30', '2026-04-01T00:00:00+09:00', 'Jul 30, 2026'];
    const results = ['Asia/Ulaanbaatar', 'America/Los_Angeles', 'UTC'].map((tz) => {
      const saved = process.env.TZ;
      process.env.TZ = tz;
      try {
        return shapes.map((postedAt) => one({ postedAt }).exclusionReason);
      } finally {
        if (saved === undefined) delete process.env.TZ;
        else process.env.TZ = saved;
      }
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('reads a posting time without an offset as UTC, whatever the host time zone', () => {
    expect(one({ postedAt: '2026-04-01T00:00:00' }).included).toBe(true); // exactly 90 days, like the Z form
    expect(one({ postedAt: '2026-04-01 00:00' }).included).toBe(true);
    expect(one({ postedAt: '2026-04-01T00:00:00.000' }).included).toBe(true);
    expect(one({ postedAt: '2026-03-31T23:59:00' }).exclusionReason).toBe('STALE_LISTING');
    expect(one({ postedAt: '2026-04-01' }).included).toBe(true); // date-only is UTC by definition
    expect(one({ postedAt: '2026-04-01T09:00:00+09:00' }).included).toBe(true); // explicit offsets are honoured: 00:00Z
    expect(one({ postedAt: '2026-04-01T00:00:00-01:00' }).included).toBe(true); // 01:00Z
    expect(one({ postedAt: '2026-04-01T00:00:00+01:00' }).exclusionReason).toBe('STALE_LISTING'); // 23:00Z on Mar 31
  });

  it('fails closed on a NaN or missing listing year', () => {
    expect(one({ year: NaN }).exclusionReason).toBe('YEAR_OUT_OF_RANGE');
    expect(one({ year: undefined as unknown as number }).exclusionReason).toBe('YEAR_OUT_OF_RANGE');
  });

  it('reports the first failing check in the documented order', () => {
    const everythingWrong = { make: 'Honda', year: 2000, postedAt: '2020-01-01T00:00:00Z' };
    expect(one({ ...everythingWrong, price: 0, currency: 'EUR' }).exclusionReason).toBe('INVALID_PRICE');
    expect(one({ ...everythingWrong, currency: 'EUR' }).exclusionReason).toBe('UNSUPPORTED_CURRENCY');
    expect(one(everythingWrong).exclusionReason).toBe('MODEL_MISMATCH');
    expect(one({ year: 2000, postedAt: '2020-01-01T00:00:00Z' }).exclusionReason).toBe('YEAR_OUT_OF_RANGE');
    expect(one({ postedAt: '2020-01-01T00:00:00Z' }).exclusionReason).toBe('STALE_LISTING');
  });
});

describe('estimateMarketPrice: price adjustment', () => {
  const adjusted = (o: Partial<MarketListingInput>, p: Partial<MarketPriceParams> = {}, s: MarketPriceSubject = subject) =>
    run([listing(o)], p, s).outcomes[0].adjustedPriceMnt;

  it('leaves a listing of the same year and mileage unchanged', () => {
    expect(adjusted({})).toBe(40 * M);
  });

  it('adds yearAdjustmentRate per year the subject is newer and subtracts it when older', () => {
    expect(adjusted({ year: 2013 })).toBeCloseTo(44 * M, 3); // 1 + 0.05 * 2
    expect(adjusted({ year: 2017 })).toBeCloseTo(36 * M, 3); // 1 - 0.05 * 2
    expect(adjusted({ year: 2014 })).toBeCloseTo(42 * M, 3); // 1 + 0.05 * 1
  });

  it('adds mileageAdjustmentPer10kKm per 10,000 km the subject has fewer km than the listing', () => {
    expect(adjusted({ mileageKm: 150_000 })).toBeCloseTo(42 * M, 3); // 1 + 0.01 * 5
    expect(adjusted({ mileageKm: 40_000 })).toBeCloseTo(37.6 * M, 3); // 1 - 0.01 * 6
  });

  it('combines the year and mileage terms', () => {
    expect(adjusted({ year: 2013, mileageKm: 150_000 })).toBeCloseTo(46 * M, 3); // 1 + 0.10 + 0.05
    expect(adjusted({ year: 2017, mileageKm: 40_000 })).toBeCloseTo(33.6 * M, 3); // 1 - 0.10 - 0.06
    expect(adjusted({ year: 2013, mileageKm: 40_000 })).toBeCloseTo(41.6 * M, 3); // 1 + 0.10 - 0.06
  });

  it('applies the adjustment to the converted USD price', () => {
    expect(adjusted({ currency: 'USD', price: 10_000, year: 2013 })).toBeCloseTo(37.4 * M, 3); // 34M * 1.10
  });

  it('skips the mileage term when either mileage is unknown', () => {
    expect(adjusted({ mileageKm: null })).toBe(40 * M);
    expect(adjusted({ mileageKm: 150_000 }, {}, { ...subject, mileageKm: null })).toBe(40 * M);
    expect(adjusted({ year: 2013, mileageKm: null }, {}, { ...subject, mileageKm: null })).toBeCloseTo(44 * M, 3);
  });

  it('rounds prices and adjusted prices to whole MNT', () => {
    const o = run([listing({ year: 2014, price: 33_333_333, currency: 'MNT' }), listing({ currency: 'USD', price: 9_999.99 })]).outcomes;
    expect(o[0].adjustedPriceMnt).toBe(35_000_000); // 33,333,333 * 1.05 = 34,999,999.65
    expect(o[1].priceMnt).toBe(33_999_966); // 9,999.99 * 3,400 = 33,999,966
    const fractional = run([listing({ price: 12_345_678.4 })]).outcomes[0];
    expect(fractional.priceMnt).toBe(12_345_678);
    expect(fractional.adjustedPriceMnt).toBe(12_345_678);
  });

  it('ignores a non-finite mileage like an unknown one', () => {
    expect(adjusted({ mileageKm: NaN })).toBe(40 * M);
    expect(adjusted({ mileageKm: Infinity })).toBe(40 * M);
    expect(adjusted({}, {}, { ...subject, mileageKm: NaN })).toBe(40 * M);
  });

  it('clamps the total factor to 1 + maxTotalAdjustment', () => {
    expect(adjusted({ year: 2013 }, { yearAdjustmentRate: 0.2 })).toBeCloseTo(52 * M, 3); // 1.4 -> 1.3
    expect(adjusted({ mileageKm: 400_000 }, { mileageAdjustmentPer10kKm: 0.1 })).toBeCloseTo(52 * M, 3); // 4 -> 1.3
  });

  it('clamps the total factor to 1 - maxTotalAdjustment', () => {
    expect(adjusted({ year: 2017 }, { yearAdjustmentRate: 0.2 })).toBeCloseTo(28 * M, 3); // 0.6 -> 0.7
    expect(adjusted({ mileageKm: 0 }, { mileageAdjustmentPer10kKm: 0.1 })).toBeCloseTo(28 * M, 3); // 0 -> 0.7
  });

  it('leaves a factor exactly at the limit unchanged', () => {
    expect(adjusted({ year: 2013 }, { yearAdjustmentRate: 0.1, maxTotalAdjustment: 0.2 })).toBeCloseTo(48 * M, 3); // 1.2 == limit
  });
});

describe('estimateMarketPrice: outlier trimming', () => {
  it('trims a high outlier but keeps its prices on the outcome', () => {
    const { outcomes, estimate } = run(priced(40 * M, 41 * M, 42 * M, 43 * M, 44 * M, 100 * M));
    // sorted n=6: Q1 = 41.25M, Q3 = 43.75M, IQR = 2.5M -> fences [37.5M, 47.5M]
    expect(outcomes.map((o) => o.included)).toEqual([true, true, true, true, true, false]);
    expect(outcomes[5]).toEqual({ id: 'L5', priceMnt: 100 * M, adjustedPriceMnt: 100 * M, included: false, exclusionReason: 'OUTLIER' });
    expect(estimate).toEqual({
      marketValue: 42 * M,
      lowValue: 41 * M,
      highValue: 43 * M,
      meanValue: 42 * M,
      sampleSize: 5,
      confidence: 'MEDIUM',
    });
  });

  it('widens the fences to outlierMinRelativeSpread of the median when the quartiles (almost) coincide', () => {
    // Q1 = Q3 = 40M, IQR = 0. Without a floor the 40.4M ad (1% away) would be an outlier; with 5% of the median
    // the fences are 40M +- 1.5 * 2M, so 40.4M stays and 100M still goes.
    const similar = priced(...Array(7).fill(40 * M), 40.4 * M, 100 * M); // n = 9, so Q3 is the 7th value exactly
    const same = Array(7).fill(null);
    expect(run(similar, { outlierMinRelativeSpread: 0 }).outcomes.map((o) => o.exclusionReason)).toEqual([...same, 'OUTLIER', 'OUTLIER']);
    expect(run(similar).outcomes.map((o) => o.exclusionReason)).toEqual([...same, null, 'OUTLIER']);
  });

  it('trims a low outlier', () => {
    const { outcomes } = run(priced(10 * M, 40 * M, 41 * M, 42 * M, 43 * M, 44 * M));
    // Q1 = 40.25M, Q3 = 42.75M -> fences [36.5M, 46.5M]
    expect(outcomes.map((o) => o.exclusionReason)).toEqual(['OUTLIER', null, null, null, null, null]);
  });

  it('trims both tails in the same pass', () => {
    const { outcomes } = run(priced(10 * M, 40 * M, 41 * M, 42 * M, 43 * M, 44 * M, 100 * M));
    // n=7: Q1 = 40.5M, Q3 = 43.5M -> fences [36M, 48M]
    expect(outcomes.map((o) => o.exclusionReason)).toEqual(['OUTLIER', null, null, null, null, null, 'OUTLIER']);
  });

  it('keeps a value that sits exactly on a fence', () => {
    // sorted [38, 41, 42, 43, 46]M: Q1 = 41M, Q3 = 43M, IQR = 2M, k = 1.5 -> fences [38M, 46M]
    const { outcomes } = run(priced(38 * M, 41 * M, 42 * M, 43 * M, 46 * M));
    expect(outcomes.every((o) => o.included)).toBe(true);
  });

  it('computes the fences once, not iteratively', () => {
    // Pass 1 (n=7): Q1 = 11.5M, Q3 = 17M, IQR = 5.5M -> fences [3.25M, 25.25M]: only 100M goes.
    // A second pass over the remaining six would also drop 20M (upper fence 17.5M); it must stay.
    const { outcomes } = run(priced(10 * M, 11 * M, 12 * M, 13 * M, 14 * M, 20 * M, 100 * M), { minComparables: 3 });
    expect(outcomes.map((o) => o.exclusionReason)).toEqual([null, null, null, null, null, null, 'OUTLIER']);
  });

  it('is not applied below outlierMinSample', () => {
    const four = run(priced(40 * M, 41 * M, 42 * M, 500 * M));
    expect(four.outcomes.every((o) => o.included)).toBe(true);
    const five = run(priced(40 * M, 41 * M, 42 * M, 43 * M, 500 * M));
    expect(five.outcomes.map((o) => o.exclusionReason)).toEqual([null, null, null, null, 'OUTLIER']);
  });

  it('counts only listings that passed the filters towards outlierMinSample', () => {
    const listings = [...priced(40 * M, 41 * M, 42 * M, 500 * M), listing({ id: 'X', make: 'Honda' })];
    const { outcomes } = run(listings);
    expect(outcomes[3].included).toBe(true);
    expect(outcomes[4].exclusionReason).toBe('MODEL_MISMATCH');
  });

  it('judges the adjusted price, not the listed price', () => {
    // Listed prices are identical, but the 2013 car is adjusted +10% to 44M while the others stay at 40M.
    const listings = [...priced(40 * M, 40 * M, 40 * M, 40 * M), listing({ id: 'old', year: 2013 })];
    const { outcomes } = run(listings);
    expect(outcomes[4].exclusionReason).toBe('OUTLIER');
    expect(outcomes[4].priceMnt).toBe(40 * M);
    expect(outcomes[4].adjustedPriceMnt).toBeCloseTo(44 * M, 3);
  });

  it('does not let a zero outlierMinSample break an empty input', () => {
    expect(run([], { outlierMinSample: 0 })).toEqual({ estimate: null, outcomes: [] });
  });
});

describe('estimateMarketPrice: estimate', () => {
  it('computes median, quartiles and mean of the included adjusted prices', () => {
    // 40.13M, 41.27M, 43.48M: median 41.27M, Q1 = 40.7M, Q3 = 42.375M, mean = 41,626,666.67
    const { estimate } = run(priced(43_480_000, 40_130_000, 41_270_000));
    expect(estimate).toEqual({
      marketValue: 41_270_000,
      lowValue: 40_700_000,
      highValue: 42_375_000,
      meanValue: 41_626_667,
      sampleSize: 3,
      confidence: 'LOW',
    });
  });

  it('works end to end on year- and mileage-adjusted prices', () => {
    const listings = [
      listing({ id: 'a' }), // 40M
      listing({ id: 'b', year: 2013, mileageKm: 150_000 }), // 40M * 1.15 = 46M
      listing({ id: 'c', year: 2017, mileageKm: 40_000 }), // 40M * 0.84 = 33.6M
    ];
    const { estimate, outcomes } = run(listings);
    expect(outcomes.map((o) => o.included)).toEqual([true, true, true]);
    expect(estimate).toMatchObject({
      marketValue: 40 * M,
      lowValue: 36_800_000, // 33.6M + 0.5 * (40M - 33.6M)
      highValue: 43 * M, // 40M + 0.5 * (46M - 40M)
      meanValue: 39_866_667, // 119.6M / 3
      sampleSize: 3,
    });
  });

  it('counts only included comparables in the sample', () => {
    const listings = [...priced(40 * M, 41 * M, 42 * M), listing({ id: 'X', price: 0 }), listing({ id: 'Y', year: 1990 })];
    const { estimate, outcomes } = run(listings);
    expect(estimate?.sampleSize).toBe(3);
    expect(outcomes.map((o) => o.exclusionReason)).toEqual([null, null, null, 'INVALID_PRICE', 'YEAR_OUT_OF_RANGE']);
  });

  it('rounds all four values to roundToMnt', () => {
    const { estimate } = run(priced(43_480_000, 40_130_000, 41_270_000), { roundToMnt: 100_000 });
    expect(estimate).toMatchObject({
      marketValue: 41_300_000, // 41,270,000
      lowValue: 40_700_000,
      highValue: 42_400_000, // 42,375,000 -> 423.75 steps
      meanValue: 41_600_000, // 41,626,667 -> 416.27 steps
    });
  });

  it('rounds to whole MNT when roundToMnt is zero or negative', () => {
    for (const roundToMnt of [0, -50_000]) {
      const { estimate } = run(priced(43_480_000, 40_130_000, 41_270_000), { roundToMnt });
      expect(estimate).toMatchObject({ marketValue: 41_270_000, lowValue: 40_700_000, highValue: 42_375_000, meanValue: 41_626_667 });
    }
  });

  it('returns a null estimate with fewer included comparables than minComparables', () => {
    const two = run(priced(40 * M, 41 * M));
    expect(two.estimate).toBeNull();
    expect(two.outcomes).toHaveLength(2);
    expect(two.outcomes.every((o) => o.included)).toBe(true);
    expect(run(priced(40 * M, 41 * M, 42 * M)).estimate).not.toBeNull();
  });

  it('needs at least one comparable even when minComparables is zero or negative', () => {
    expect(run([], { minComparables: 0 }).estimate).toBeNull();
    expect(run([listing({ price: 0 })], { minComparables: -2 }).estimate).toBeNull();
    expect(run(priced(40 * M), { minComparables: 0 }).estimate).toMatchObject({ marketValue: 40 * M, sampleSize: 1 });
  });

  it('returns no estimate and no outcomes for an empty listing set', () => {
    expect(run([])).toEqual({ estimate: null, outcomes: [] });
  });

  it('returns a null estimate when every listing is excluded', () => {
    const { estimate, outcomes } = run([listing({ price: -1 }), listing({ currency: 'EUR' })], { minComparables: 1 });
    expect(estimate).toBeNull();
    expect(outcomes.map((o) => o.exclusionReason)).toEqual(['INVALID_PRICE', 'UNSUPPORTED_CURRENCY']);
  });

  it('never lets a non-positive adjusted price into the statistics', () => {
    // 2018 vs 2015 with a 50% per-year rate and no cap: factor 1 - 1.5 = -0.5 -> clamped to 0 -> adjusted price 0
    const p = { yearTolerance: 3, yearAdjustmentRate: 0.5, maxTotalAdjustment: 1, minComparables: 1 };
    const { estimate, outcomes } = run([listing({ year: 2018 })], p);
    expect(outcomes[0]).toEqual({ id: 'L', priceMnt: 40 * M, adjustedPriceMnt: null, included: false, exclusionReason: 'INVALID_PRICE' });
    expect(estimate).toBeNull();
  });
});

describe('estimateMarketPrice: confidence', () => {
  // [90, 100, 110]M: mean 100M, sample std dev 10M, so cv = 0.1 exactly. [80, 100, 120]M: cv = 0.2 exactly.
  const A = priced(90 * M, 100 * M, 110 * M);
  const B = priced(80 * M, 100 * M, 120 * M);

  it.each([
    ['HIGH when n and cv are exactly on the HIGH thresholds', A, [3, 0.1, 4, 0.25], 'HIGH'],
    ['MEDIUM when n is one short of the HIGH minimum', A, [4, 0.1, 3, 0.1], 'MEDIUM'],
    ['MEDIUM when cv is just above the HIGH maximum', A, [3, 0.0999, 3, 0.1], 'MEDIUM'],
    ['LOW when n is one short of the MEDIUM minimum', A, [4, 0.1, 4, 0.25], 'LOW'],
    ['LOW when cv is just above the MEDIUM maximum', A, [4, 0.05, 3, 0.0999], 'LOW'],
    ['MEDIUM at exactly the MEDIUM thresholds', B, [3, 0.1, 3, 0.2], 'MEDIUM'],
    ['LOW when cv is just above the MEDIUM maximum (wider spread)', B, [3, 0.1, 3, 0.19], 'LOW'],
    ['HIGH wins when HIGH and MEDIUM both hold', A, [3, 0.1, 3, 0.1], 'HIGH'],
  ] as const)('%s', (_name, listings, [hn, hcv, mn, mcv], expected) => {
    const { estimate } = run([...listings], {
      highConfidenceMinSample: hn,
      highConfidenceMaxCv: hcv,
      mediumConfidenceMinSample: mn,
      mediumConfidenceMaxCv: mcv,
    });
    expect(estimate?.confidence).toBe(expected);
  });

  it('reaches HIGH with a tight sample of the default size', () => {
    // sorted [38, 39, 40, 40, 41, 41, 42, 43]M: fences [37.5M, 43.5M] keep everything, cv ~ 0.04
    const { estimate } = run(priced(41 * M, 38 * M, 40 * M, 43 * M, 39 * M, 42 * M, 40 * M, 41 * M));
    expect(estimate).toMatchObject({ marketValue: 40.5 * M, meanValue: 40.5 * M, sampleSize: 8, confidence: 'HIGH' });
  });

  it('uses a std dev of zero for a single comparable', () => {
    const { estimate } = run(priced(40 * M), { minComparables: 1, highConfidenceMinSample: 1, highConfidenceMaxCv: 0 });
    expect(estimate).toEqual({ marketValue: 40 * M, lowValue: 40 * M, highValue: 40 * M, meanValue: 40 * M, sampleSize: 1, confidence: 'HIGH' });
  });
});

describe('estimateMarketPrice: contract', () => {
  it('returns one outcome per listing in input order', () => {
    const listings = [
      listing({ id: 'c', price: 42 * M }),
      listing({ id: 'a', price: 0 }),
      listing({ id: 'b', price: 40 * M }),
      listing({ id: 'd', model: 'Aqua' }),
      listing({ id: 'e', price: 41 * M }),
    ];
    const { outcomes } = run(listings);
    expect(outcomes.map((o) => o.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(outcomes.map((o) => o.exclusionReason)).toEqual([null, 'INVALID_PRICE', null, 'MODEL_MISMATCH', null]);
  });

  it('does not mutate its inputs', () => {
    const deepFreeze = <T extends object>(o: T): T => {
      Object.values(o).forEach((v) => typeof v === 'object' && v !== null && deepFreeze(v));
      return Object.freeze(o);
    };
    const listings = deepFreeze([...priced(100 * M, 40 * M, 41 * M, 42 * M, 43 * M, 44 * M), listing({ id: 'bad', price: 0 })]);
    const frozenSubject = deepFreeze({ ...subject });
    const frozenParams = deepFreeze({ ...params });
    const before = structuredClone({ listings, subject, params });
    const date = new Date(asOf.getTime());

    const { outcomes } = estimateMarketPrice(frozenSubject, listings, frozenParams, date);

    expect(outcomes.some((o) => o.exclusionReason === 'OUTLIER')).toBe(true);
    expect({ listings, subject: frozenSubject, params: frozenParams }).toEqual(before);
    expect(date.getTime()).toBe(asOf.getTime());
  });

  it('is deterministic for the same inputs', () => {
    const listings = priced(40 * M, 41 * M, 42 * M, 43 * M, 44 * M, 100 * M);
    expect(run(listings)).toEqual(run(listings));
  });
});

describe('estimateMarketPrice: invalid parameters and clock', () => {
  const keys = Object.keys(params) as (keyof MarketPriceParams)[];

  it.each([NaN, Infinity, -Infinity])('throws a RangeError naming every parameter that is %s', (bad) => {
    for (const key of keys) {
      expect(() => run(priced(40 * M), { [key]: bad })).toThrow(new RangeError(`Invalid market price parameters: ${key}`));
    }
    expect(() => run(priced(40 * M), { usdMnt: bad, roundToMnt: bad })).toThrow('Invalid market price parameters: usdMnt, roundToMnt');
  });

  it('throws when a parameter is missing, instead of switching its check off', () => {
    const { outlierMinRelativeSpread: _omitted, ...incomplete } = params;
    expect(() => estimateMarketPrice(subject, priced(40 * M), incomplete as MarketPriceParams, asOf)).toThrow(/outlierMinRelativeSpread/);
    expect(() => estimateMarketPrice(subject, [], { ...params, minComparables: undefined } as unknown as MarketPriceParams, asOf)).toThrow(/minComparables/);
  });

  it('throws on an invalid asOf date', () => {
    expect(() => estimateMarketPrice(subject, priced(40 * M), params, new Date(NaN))).toThrow(new RangeError('asOf is not a valid date'));
  });

  it('accepts zero and negative values where they are meaningful', () => {
    expect(() => run(priced(40 * M), { usdMnt: 0, minPriceMnt: 0, roundToMnt: 0, minComparables: 0, yearAdjustmentRate: 0 })).not.toThrow();
  });
});

describe('estimateMarketPrice: coarse rounding', () => {
  it('returns no estimate rather than a zero value when rounding swallows a cheap sample', () => {
    // minPriceMnt 0 lets 1-4 MNT placeholders through; roundToMnt 10,000 would round them to 0.
    const { estimate, outcomes } = run(priced(1, 1, 1), { minPriceMnt: 0, roundToMnt: 10_000 });
    expect(estimate).toBeNull();
    expect(outcomes.every((o) => o.included)).toBe(true);
    expect(run(priced(1, 1, 25 * M), { minPriceMnt: 0, roundToMnt: 10_000 }).estimate).toBeNull(); // median and P25 are 0
  });

  it('keeps an estimate whose low value is positive after rounding', () => {
    expect(run(priced(30_000, 30_000, 30_000), { minPriceMnt: 0, roundToMnt: 10_000 }).estimate).toMatchObject({ marketValue: 30_000, lowValue: 30_000 });
  });
});
