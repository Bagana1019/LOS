import { AssetType, ProductCreateBody, ProductUpdateBody, type ProductAdminDto } from '@los/contracts';
import { parseJsonInput } from './admin.utils';

/** Бүтээгдэхүүний формын утга. Баримтын жагсаалт — мөр бүр; haircut — хөрөнгийн төрөл бүр; барьцааны жагсаалт — JSON текст. */
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

export function productToForm(p: ProductAdminDto): ProductFormValues {
  return {
    code: p.code, productType: p.productType, currency: p.currency, name: p.name,
    minAmount: p.minAmount, maxAmount: p.maxAmount, minTerm: p.minTerm, maxTerm: p.maxTerm, minRate: p.minRate, maxRate: p.maxRate,
    defaultFeeRate: p.defaultFeeRate, requiresCollateral: p.requiresCollateral, maxLtv: p.maxLtv, maxDti: p.maxDti, minDscr: p.minDscr,
    calcWeightThreshold: p.calcWeightThreshold, externalValuationThreshold: p.externalValuationThreshold, costOfGoodsRate: p.costOfGoodsRate, contractTemplateId: p.contractTemplateId,
    documentChecklist: Array.isArray(p.documentChecklist) ? (p.documentChecklist as ProductFormValues['documentChecklist']) : [],
    haircut: p.haircut && typeof p.haircut === 'object' ? (p.haircut as ProductFormValues['haircut']) : {},
    collateralChecklistText: p.collateralChecklist ? JSON.stringify(p.collateralChecklist, null, 2) : '',
  };
}

const nul = <T,>(v: T | null | undefined) => (v === undefined || v === '' ? null : v);

export type FormResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Форм → API-ийн body. Шалгалт нь серверийн адил `@los/contracts` schema (хоёр тал ижил дүрэм). */
export function formToProduct(v: ProductFormValues, mode: 'create'): FormResult<ProductCreateBody>;
export function formToProduct(v: ProductFormValues, mode: 'update'): FormResult<ProductUpdateBody>;
export function formToProduct(v: ProductFormValues, mode: 'create' | 'update'): FormResult<ProductCreateBody | ProductUpdateBody> {
  let collateral: unknown = null;
  const text = (v.collateralChecklistText ?? '').trim();
  if (text) {
    const parsed = parseJsonInput(text);
    if (!parsed.ok) return { ok: false, error: 'Барьцааны баримтын жагсаалт (JSON) буруу байна' };
    collateral = parsed.value;
  }
  const haircutEntries = Object.entries(v.haircut ?? {}).filter(([, r]) => r !== null && r !== undefined);
  const base = {
    name: v.name ?? '',
    minAmount: v.minAmount ?? 0, maxAmount: v.maxAmount ?? 0, minTerm: v.minTerm ?? 0, maxTerm: v.maxTerm ?? 0, minRate: v.minRate ?? 0, maxRate: v.maxRate ?? 0,
    defaultFeeRate: nul(v.defaultFeeRate), requiresCollateral: !!v.requiresCollateral, maxLtv: nul(v.maxLtv), maxDti: nul(v.maxDti), minDscr: nul(v.minDscr),
    calcWeightThreshold: nul(v.calcWeightThreshold), contractTemplateId: nul(v.contractTemplateId?.trim()),
    documentChecklist: (v.documentChecklist ?? []).length ? (v.documentChecklist ?? []).map((i) => ({ key: i.key ?? '', name: i.name ?? '', required: i.required ?? true })) : null,
    collateralChecklist: collateral,
    haircut: haircutEntries.length ? Object.fromEntries(haircutEntries) : null,
    externalValuationThreshold: nul(v.externalValuationThreshold), costOfGoodsRate: nul(v.costOfGoodsRate),
  };
  const r = mode === 'create'
    ? ProductCreateBody.safeParse({ ...base, code: v.code?.trim() ?? '', productType: v.productType?.trim() ?? '', currency: v.currency ?? 'MNT' })
    : ProductUpdateBody.safeParse(base);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0]!;
  return { ok: false, error: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
}

export const ASSET_TYPES = AssetType;
