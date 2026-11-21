import type { TierSetIssueCode } from '@los/calc';
import { t } from '../../lib/i18n';

/**
 * Серверийн 422 `INVALID_TIER_SET`-ийн `details` (packages/calc `validateTierSet`): `{ code, tiers }`.
 * `tiers` = холбогдох шатлалын код(ууд); хос бол [доод оноотой, дээд оноотой]. `code` нь серверээс ирдэг тул энд `string`.
 */
export interface TierIssue { code: string; tiers: string[] }

const isTierIssue = (v: unknown): v is TierIssue => {
  if (typeof v !== 'object' || v === null) return false;
  const { code, tiers } = v as { code?: unknown; tiers?: unknown };
  return typeof code === 'string' && Array.isArray(tiers) && tiers.every((x) => typeof x === 'string');
};

/** `details` нь найдваргүй оролт: массив биш / буруу бүтэцтэй элементийг алгасна. */
export const parseTierSetIssues = (details: unknown): TierIssue[] => (Array.isArray(details) ? details.filter(isTierIssue) : []);

type Describe = (tiers: readonly string[]) => string;
const at = (tiers: readonly string[], i: number): string => tiers[i] ?? '';
const pair = (tiers: readonly string[]) => ({ lower: at(tiers, 0), higher: at(tiers, 1) });

// `Record<TierSetIssueCode, …>` — validateTierSet-д шинэ код нэмбэл энд тайлбаргүй үлдэхгүй (compile алдаа).
const DESCRIBE: Record<TierSetIssueCode, Describe> = {
  EMPTY: () => t('admin.pricing.issue.EMPTY'),
  FIRST_TIER_NOT_ZERO: (tiers) => t('admin.pricing.issue.FIRST_TIER_NOT_ZERO', { code: at(tiers, 0) }),
  DUPLICATE_MIN_SCORE: (tiers) => t('admin.pricing.issue.DUPLICATE_MIN_SCORE', pair(tiers)),
  DUPLICATE_CODE: (tiers) => t('admin.pricing.issue.DUPLICATE_CODE', { code: tiers.join(', ') }),
  DEFAULT_TIER_COUNT: (tiers) => (tiers.length === 0 ? t('admin.pricing.issue.DEFAULT_NONE') : t('admin.pricing.issue.DEFAULT_MANY', { codes: tiers.join(', ') })),
  INTEREST_RATE_NOT_MONOTONIC: (tiers) => t('admin.pricing.issue.INTEREST_RATE_NOT_MONOTONIC', pair(tiers)),
  FEE_RATE_NOT_MONOTONIC: (tiers) => t('admin.pricing.issue.FEE_RATE_NOT_MONOTONIC', pair(tiers)),
};

const describerFor = (code: string): Describe | undefined => (Object.prototype.hasOwnProperty.call(DESCRIBE, code) ? DESCRIBE[code as TierSetIssueCode] : undefined);

/** Нэг issue → шатлалын кодыг нэрлэсэн монгол өгүүлбэр. Үл мэдэгдэх (шинэ) код нь ерөнхий өгүүлбэр + код. */
export const describeTierIssue = (issue: TierIssue): string =>
  describerFor(issue.code)?.(issue.tiers) ?? t('admin.pricing.issue.UNKNOWN', { code: issue.code });

/** `ApiError.details` → давхардалгүй өгүүлбэрүүд (дарааллыг хадгална). Хоосон = задлагдах issue алга. */
export const describeTierIssues = (details: unknown): string[] => [...new Set(parseTierSetIssues(details).map(describeTierIssue))];
