// F9-5: a checker could approve absurd product values (minimum amount 5₮, LTV 100%) without any hint. These rules only WARN — they never
// block, never change who may approve, and are NOT the server's validation (the server validates ranges/consistency itself).
import { t } from '../../lib/i18n';
import { buildChangeView, type RequestLike } from './change-view';
import { diffObjects } from './diff';
import { fieldMeta, formatUnitValue, type ValueUnit } from './field-meta';

export type RangeOp = 'gt' | 'gte' | 'lt';
export interface RangeRule {
  /** Field path in the product (same as the diff path). */
  path: string;
  /** gt: value > limit is odd; gte: value >= limit is odd; lt: value < limit is odd. */
  op: RangeOp;
  limit: number;
  /** Unit of BOTH the value and the limit (so the message shows "90%" or "10,000₮"). */
  unit: ValueUnit;
}

/**
 * The single place to tune the thresholds. Units as stored: LTV is a fraction (0.9 = 90%), amounts are ₮, annual rates are percent (100 = 100%).
 * - LTV above 90%: a loan nearly as large as the collateral leaves no margin.
 * - Minimum amount below 10,000₮: a loan this small is a typo (the finding's test value was 5₮).
 * - Annual rate of 100% or more: a rate that doubles the debt in a year (the finding's test value was 100%).
 */
export const PRODUCT_RANGE_RULES: readonly RangeRule[] = [
  { path: 'maxLtv', op: 'gt', limit: 0.9, unit: 'ratio' },
  { path: 'minAmount', op: 'lt', limit: 10_000, unit: 'mnt' },
  { path: 'minRate', op: 'gte', limit: 100, unit: 'annualPercent' },
  { path: 'maxRate', op: 'gte', limit: 100, unit: 'annualPercent' },
];

export interface RangeWarning { path: string; message: string }

const outOfRange = (op: RangeOp, value: number, limit: number): boolean => (op === 'gt' ? value > limit : op === 'gte' ? value >= limit : value < limit);

/** Warnings for the values this request ADDS or CHANGES (an odd old value the request does not touch is not repeated). Only product create/update. */
export function rangeWarnings(dto: RequestLike): RangeWarning[] {
  if (dto.targetType !== 'PRODUCT' || (dto.action !== 'CREATE' && dto.action !== 'UPDATE')) return [];
  const view = buildChangeView(dto);
  const proposed = new Map(diffObjects(view.before, view.after).filter((r) => r.kind !== 'removed').map((r) => [r.path, r.after]));
  const warnings: RangeWarning[] = [];
  for (const rule of PRODUCT_RANGE_RULES) {
    const value = proposed.get(rule.path);
    if (typeof value !== 'number' || !outOfRange(rule.op, value, rule.limit)) continue;
    const message = t(`maker_checker.warn.${rule.op}`, {
      field: fieldMeta('PRODUCT', rule.path)?.label ?? rule.path,
      value: formatUnitValue(rule.unit, value),
      limit: formatUnitValue(rule.unit, rule.limit),
    });
    warnings.push({ path: rule.path, message });
  }
  return warnings;
}
