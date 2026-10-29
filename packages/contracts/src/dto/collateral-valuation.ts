import { z } from 'zod';
import { AssetType, ValuationSource } from '../enums';
import { IsoDate } from './collateral';
import { ValuationConfidence } from './valuation';

// ── Барьцааны үнэлгээ (FR-14) — origination → valuation (sync REST, CLAUDE.md §3.1) ─────────────────────────────────────────
// Үнэ тогтоох логик, суурь үнэ, haircut, `collateral_valuation` түүх нь valuation сервист; origination зөвхөн үр дүнг барьцаан дээр хуулна.
// Хувийн мэдээлэл (өмчлөгчийн регистр) энд дамжихгүй. Харьцаа бутархай (0.7 = 70%), мөнгө ₮.
// Эдгээр endpoint-ыг ажилтан gateway-ээр шууд дуудаж болохгүй (INTERNAL_ONLY_PREFIXES) — хүрээ/төлвийн шалгалт origination-д.

export const ValuationMethod = [
  'VEHICLE_MARKET_COMPARABLES', // автомашин: зарын сайтын зах зээлийн жишиг (AutoValuationService)
  'VEHICLE_BASE_PRICE', // автомашин: суурь үнэ × элэгдэл (FR-14.1)
  'REALTY_BASE_PRICE', // орон сууц, байшин: дүүрэг/хорооны м² суурь үнэ × коэффициент
  'LAND_BASE_PRICE', // газар: м² суурь үнэ × зориулалтын коэффициент
  'LIVESTOCK_UNIT_PRICE', // мал: төрөл/насны нэгж үнэ × тоо толгой
  'INVENTORY_STOCKTAKE', // бараа: тооллогын үнэ
  'MANUAL', // ЗЭЗ-ийн оруулсан дүн (систем санал болгоогүй)
  'EXTERNAL_APPRAISAL', // гадны лицензтэй үнэлгээчин
] as const;
export type ValuationMethod = (typeof ValuationMethod)[number];

export const HaircutSource = ['PRODUCT_RULE', 'PRODUCT_JSON', 'ORG_RULE', 'DEMO_DEFAULT'] as const;
export type HaircutSource = (typeof HaircutSource)[number];

export const SuggestionUnavailableReason = ['NO_BASE_PRICE', 'INSUFFICIENT_DATA', 'MANUAL_VALUE_ASSET', 'SOURCE_UNAVAILABLE', 'VEHICLE_NOT_FOUND'] as const;
export type SuggestionUnavailableReason = (typeof SuggestionUnavailableReason)[number];

export const SuggestionWarning = ['MILEAGE_NOT_PROVIDED', 'LOW_CONFIDENCE', 'BASE_PRICE_STALE', 'DEMO_PARAMETERS'] as const;
export type SuggestionWarning = (typeof SuggestionWarning)[number];

/** Систем санал болгосон зах зээлийн үнэ (FR-14.2). `available=false` үед ЗЭЗ дүнг гараар оруулна. */
export const ValuationSuggestion = z.object({
  available: z.boolean(),
  method: z.enum(ValuationMethod).nullable(),
  marketValue: z.number().nullable(),
  lowValue: z.number().nullable(),
  highValue: z.number().nullable(),
  confidence: z.enum(ValuationConfidence).nullable(),
  /** Тооцоонд ашигласан орц (суурь үнэ, коэффициент, жишиг зар …). Хувийн мэдээлэлгүй. */
  basis: z.record(z.unknown()),
  warnings: z.array(z.enum(SuggestionWarning)),
  unavailableReason: z.enum(SuggestionUnavailableReason).nullable(),
});
export type ValuationSuggestion = z.infer<typeof ValuationSuggestion>;

export const HaircutResolution = z.object({ rate: z.number().min(0).max(1), source: z.enum(HaircutSource) });
export type HaircutResolution = z.infer<typeof HaircutResolution>;

/** Барьцаа бүрийн нийтлэг орц. `description` нь `COLLATERAL_DESCRIPTION_SCHEMAS[assetType]`-аар valuation-д дахин шалгагдана. */
const ValuateCollateralBase = z.object({
  collateralId: z.string().uuid(),
  applicationId: z.string().uuid(),
  productId: z.string().nullable(),
  assetType: z.enum(AssetType),
  description: z.record(z.unknown()),
  /** `product.haircut_json[assetType]` (origination-ийн бүтээгдэхүүн). valuation-ий `haircut_rule` байхгүй үед хэрэглэнэ. */
  productHaircutRate: z.number().min(0).max(1).nullable(),
  /** `product.external_valuation_threshold`: зах зээлийн үнэ энээс дээш бол гадны үнэлгээ заавал (FR-14.3). */
  externalValuationThreshold: z.number().nonnegative().nullable(),
  /** Үнэлгээ хүчинтэй хоног (setting `valuation.internal_validity_days` / `external_validity_days`). */
  validityDays: z.number().int().positive().max(3650),
});

export const SuggestValuationRequest = ValuateCollateralBase;
export type SuggestValuationRequest = z.infer<typeof SuggestValuationRequest>;

export const SuggestValuationResponse = z.object({
  assetType: z.enum(AssetType),
  suggestion: ValuationSuggestion,
  haircut: HaircutResolution,
  /** ЗЭЗ үнийг заавал оруулах төрөл (бараа, тоног төхөөрөмж, бусад). */
  manualValueRequired: z.boolean(),
  externalValuationThreshold: z.number().nullable(),
});
export type SuggestValuationResponse = z.infer<typeof SuggestValuationResponse>;

