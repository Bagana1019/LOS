import type { ComparableExclusionReason, ValuationConfidence } from '@los/contracts';
// FR-14.2 — market-comparables price suggestion for vehicle collateral. Pure: no I/O, and the clock is passed in as `asOf`.

export interface MarketPriceParams {
  usdMnt: number; // MNT per 1 USD; a value <= 0 excludes USD listings
  minPriceMnt: number; // an ad priced below this is a placeholder ("negotiable" typed as 1) and excluded as INVALID_PRICE
  yearTolerance: number; // keep listings with |listing.year - subject.year| <= this
  maxListingAgeDays: number; // older listings are stale
  yearAdjustmentRate: number; // price change per year of age difference, 0.05 = 5%
  mileageAdjustmentPer10kKm: number; // price change per 10,000 km difference, 0.01 = 1%
  maxTotalAdjustment: number; // total adjustment factor is clamped to [1 - x, 1 + x]
  outlierIqrFactor: number; // Tukey fence multiplier k
  outlierMinRelativeSpread: number; // the IQR used for the fences is at least this share of the median, so near-identical ads do not flag each other
  outlierMinSample: number; // outlier trimming only when at least this many comparables passed the filters
  minComparables: number; // fewer included comparables -> estimate is null
  highConfidenceMinSample: number;
  highConfidenceMaxCv: number;
  mediumConfidenceMinSample: number;
  mediumConfidenceMaxCv: number;
  roundToMnt: number; // rounding step of the estimate; <= 0 disables rounding
}

export interface MarketPriceSubject {
  make: string;
  model: string;
  year: number;
  mileageKm: number | null;
}

export interface MarketListingInput {
  id: string;
  make: string;
  model: string;
  year: number;
  mileageKm: number | null;
  price: number;
  currency: string;
  postedAt: string;
}

export interface ComparableOutcome {
  id: string;
  priceMnt: number | null;
  adjustedPriceMnt: number | null;
  included: boolean;
  exclusionReason: ComparableExclusionReason | null;
}

export interface MarketPriceEstimate {
  marketValue: number;
  lowValue: number;
  highValue: number;
  meanValue: number;
  sampleSize: number;
  confidence: ValuationConfidence;
}

const MS_PER_DAY = 86_400_000;
const KM_PER_MILEAGE_STEP = 10_000;
const Q1 = 0.25;
const MEDIAN = 0.5;
const Q3 = 0.75;

type Screened =
  | { reason: ComparableExclusionReason; priceMnt: number | null }
  | { reason: null; priceMnt: number; adjusted: number };

// Exact match after normalisation: "Land Cruiser Prado" == "land-cruiser prado" but "Prius Alpha" != "Prius".
// '+' and a decimal point are significant ("Prius+", "Vitz 1.0"), everything else that is not a letter or digit is dropped.
const normalise = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/(?<=\d)\.(?=\d)/g, 'dot')
    .replace(/[^\p{L}\p{N}]+/gu, '');

// Only ISO 8601 is understood, and a timestamp without an offset is read as UTC: Date.parse on anything else would depend on the
// host time zone. NaN (-> STALE_LISTING) for every other shape.
const ISO_8601 = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;
function parsePostedAt(raw: string): number {
  const m = ISO_8601.exec(raw.trim().toUpperCase());
  if (!m) return NaN;
  const [, date, time, zone = 'Z'] = m;
  if (time === undefined) return Date.parse(date);
  return Date.parse(`${date}T${time}${zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone}`);
}
const wholeMnt = Math.round;

// Every numeric parameter must be a finite number: NaN or a missing key would silently switch a check off.
const PARAM_KEYS = {
  usdMnt: true,
  minPriceMnt: true,
  yearTolerance: true,
  maxListingAgeDays: true,
  yearAdjustmentRate: true,
  mileageAdjustmentPer10kKm: true,
  maxTotalAdjustment: true,
  outlierIqrFactor: true,
  outlierMinRelativeSpread: true,
  outlierMinSample: true,
  minComparables: true,
  highConfidenceMinSample: true,
  highConfidenceMaxCv: true,
  mediumConfidenceMinSample: true,
  mediumConfidenceMaxCv: true,
  roundToMnt: true,
} satisfies Record<keyof MarketPriceParams, true>;

function assertValidInputs(params: MarketPriceParams, asOf: Date): void {
  const bad = Object.keys(PARAM_KEYS).filter((k) => !Number.isFinite(params[k as keyof MarketPriceParams]));
  if (bad.length > 0) throw new RangeError(`Invalid market price parameters: ${bad.join(', ')}`);
  if (Number.isNaN(asOf.getTime())) throw new RangeError('asOf is not a valid date');
}
const byValue = (a: number, b: number): number => a - b;

/** Linear interpolation between closest ranks (R-7); `p` in [0, 1]. NaN for an empty sample. */
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return NaN;
  const pos = (sortedAscending.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (pos - lo);
}

