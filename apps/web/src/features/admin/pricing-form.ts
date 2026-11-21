import type { PricingTierInput } from '@los/contracts';
import { percentProblem } from '../../components/form';
import { percentToRate, rateToPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { plainNumberProblem } from './plain-number-rules';

/**
 * Шатлалын мөр (форм): тоон талбар `undefined` = хоосон, `NaN` = тоо биш текст — antd InputNumber шиг чимээгүй 0/clamp хийхгүй (F9-2).
 * Шимтгэл форм дээр ХУВИАР (1.5), API-д бутархай (0.015); хүү хоёр талдаа жилийн % (22).
 */
export interface TierRow extends Omit<PricingTierInput, 'minScore' | 'interestRate' | 'feeRate'> {
  minScore?: number;
  interestRate?: number;
  feePercent?: number;
}
export type TierField = 'minScore' | 'interestRate' | 'feePercent';
export type TierProblems = Partial<Record<TierField, string>>;

export const tierToRow = (tier: PricingTierInput): TierRow => ({
  code: tier.code, name: tier.name, band: tier.band, isDefault: tier.isDefault,
  minScore: tier.minScore, interestRate: tier.interestRate, feePercent: rateToPercent(tier.feeRate),
});

const MAX_SCORE = 1000;

function fieldProblem(label: string, value: number | undefined, check: (v: number) => string | null): string | undefined {
  if (value === undefined) return t('admin.num.required', { field: label });
  return check(value) ?? undefined;
}

/** Талбар бүрийн алдаа (мессеж). Хоосон объект = мөр зөв. */
export function tierProblems(row: TierRow): TierProblems {
  const minScoreLabel = t('admin.pricing.f.min_score');
  const rateLabel = t('admin.pricing.f.rate');
  const feeLabel = t('admin.pricing.f.fee');
  const found: TierProblems = {
    minScore: fieldProblem(minScoreLabel, row.minScore, (v) => plainNumberProblem(v, { label: minScoreLabel, min: 0, max: MAX_SCORE, integer: true })),
    interestRate: fieldProblem(rateLabel, row.interestRate, (v) => percentProblem(v, { label: rateLabel, maxDecimals: 4 })),
    feePercent: fieldProblem(feeLabel, row.feePercent, (v) => percentProblem(v, { label: feeLabel, maxDecimals: 2 })),
  };
  return Object.fromEntries(Object.entries(found).filter(([, message]) => message !== undefined)) as TierProblems;
}

/** Эхний алдаатай мөрийн мессеж ("C: Хүү 0–100% хооронд байх ёстой") эсвэл null. */
export function firstTierProblem(rows: readonly TierRow[]): string | null {
  for (const row of rows) {
    const message = Object.values(tierProblems(row))[0];
    if (message) return `${row.code}: ${message}`;
  }
  return null;
}

function finite(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid pricing tier row: validate with firstTierProblem before rowsToTiers');
  return value;
}

/** Зөвхөн `firstTierProblem(rows) === null` үед: мөр → API-ийн шатлал (шимтгэл хувь → бутархай). */
export const rowsToTiers = (rows: readonly TierRow[]): PricingTierInput[] =>
  rows.map((r) => ({
    code: r.code, name: r.name, band: r.band, isDefault: r.isDefault,
    minScore: finite(r.minScore), interestRate: finite(r.interestRate), feeRate: percentToRate(finite(r.feePercent)),
  }));