export const SaveCollateralValuationRequest = ValuateCollateralBase.extend({
  /** ЗЭЗ-ийн эцсийн зах зээлийн үнэ. Байхгүй бол системийн санал (боломжгүй бол 422 `MARKET_VALUE_REQUIRED`). */
  marketValue: z.number().finite().positive().max(1e12).optional(),
  /** Санал болгосноос ялгаатай эсвэл санал байхгүй үед заавал (FR-14.2); гараар оруулдаг төрөлд (бараа, тоног төхөөрөмж, бусад) шаардахгүй. */
  overrideReason: z.string().trim().min(3).max(500).optional(),
});
export type SaveCollateralValuationRequest = z.infer<typeof SaveCollateralValuationRequest>;

export const RecordExternalValuationRequest = ValuateCollateralBase.extend({
  appraiser: z.string().trim().min(1).max(200),
  licenseNo: z.string().trim().min(1).max(60).optional(),
  valuedAt: IsoDate,
  validUntil: IsoDate.optional(),
  marketValue: z.number().finite().positive().max(1e12),
  reportFileId: z.string().uuid(),
  note: z.string().trim().min(1).max(500).optional(),
});
export type RecordExternalValuationRequest = z.infer<typeof RecordExternalValuationRequest>;

/** `valuation.collateral_valuation` мөр (FR-14.3 үнэлгээний бичлэг). */
export const CollateralValuationRecord = z.object({
  id: z.string(),
  collateralId: z.string(),
  source: z.enum(ValuationSource),
  method: z.enum(ValuationMethod),
  appraiser: z.string().nullable(),
  licenseNo: z.string().nullable(),
  valuedAt: z.string().datetime(),
  validUntil: z.string().datetime().nullable(),
  marketValue: z.number(),
  suggestedValue: z.number().nullable(),
  haircutRate: z.number(),
  haircutSource: z.enum(HaircutSource),
  collateralValue: z.number(),
  overrideReason: z.string().nullable(),
  reportFileId: z.string().nullable(),
  externalRequired: z.boolean(),
  createdBy: z.string().nullable(),
});
export type CollateralValuationRecord = z.infer<typeof CollateralValuationRecord>;

export const SaveCollateralValuationResponse = z.object({ valuation: CollateralValuationRecord, suggestion: ValuationSuggestion });
export type SaveCollateralValuationResponse = z.infer<typeof SaveCollateralValuationResponse>;

export const ValuationHistoryResponse = z.object({ items: z.array(CollateralValuationRecord) });
export type ValuationHistoryResponse = z.infer<typeof ValuationHistoryResponse>;

// ── Админ: суурь үнийн сан, haircut (FR-14.1, FR-14.5; gateway: `settings:manage`) ──────────────────────────────────────────
export const BasePriceAssetType = ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND', 'LIVESTOCK'] as const satisfies readonly (typeof AssetType)[number][];
export type BasePriceAssetType = (typeof BasePriceAssetType)[number];

/** `base_price.key_json` хэлбэр, хөрөнгийн төрлөөр. APARTMENT/HOUSE/LAND нэгж үнэ = ₮/м²; LIVESTOCK = ₮/толгой; VEHICLE = тухайн оны суурь үнэ ₮. */
export const BasePriceKey = z.union([
  z.object({ make: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(60), year: z.number().int().min(1950).max(2100) }),
  z.object({ district: z.string().trim().min(1).max(60), khoroo: z.string().trim().min(1).max(40).optional() }),
  z.object({ livestockType: z.enum(['HORSE', 'CATTLE', 'SHEEP', 'GOAT', 'CAMEL']), ageGroup: z.enum(['ADULT', 'YOUNG']) }),
]);
export type BasePriceKey = z.infer<typeof BasePriceKey>;

export const BasePriceInput = z.object({
  assetType: z.enum(BasePriceAssetType),
  key: BasePriceKey,
  unitPrice: z.number().finite().positive().max(1e12),
  validFrom: IsoDate,
});
export type BasePriceInput = z.infer<typeof BasePriceInput>;

export const BasePriceView = z.object({
  id: z.string(),
  assetType: z.enum(BasePriceAssetType),
  key: z.record(z.unknown()),
  unitPrice: z.number(),
  validFrom: IsoDate,
  version: z.number().int(),
  createdAt: z.string().datetime(),
  createdBy: z.string().nullable(),
});
export type BasePriceView = z.infer<typeof BasePriceView>;

export const BasePriceImportRequest = z.object({ items: z.array(BasePriceInput).min(1).max(5000) });
export type BasePriceImportRequest = z.infer<typeof BasePriceImportRequest>;

export const BasePriceListQuery = z.object({
  assetType: z.enum(BasePriceAssetType).optional(),
  /** true → хувилбарын түүхийг бүгдийг (FR-14.5); анхдагч нь түлхүүр бүрийн хүчинтэй сүүлийн хувилбар. */
  history: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
export type BasePriceListQuery = z.infer<typeof BasePriceListQuery>;

export const HaircutRuleInput = z.object({
  /** null → бүх бүтээгдэхүүн. */
  productId: z.string().nullable(),
  assetType: z.enum(AssetType),
  haircutRate: z.number().min(0).max(1),
});
export type HaircutRuleInput = z.infer<typeof HaircutRuleInput>;

export const HaircutRuleView = z.object({
  id: z.string(),
  productId: z.string().nullable(),
  assetType: z.enum(AssetType),
  haircutRate: z.number(),
  isActive: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type HaircutRuleView = z.infer<typeof HaircutRuleView>;
