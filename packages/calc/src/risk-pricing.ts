import Decimal from 'decimal.js';
import type { RiskBand } from '@los/contracts';
// FR-5.5: Эрсдэлд суурилсан үнэ тогтоолт — Sosco Score (0–1000) → хүү, шимтгэл. I/O-гүй; шатлал, хязгаар параметрээр ирнэ (hardcode хийхгүй).
// Нэгж (scaffold-тай нийцнэ): interestRate = жилийн ХУВЬ (23.99 — product.min_rate/max_rate, annuityPayment-тай ижил, хөрвүүлэлт хэрэггүй);
// feeRate = БУТАРХАЙ (0.015 = 1.5%), зээлийн дүнгийн нэг удаагийн хувь (product.default_fee_rate-тай ижил).

export const SOSCO_SCORE_MIN = 0;
export const SOSCO_SCORE_MAX = 1000;

export interface RiskPricingTier { code: string; name: string; band: RiskBand; minScore: number; interestRate: number; feeRate: number; isDefault: boolean; }
export interface RateBounds { minRate: number; maxRate: number; }
export interface RiskPricingQuote {
  basis: 'SCORE' | 'DEFAULT_TIER';
  soscoScore: number | null;
  tier: Pick<RiskPricingTier, 'code' | 'name' | 'band' | 'minScore'>;
  tierInterestRate: number;
  tierFeeRate: number;
  interestRate: number;
  feeRate: number;
  rateBound: 'MIN' | 'MAX' | null;
  feeAmount: number | null;
}

export type RiskPricingErrorCode = 'NO_TIERS' | 'NO_DEFAULT_TIER' | 'NO_MATCHING_TIER' | 'INVALID_SCORE' | 'INVALID_BOUNDS';
export class RiskPricingError extends Error {
  constructor(readonly code: RiskPricingErrorCode, message: string) { super(message); this.name = 'RiskPricingError'; }
}

const byMinScore = (a: RiskPricingTier, b: RiskPricingTier) => a.minScore - b.minScore;

/** Tier бүр [minScore, дараагийн tier-ийн minScore) мужийг хамарна — давхцал, цоорхой үүсэхгүй. */
export function findTier(score: number, tiers: readonly RiskPricingTier[]): RiskPricingTier {
  if (!Number.isFinite(score) || score < SOSCO_SCORE_MIN || score > SOSCO_SCORE_MAX) throw new RiskPricingError('INVALID_SCORE', `Sosco Score must be within ${SOSCO_SCORE_MIN}..${SOSCO_SCORE_MAX}: ${score}`);
  const match = [...tiers].sort(byMinScore).reverse().find((t) => t.minScore <= score);
  if (!match) throw new RiskPricingError('NO_MATCHING_TIER', `No pricing tier covers score ${score}`);
  return match;
}

export function quoteRiskPricing(input: { soscoScore: number | null; tiers: readonly RiskPricingTier[]; bounds: RateBounds; amount?: number | null }): RiskPricingQuote {
  const { soscoScore, tiers, bounds, amount } = input;
  if (tiers.length === 0) throw new RiskPricingError('NO_TIERS', 'Pricing tier set is empty');
  if (!(bounds.minRate >= 0 && bounds.minRate <= bounds.maxRate)) throw new RiskPricingError('INVALID_BOUNDS', `Invalid product rate bounds: ${bounds.minRate}..${bounds.maxRate}`);

  let tier: RiskPricingTier;
  if (soscoScore === null) {
    const fallback = tiers.find((t) => t.isDefault);
    if (!fallback) throw new RiskPricingError('NO_DEFAULT_TIER', 'Pricing tier set has no default tier');
    tier = fallback;
  } else tier = findTier(soscoScore, tiers);

  // BR-6: хүү бүтээгдэхүүний хязгаарт байх ёстой
  const interestRate = Math.min(Math.max(tier.interestRate, bounds.minRate), bounds.maxRate);
  const rateBound = tier.interestRate < bounds.minRate ? 'MIN' : tier.interestRate > bounds.maxRate ? 'MAX' : null;
  const feeAmount = amount == null ? null : new Decimal(amount).mul(tier.feeRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

  return {
    basis: soscoScore === null ? 'DEFAULT_TIER' : 'SCORE',
    soscoScore,
    tier: { code: tier.code, name: tier.name, band: tier.band, minScore: tier.minScore },
    tierInterestRate: tier.interestRate,
    tierFeeRate: tier.feeRate,
    interestRate,
    feeRate: tier.feeRate,
    rateBound,
    feeAmount,
  };
}

export type TierSetIssueCode = 'EMPTY' | 'FIRST_TIER_NOT_ZERO' | 'DUPLICATE_MIN_SCORE' | 'DUPLICATE_CODE' | 'DEFAULT_TIER_COUNT' | 'INTEREST_RATE_NOT_MONOTONIC' | 'FEE_RATE_NOT_MONOTONIC';
export interface TierSetIssue { code: TierSetIssueCode; tiers: string[]; }

/**
 * Багцын бүрэн бүтэн байдал: 0-ээс эхэлсэн, давхцалгүй, яг нэг default tier, мөн оноо өндөр байх тусам хүү/шимтгэл өсөхгүй
 * (эрсдэлтэй харилцагчид илүү өндөр үнэ — FR-5.5). Хоосон массив буцаавал хүчинтэй.
 */
export function validateTierSet(tiers: readonly RiskPricingTier[]): TierSetIssue[] {
  if (tiers.length === 0) return [{ code: 'EMPTY', tiers: [] }];
  const issues: TierSetIssue[] = [];
  const sorted = [...tiers].sort(byMinScore);

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const t of sorted) (seen.has(t.code) ? duplicated : seen).add(t.code);
  for (const code of duplicated) issues.push({ code: 'DUPLICATE_CODE', tiers: [code] });
  if (sorted[0].minScore !== SOSCO_SCORE_MIN) issues.push({ code: 'FIRST_TIER_NOT_ZERO', tiers: [sorted[0].code] });
  const defaults = sorted.filter((t) => t.isDefault);
  if (defaults.length !== 1) issues.push({ code: 'DEFAULT_TIER_COUNT', tiers: defaults.map((t) => t.code) });

  for (let i = 1; i < sorted.length; i++) {
    const lower = sorted[i - 1];
    const higher = sorted[i];
    const pair = [lower.code, higher.code];
    if (lower.minScore === higher.minScore) issues.push({ code: 'DUPLICATE_MIN_SCORE', tiers: pair });
    if (higher.interestRate > lower.interestRate) issues.push({ code: 'INTEREST_RATE_NOT_MONOTONIC', tiers: pair });
    if (higher.feeRate > lower.feeRate) issues.push({ code: 'FEE_RATE_NOT_MONOTONIC', tiers: pair });
  }
  return issues;
}
