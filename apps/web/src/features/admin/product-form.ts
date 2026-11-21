import { AssetType, ProductCreateBody, ProductUpdateBody, type ProductAdminDto } from '@los/contracts';
import { percentToRate, rateToPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { parseJsonInput } from './admin.utils';

/**
 * Бүтээгдэхүүний формын утга. Баримтын жагсаалт — мөр бүр; haircut — хөрөнгийн төрөл бүр; барьцааны жагсаалт — JSON текст.
 * Бутархай талбарууд (шимтгэл, LTV, ӨОХ, жингийн босго, ББӨ, haircut) форм дээр ХУВИАР (65 = 65%), API-д бутархай (0.65): `productToForm`/`formToProduct` хөрвүүлнэ (F9-2).
 * Хүү (minRate/maxRate) хоёр талдаа жилийн %, ӨТЧХ коэффициент, дүн ₮. Тоон талбарт `NaN` = тоо биш текст (`formToProduct` татгалзана).
 */
export interface ProductFormValues {
  code?: string; productType?: string; currency?: string; name?: string;
  minAmount?: number | null; maxAmount?: number | null; minTerm?: number | null; maxTerm?: number | null; minRate?: number | null; maxRate?: number | null;
  defaultFeeRate?: number | null; requiresCollateral?: boolean; maxLtv?: number | null; maxDti?: number | null; minDscr?: number | null;
  calcWeightThreshold?: number | null; externalValuationThreshold?: number | null; costOfGoodsRate?: number | null; contractTemplateId?: string | null;
  documentChecklist?: Array<{ key?: string; name?: string; required?: boolean }>;
  haircut?: Partial<Record<AssetType, number | null>>;
  collateralChecklistText?: string;
}

export const EMPTY_FORM: ProductFormValues = {
  currency: 'MNT', requiresCollateral: false, documentChecklist: [], haircut: {}, collateralChecklistText: '',
};

const toPercent = (rate: number | null): number | null => (rate === null ? null : rateToPercent(rate));
const toRate = (percent: number | null | undefined): number | null => (percent === null || percent === undefined ? null : percentToRate(percent));

function haircutToForm(haircut: unknown): ProductFormValues['haircut'] {
  if (!haircut || typeof haircut !== 'object') return {};
  return Object.fromEntries(Object.entries(haircut).map(([asset, rate]) => [asset, typeof rate === 'number' ? rateToPercent(rate) : rate]));
}

export function productToForm(p: ProductAdminDto): ProductFormValues {
  return {
    code: p.code, productType: p.productType, currency: p.currency, name: p.name,
    minAmount: p.minAmount, maxAmount: p.maxAmount, minTerm: p.minTerm, maxTerm: p.maxTerm, minRate: p.minRate, maxRate: p.maxRate,
    defaultFeeRate: toPercent(p.defaultFeeRate), requiresCollateral: p.requiresCollateral, maxLtv: toPercent(p.maxLtv), maxDti: toPercent(p.maxDti), minDscr: p.minDscr,
    calcWeightThreshold: toPercent(p.calcWeightThreshold), externalValuationThreshold: p.externalValuationThreshold, costOfGoodsRate: toPercent(p.costOfGoodsRate), contractTemplateId: p.contractTemplateId,
    documentChecklist: Array.isArray(p.documentChecklist) ? (p.documentChecklist as ProductFormValues['documentChecklist']) : [],
    haircut: haircutToForm(p.haircut),
    collateralChecklistText: p.collateralChecklist ? JSON.stringify(p.collateralChecklist, null, 2) : '',
  };
}

const nul = <T,>(v: T | null | undefined) => (v === undefined || v === '' ? null : v);

/** Тоон талбарын аль нэг нь "тоо биш текст" (NaN) эсэх — чимээгүй 0/null болгохгүй, тодорхой алдаа өгнө. */
function hasNotANumber(v: ProductFormValues): boolean {
  const numbers = [
    v.minAmount, v.maxAmount, v.minTerm, v.maxTerm, v.minRate, v.maxRate, v.defaultFeeRate, v.maxLtv, v.maxDti, v.minDscr,
    v.calcWeightThreshold, v.externalValuationThreshold, v.costOfGoodsRate, ...Object.values(v.haircut ?? {}),
  ];
  return numbers.some((n) => typeof n === 'number' && Number.isNaN(n));
}

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Форм → API-ийн body. Шалгалт нь серверийн адил `@los/contracts` schema (хоёр тал ижил дүрэм). */
export function formToProduct(v: ProductFormValues, mode: 'create'): FormResult<ProductCreateBody>;
export function formToProduct(v: ProductFormValues, mode: 'update'): FormResult<ProductUpdateBody>;
export function formToProduct(v: ProductFormValues, mode: 'create' | 'update'): FormResult<ProductCreateBody | ProductUpdateBody> {
  if (hasNotANumber(v)) return { ok: false, error: t('admin.num.not_number') };
  let collateral: unknown = null;
  const text = (v.collateralChecklistText ?? '').trim();
  if (text) {
    const parsed = parseJsonInput(text);
    if (!parsed.ok) return { ok: false, error: 'Барьцааны баримтын жагсаалт (JSON) буруу байна' };
    collateral = parsed.value;
  }
  const haircutEntries = Object.entries(v.haircut ?? {}).filter((e): e is [string, number] => e[1] !== null && e[1] !== undefined).map(([asset, percent]) => [asset, percentToRate(percent)]);
  const base = {
    name: v.name ?? '',
    minAmount: v.minAmount ?? 0, maxAmount: v.maxAmount ?? 0, minTerm: v.minTerm ?? 0, maxTerm: v.maxTerm ?? 0, minRate: v.minRate ?? 0, maxRate: v.maxRate ?? 0,
    defaultFeeRate: toRate(v.defaultFeeRate), requiresCollateral: !!v.requiresCollateral, maxLtv: toRate(v.maxLtv), maxDti: toRate(v.maxDti), minDscr: nul(v.minDscr),
    calcWeightThreshold: toRate(v.calcWeightThreshold), contractTemplateId: nul(v.contractTemplateId?.trim()),
    documentChecklist: (v.documentChecklist ?? []).length ? (v.documentChecklist ?? []).map((i) => ({ key: i.key ?? '', name: i.name ?? '', required: i.required ?? true })) : null,
    collateralChecklist: collateral,
    haircut: haircutEntries.length ? Object.fromEntries(haircutEntries) : null,
    externalValuationThreshold: nul(v.externalValuationThreshold), costOfGoodsRate: toRate(v.costOfGoodsRate),
  };
  const r = mode === 'create'
    ? ProductCreateBody.safeParse({ ...base, code: v.code?.trim() ?? '', productType: v.productType?.trim() ?? '', currency: v.currency ?? 'MNT' })
    : ProductUpdateBody.safeParse(base);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0]!;
  return { ok: false, error: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
}

export const ASSET_TYPES = AssetType;
