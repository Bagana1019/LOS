// Field labels + units for the "Өмнө → Дараа" table (F8-3 blacklist, F9-5 product). All texts live in mn.maker-checker.json.
// Units follow @los/contracts product-admin: rate = annual PERCENT (0..100); fee/LTV/DTI/haircut/cost-of-goods = FRACTION (0..1); amounts = ₮; terms = months.
import { formatMnt, formatPercent } from '../../lib/format';
import { hasMessage, t } from '../../lib/i18n';
import { listTypeLabel, reasonLabel } from '../blacklist/blacklist.utils';
import { formatValue } from './diff';

export type ValueUnit = 'text' | 'json' | 'number' | 'mnt' | 'ratio' | 'annualPercent' | 'months' | 'yesNo' | 'severity' | 'listType' | 'reason';
export interface FieldMeta { label: string; unit: ValueUnit }

const PRODUCT_FIELDS: Readonly<Record<string, ValueUnit>> = {
  name: 'text', code: 'text', productType: 'text', currency: 'text', isActive: 'yesNo',
  minAmount: 'mnt', maxAmount: 'mnt', minTerm: 'months', maxTerm: 'months',
  minRate: 'annualPercent', maxRate: 'annualPercent', defaultFeeRate: 'ratio', requiresCollateral: 'yesNo',
  maxLtv: 'ratio', maxDti: 'ratio', minDscr: 'number', calcWeightThreshold: 'ratio', contractTemplateId: 'text',
  documentChecklist: 'json', collateralChecklist: 'json', haircut: 'json', externalValuationThreshold: 'mnt', costOfGoodsRate: 'ratio',
};
const BLACKLIST_FIELDS: Readonly<Record<string, ValueUnit>> = {
  severity: 'severity', pendingSeverity: 'severity', isActive: 'yesNo', listType: 'listType', reasonCode: 'reason',
};
/** Exported so a test can prove every field has a Mongolian label. */
export const PRODUCT_FIELD_NAMES: readonly string[] = Object.keys(PRODUCT_FIELDS);
export const BLACKLIST_FIELD_NAMES: readonly string[] = Object.keys(BLACKLIST_FIELDS);

const HAIRCUT = 'haircut';
const assetLabel = (code: string): string => (hasMessage(`collateral.assetType.${code}`) ? t(`collateral.assetType.${code}`) : code);

function productMeta(path: string): FieldMeta | null {
  const [head = '', ...rest] = path.split('.');
  if (head === HAIRCUT && rest.length > 0) return { label: `${t('maker_checker.product_field.haircut')} · ${assetLabel(rest.join('.'))}`, unit: 'ratio' };
  if (!Object.hasOwn(PRODUCT_FIELDS, path)) return null;
  return { label: t(`maker_checker.product_field.${path}`), unit: PRODUCT_FIELDS[path] as ValueUnit };
}

function blacklistMeta(path: string): FieldMeta | null {
  if (!Object.hasOwn(BLACKLIST_FIELDS, path)) return null;
  return { label: t(`maker_checker.blacklist_field.${path}`), unit: BLACKLIST_FIELDS[path] as ValueUnit };
}

/** Label + unit of a diff path for a target type; null when unknown (caller shows the raw path and value). */
export function fieldMeta(targetType: string, path: string): FieldMeta | null {
  if (targetType === 'PRODUCT') return productMeta(path);
  if (targetType === 'BLACKLIST_ENTRY') return blacklistMeta(path);
  return null;
}

const severityLabel = (code: string): string => (hasMessage(`blacklist.severity.${code}`) ? t(`blacklist.severity.${code}`) : code);
const CODE_LABELS: Partial<Record<ValueUnit, (code: string) => string>> = { severity: severityLabel, listType: listTypeLabel, reason: reasonLabel };

function formatNumber(unit: ValueUnit, n: number): string | null {
  switch (unit) {
    case 'mnt': return formatMnt(n);
    case 'ratio': return formatPercent(n);
    case 'annualPercent': return formatPercent(n / 100);
    case 'months': return t('maker_checker.value.months', { n });
    case 'number': return String(n);
    default: return null;
  }
}

/** A value with its unit: 0.25 + ratio → "25%", 5 + mnt → "5₮", null → "Заагаагүй". A value of an unexpected type is shown as plain text. */
export function formatUnitValue(unit: ValueUnit, value: unknown): string {
  if (value === null || value === undefined) return t('maker_checker.value.not_set');
  if (typeof value === 'number') return formatNumber(unit, value) ?? formatValue(value);
  if (typeof value === 'boolean' && unit === 'yesNo') return t(value ? 'maker_checker.value.yes' : 'maker_checker.value.no');
  const codeLabel = CODE_LABELS[unit];
  if (typeof value === 'string' && codeLabel) return codeLabel(value);
  return formatValue(value);
}
