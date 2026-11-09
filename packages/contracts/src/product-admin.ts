import { z } from 'zod';
import { AssetType } from './enums';
import { ChangeReasonField } from './admin';
import { ProductCollateralChecklist, ProductDocumentChecklist } from './dto';

/**
 * Зээлийн бүтээгдэхүүний админ (FR-13, BR-6, Q-124 хэв маяг). Бүтээгдэхүүний үүсгэх/засах/идэвхгүй болгох нь 4 нүдээр (Maker-Checker).
 * Нэгж (origination.product-той ижил): хүү = ЖИЛИЙН ХУВЬ (0..100), шимтгэл/LTV/ӨОХ/haircut/ББӨ = БУТАРХАЙ (0..1), ӨТЧХ = коэффициент, дүн = ₮.
 * Бүх бутархай нь numeric(7,4) тул 4 оронтой; DEMO утга — docs/DECISIONS.md.
 */
export const PRODUCT_TARGET_TYPE = 'PRODUCT';
export const PRODUCT_ACTION_CREATE = 'CREATE';
export const PRODUCT_ACTION_UPDATE = 'UPDATE';
export const PRODUCT_ACTION_SET_ACTIVE = 'SET_ACTIVE';

const atMost4Decimals = (v: number) => Math.abs(v * 1e4 - Math.round(v * 1e4)) < 1e-6;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const dec4 = (min: number, max: number) => z.number().min(min).max(max).refine(atMost4Decimals, 'at most 4 decimal places').transform(round4);
const fraction = dec4(0, 1);
const money = z.number().min(0).max(1e15).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'at most 2 decimal places');
const noNul = (s: string) => !s.includes('\u0000');
const text = (min: number, max: number) => z.string().trim().min(min).max(max).refine(noNul, 'NUL not allowed');

export const ProductCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'UPPER_SNAKE_CASE');
export const ProductType = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'UPPER_SNAKE_CASE');

const HaircutJson = z.record(z.enum(AssetType), fraction);

/** Үүсгэсний дараа өөрчлөгдөхгүй: `code`, `productType`, `currency` (хүсэлтүүд тэдгээрээр холбогдсон). */
export const ProductEditable = z.object({
  name: text(1, 200),
  minAmount: money, maxAmount: money,
  minTerm: z.number().int().min(1).max(600), maxTerm: z.number().int().min(1).max(600),
  minRate: dec4(0, 100), maxRate: dec4(0, 100),
  defaultFeeRate: fraction.nullable().default(null),
  requiresCollateral: z.boolean(),
  maxLtv: fraction.nullable().default(null),
  maxDti: fraction.nullable().default(null),
  minDscr: dec4(0, 100).nullable().default(null),
  calcWeightThreshold: fraction.nullable().default(null),
  contractTemplateId: text(1, 64).nullable().default(null),
  documentChecklist: ProductDocumentChecklist.max(50).nullable().default(null),
  collateralChecklist: ProductCollateralChecklist.nullable().default(null),
  haircut: HaircutJson.nullable().default(null),
  externalValuationThreshold: money.nullable().default(null),
  costOfGoodsRate: fraction.nullable().default(null),
});
export type ProductEditable = z.infer<typeof ProductEditable>;

/** Хүрээний шалгалт (BR-6). Зөв бол null, буруу бол хэрэглэгчид харуулах мессеж. */
export function validateProductRanges(p: Pick<ProductEditable, 'minAmount' | 'maxAmount' | 'minTerm' | 'maxTerm' | 'minRate' | 'maxRate' | 'requiresCollateral' | 'maxLtv' | 'documentChecklist'>): string | null {
  if (p.minAmount <= 0) return 'Доод дүн 0-ээс их байх ёстой';
  if (p.minAmount > p.maxAmount) return 'Доод дүн дээд дүнгээс их байж болохгүй';
  if (p.minTerm > p.maxTerm) return 'Доод хугацаа дээд хугацаанаас их байж болохгүй';
  if (p.minRate > p.maxRate) return 'Доод хүү дээд хүүнээс их байж болохгүй';
  if (p.requiresCollateral && (p.maxLtv === null || p.maxLtv <= 0)) return 'Барьцаа шаардах бүтээгдэхүүнд LTV-ийн дээд хязгаар заавал';
  const keys = (p.documentChecklist ?? []).map((i) => i.key.toLowerCase());
  if (new Set(keys).size !== keys.length) return 'Баримтын жагсаалтад давхардсан түлхүүр байна';
  return null;
}
const withRanges = <T extends z.ZodTypeAny>(s: T) => s.superRefine((v, ctx) => {
  const bad = validateProductRanges(v);
  if (bad) ctx.addIssue({ code: 'custom', message: bad });
});

export const ProductCreateBody = withRanges(ProductEditable.extend({
  code: ProductCode,
  productType: ProductType,
  currency: z.enum(['MNT', 'USD']).default('MNT'),
}));
export type ProductCreateBody = z.infer<typeof ProductCreateBody>;
export const ProductUpdateBody = withRanges(ProductEditable);
export type ProductUpdateBody = z.infer<typeof ProductUpdateBody>;

/** Maker-ийн шалтгаан заавал (MC-BR-4) */
export const ProductCreateRequest = z.object({ reason: ChangeReasonField, product: ProductCreateBody });
export type ProductCreateRequest = z.infer<typeof ProductCreateRequest>;
export const ProductUpdateRequest = z.object({ reason: ChangeReasonField, product: ProductUpdateBody });
export type ProductUpdateRequest = z.infer<typeof ProductUpdateRequest>;
export const ProductSetActiveRequest = z.object({ reason: ChangeReasonField, isActive: z.boolean() });
export type ProductSetActiveRequest = z.infer<typeof ProductSetActiveRequest>;

// Change-request payload (maker-checker). Хүсэлтийн `targetId`: CREATE = code, UPDATE/SET_ACTIVE = product id.
export const ProductCreatePayload = z.object({ product: ProductCreateBody });
export const ProductUpdatePayload = z.object({ id: z.string().min(1).max(64), product: ProductUpdateBody });
export const ProductSetActivePayload = z.object({ id: z.string().min(1).max(64), isActive: z.boolean() });

export const ProductAdminDto = z.object({
  id: z.string(), code: z.string(), productType: z.string(), currency: z.string(), isActive: z.boolean(),
  name: z.string(), minAmount: z.number(), maxAmount: z.number(), minTerm: z.number().int(), maxTerm: z.number().int(),
  minRate: z.number(), maxRate: z.number(), defaultFeeRate: z.number().nullable(), requiresCollateral: z.boolean(),
  maxLtv: z.number().nullable(), maxDti: z.number().nullable(), minDscr: z.number().nullable(), calcWeightThreshold: z.number().nullable(),
  contractTemplateId: z.string().nullable(),
  documentChecklist: z.unknown().nullable(), collateralChecklist: z.unknown().nullable(), haircut: z.unknown().nullable(),
  externalValuationThreshold: z.number().nullable(), costOfGoodsRate: z.number().nullable(),
  /** Энэ бүтээгдэхүүнтэй хүсэлтийн тоо — >0 бол устгахгүй, зөвхөн идэвхгүй болгоно */
  applicationCount: z.number().int(),
  updatedAt: z.string().datetime(), updatedBy: z.string().nullable(),
});
export type ProductAdminDto = z.infer<typeof ProductAdminDto>;