function screen(subject: MarketPriceSubject, l: MarketListingInput, params: MarketPriceParams, asOf: Date): Screened {
  if (!Number.isFinite(l.price) || l.price <= 0) return { reason: 'INVALID_PRICE', priceMnt: null };
  let priceMnt: number;
  if (l.currency === 'MNT') priceMnt = l.price;
  else if (l.currency === 'USD' && params.usdMnt > 0) priceMnt = l.price * params.usdMnt;
  else return { reason: 'UNSUPPORTED_CURRENCY', priceMnt: null };
  if (!Number.isFinite(priceMnt)) return { reason: 'INVALID_PRICE', priceMnt: null }; // USD conversion overflowed
  priceMnt = wholeMnt(priceMnt);
  if (priceMnt < params.minPriceMnt) return { reason: 'INVALID_PRICE', priceMnt };

  const [make, model] = [normalise(subject.make), normalise(subject.model)];
  if (make === '' || model === '' || normalise(l.make) !== make || normalise(l.model) !== model) return { reason: 'MODEL_MISMATCH', priceMnt };
  // Written so that a NaN year fails closed.
  if (!(Math.abs(l.year - subject.year) <= params.yearTolerance)) return { reason: 'YEAR_OUT_OF_RANGE', priceMnt };
  // An unparseable date is stale too: freshness cannot be verified. Listings dated in the future are accepted.
  const posted = parsePostedAt(l.postedAt);
  if (Number.isNaN(posted) || (asOf.getTime() - posted) / MS_PER_DAY > params.maxListingAgeDays) {
    return { reason: 'STALE_LISTING', priceMnt };
  }

  const yearTerm = params.yearAdjustmentRate * (subject.year - l.year);
  const mileageTerm =
    subject.mileageKm !== null && l.mileageKm !== null && Number.isFinite(subject.mileageKm) && Number.isFinite(l.mileageKm)
      ? (params.mileageAdjustmentPer10kKm * (subject.mileageKm - l.mileageKm)) / KM_PER_MILEAGE_STEP
      : 0;
  const factor = Math.min(Math.max(1 + yearTerm - mileageTerm, 1 - params.maxTotalAdjustment), 1 + params.maxTotalAdjustment);
  const adjusted = wholeMnt(priceMnt * factor);
  // Only reachable with broken parameters (e.g. maxTotalAdjustment >= 1); never let such a value into the statistics.
  if (!Number.isFinite(adjusted) || adjusted <= 0) return { reason: 'INVALID_PRICE', priceMnt };
  return { reason: null, priceMnt, adjusted };
}

function confidenceOf(n: number, cv: number, params: MarketPriceParams): ValuationConfidence {
  if (n >= params.highConfidenceMinSample && cv <= params.highConfidenceMaxCv) return 'HIGH';
  if (n >= params.mediumConfidenceMinSample && cv <= params.mediumConfidenceMaxCv) return 'MEDIUM';
  return 'LOW';
}

export function estimateMarketPrice(
  subject: MarketPriceSubject,
  listings: MarketListingInput[],
  params: MarketPriceParams,
  asOf: Date,
): { estimate: MarketPriceEstimate | null; outcomes: ComparableOutcome[] } {
  assertValidInputs(params, asOf);
  const outcomes: ComparableOutcome[] = [];
  const passed: { index: number; value: number }[] = [];
  listings.forEach((l, index) => {
    const s = screen(subject, l, params, asOf);
    if (s.reason === null) passed.push({ index, value: s.adjusted });
    outcomes.push({
      id: l.id,
      priceMnt: s.priceMnt,
      adjustedPriceMnt: s.reason === null ? s.adjusted : null,
      included: s.reason === null,
      exclusionReason: s.reason,
    });
  });

  // Tukey fences are computed once over everything that passed the filters, not iteratively.
  if (passed.length >= params.outlierMinSample) {
    const sorted = passed.map((p) => p.value).sort(byValue);
    const q1 = percentile(sorted, Q1);
    const q3 = percentile(sorted, Q3);
    const iqr = Math.max(q3 - q1, params.outlierMinRelativeSpread * percentile(sorted, MEDIAN));
    const lowFence = q1 - params.outlierIqrFactor * iqr;
    const highFence = q3 + params.outlierIqrFactor * iqr;
    for (const { index, value } of passed) {
      if (value < lowFence || value > highFence) outcomes[index] = { ...outcomes[index], included: false, exclusionReason: 'OUTLIER' };
    }
  }

  const values = passed.filter((p) => outcomes[p.index].included).map((p) => p.value).sort(byValue);
  const n = values.length;
  if (n < Math.max(1, params.minComparables)) return { estimate: null, outcomes };

  const round = (v: number): number => (params.roundToMnt > 0 ? Math.round(v / params.roundToMnt) * params.roundToMnt : Math.round(v));
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const stdDev = n === 1 ? 0 : Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1));
  const cv = stdDev / mean; // mean > 0: every included value passed the positive-price guard
  const estimate: MarketPriceEstimate = {
    marketValue: round(percentile(values, MEDIAN)),
    lowValue: round(percentile(values, Q1)),
    highValue: round(percentile(values, Q3)),
    meanValue: round(mean),
    sampleSize: n,
    confidence: confidenceOf(n, cv, params),
  };
  // Rounding to a coarse step must not turn a thin, cheap sample into a value of zero: no estimate is better than a zero collateral value.
  if (estimate.marketValue <= 0 || estimate.lowValue <= 0) return { estimate: null, outcomes };
  return { estimate, outcomes };
}
