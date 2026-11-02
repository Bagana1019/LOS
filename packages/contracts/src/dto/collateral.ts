import { z } from 'zod';
import { AssetType, CollateralSource, EncumbranceStatus, ValuationSource, type CollateralKind } from '../enums';
import { PlateNo, VehicleFuelType, normalizePlateNo } from './valuation';

// ── Барьцаа (FR-6, G0) — origination `/api/applications/:applicationId/collaterals…` ба UI-ийн гэрээ ─────────────────────────
// Үнэлгээ (FR-14) нь valuation сервист: origination → valuation DTO нь `collateral-valuation.ts`, kyc-ийн ХУР/ачааллын DTO нь `collateral-registry.ts`.
// Харьцаа бутархай (0.7 = 70%), мөнгө ₮ (number). DEMO гэж тэмдэглэсэн утгыг docs/DECISIONS.md-д бүртгэсэн.

const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().min(1).max(max).optional();
const money = z.number().finite().positive().max(1e12);
const isCalendarDate = (s: string): boolean => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 1900;
};
/** YYYY-MM-DD хэлбэр БА бодит хуанлийн огноо (2026-13-45, 2026-02-30 татгалзана). */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Огноо YYYY-MM-DD хэлбэртэй байх ёстой').refine(isCalendarDate, 'Огноо буруу байна');
const year = z.number().int().min(1950).max(2100);

// ── Хөрөнгийн төрлөөр тодорхойлолт (description_json) ────────────────────────────────────────────────────────────
export const VehicleDescription = z.object({
  plateNo: PlateNo,
  vin: optText(30),
  make: text(60),
  model: text(60),
  manufactureYear: year,
  importYear: year.optional(),
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
  engineCc: z.number().int().positive().max(20_000).optional(),
  fuelType: z.enum(VehicleFuelType).optional(),
  color: optText(40),
});
export type VehicleDescription = z.infer<typeof VehicleDescription>;

export const RealtyAddress = z.object({ province: text(60), district: text(60), khoroo: optText(40), detail: optText(200) });
export type RealtyAddress = z.infer<typeof RealtyAddress>;
export const RealtyPurpose = ['RESIDENTIAL', 'COMMERCIAL'] as const;
export type RealtyPurpose = (typeof RealtyPurpose)[number];
export const LandUse = ['RESIDENTIAL', 'COMMERCIAL', 'AGRICULTURAL', 'INDUSTRIAL', 'OTHER'] as const;
export type LandUse = (typeof LandUse)[number];

const realtyIdentity = z.object({ propertyId: optText(60), certificateNo: optText(60) });
const hasRealtyId = (d: { propertyId?: string; certificateNo?: string }) => !!(d.propertyId || d.certificateNo);
const REALTY_ID_MSG = 'Үл хөдлөх хөрөнгийн дугаар (ХУР-ын өмчлөх эрхийн дугаар) эсвэл гэрчилгээний дугаарын аль нэгийг оруулна уу';

export const ApartmentDescription = realtyIdentity
  .extend({
    address: RealtyAddress,
    areaM2: z.number().positive().max(100_000),
    floor: z.number().int().min(-5).max(200).optional(),
    totalFloors: z.number().int().min(1).max(200).optional(),
    rooms: z.number().int().min(1).max(50).optional(),
    buildYear: year.optional(),
    purpose: z.enum(RealtyPurpose).default('RESIDENTIAL'),
  })
  .refine(hasRealtyId, { message: REALTY_ID_MSG, path: ['propertyId'] });
export type ApartmentDescription = z.infer<typeof ApartmentDescription>;

export const HouseDescription = realtyIdentity
  .extend({
    address: RealtyAddress,
    areaM2: z.number().positive().max(100_000),
    landAreaM2: z.number().positive().max(10_000_000).optional(),
    floors: z.number().int().min(1).max(50).optional(),
    buildYear: year.optional(),
    purpose: z.enum(RealtyPurpose).default('RESIDENTIAL'),
  })
  .refine(hasRealtyId, { message: REALTY_ID_MSG, path: ['propertyId'] });
export type HouseDescription = z.infer<typeof HouseDescription>;

export const LandDescription = realtyIdentity
  .extend({
    address: RealtyAddress,
    areaM2: z.number().positive().max(100_000_000),
    landUse: z.enum(LandUse).default('RESIDENTIAL'),
  })
  .refine(hasRealtyId, { message: REALTY_ID_MSG, path: ['propertyId'] });
export type LandDescription = z.infer<typeof LandDescription>;

export const LivestockType = ['HORSE', 'CATTLE', 'SHEEP', 'GOAT', 'CAMEL'] as const;
export type LivestockType = (typeof LivestockType)[number];
export const LivestockAgeGroup = ['ADULT', 'YOUNG'] as const;
export type LivestockAgeGroup = (typeof LivestockAgeGroup)[number];
export const LivestockDescription = z.object({
  livestockType: z.enum(LivestockType),
  ageGroup: z.enum(LivestockAgeGroup).default('ADULT'),
  headCount: z.number().int().positive().max(1_000_000),
  location: optText(200),
});
export type LivestockDescription = z.infer<typeof LivestockDescription>;

/** Бараа материал: үнэлгээний үндсэн дүн нь тооллогын үнэ (FR-14.1) — систем санал болгохгүй, ЗЭЗ оруулна. */
export const InventoryDescription = z.object({
  name: text(200),
  stocktakeValue: money,
  stocktakeDate: IsoDate,
  location: optText(200),
});
export type InventoryDescription = z.infer<typeof InventoryDescription>;

export const EquipmentDescription = z.object({
  name: text(200),
  make: optText(60),
  model: optText(60),
  serialNo: optText(60),
  manufactureYear: year.optional(),
  purchasePrice: money.optional(),
});
export type EquipmentDescription = z.infer<typeof EquipmentDescription>;

export const OtherDescription = z.object({ name: text(200), details: optText(1000) });
export type OtherDescription = z.infer<typeof OtherDescription>;

/** Хөрөнгийн төрөл бүрийн description_json схем — сервер талд (`parseCollateralDescription`) болон UI-д нэг эх сурвалж. */
export const COLLATERAL_DESCRIPTION_SCHEMAS = {
  VEHICLE: VehicleDescription,
  APARTMENT: ApartmentDescription,
  HOUSE: HouseDescription,
  LAND: LandDescription,
  LIVESTOCK: LivestockDescription,
  INVENTORY: InventoryDescription,
  EQUIPMENT: EquipmentDescription,
  OTHER: OtherDescription,
} as const satisfies Record<(typeof AssetType)[number], z.ZodTypeAny>;

type AssetTypeValue = (typeof AssetType)[number];

/** `description` объектыг хөрөнгийн төрлийн схемээр шалгаж (анхдагч утга нөхөж, үл мэдэгдэх түлхүүр хасаж) буцаана. Алдаа → ZodError. */
export function parseCollateralDescription<T extends AssetTypeValue>(assetType: T, value: unknown): z.infer<(typeof COLLATERAL_DESCRIPTION_SCHEMAS)[T]> {
  return COLLATERAL_DESCRIPTION_SCHEMAS[assetType].parse(value) as z.infer<(typeof COLLATERAL_DESCRIPTION_SCHEMAS)[T]>;
}

/** Хөрөнгийн төрлөөс барьцааны төрөл (docs/03 `CollateralKind`): үл хөдлөх = APARTMENT, HOUSE, LAND; бусад хөдлөх. */
export const collateralKindOf = (assetType: AssetTypeValue): CollateralKind => (assetType === 'APARTMENT' || assetType === 'HOUSE' || assetType === 'LAND' ? 'IMMOVABLE' : 'MOVABLE');

/** Систем зах зээлийн үнийг санал болгодоггүй — ЗЭЗ үнийг оруулна (FR-14.1: бараа = тооллогын үнэ; тоног төхөөрөмж, бусад). */
export const MANUAL_VALUE_ASSET_TYPES = ['INVENTORY', 'EQUIPMENT', 'OTHER'] as const satisfies readonly AssetTypeValue[];
export const isManualValueAsset = (assetType: AssetTypeValue): boolean => (MANUAL_VALUE_ASSET_TYPES as readonly string[]).includes(assetType);

const normalizeKey = (raw: string): string => raw.replace(/[\s\-_./]+/g, '').toUpperCase();

/**
 * FR-6.6 · нэг хөрөнгийг идэвхтэй олон хүсэлтэд давхар барьцаалахгүй байх тодорхойлогч түлхүүр (`collateral.asset_key`).
 * VEHICLE → улсын дугаар (эсвэл VIN); APARTMENT/HOUSE/LAND → ХУР-ын өмчлөх эрхийн дугаар (эсвэл гэрчилгээ); EQUIPMENT → серийн дугаар.
 * Тодорхойлогчгүй хөрөнгө (LIVESTOCK, INVENTORY, OTHER) null — давхардал шалгахгүй.
 */
export function collateralAssetKey(assetType: AssetTypeValue, description: Record<string, unknown>): string | null {
  const str = (k: string): string | null => (typeof description[k] === 'string' && (description[k] as string).trim() ? (description[k] as string) : null);
  switch (assetType) {
    case 'VEHICLE': {
      const plate = str('plateNo');
      if (plate) return `VEHICLE:${normalizePlateNo(plate)}`;
      const vin = str('vin');
      return vin ? `VEHICLE_VIN:${normalizeKey(vin)}` : null;
    }
    case 'APARTMENT':
    case 'HOUSE':
    case 'LAND': {
      const id = str('propertyId') ?? str('certificateNo');
      return id ? `REALTY:${normalizeKey(id)}` : null;
    }
    case 'EQUIPMENT': {
      const serial = str('serialNo');
      return serial ? `EQUIPMENT:${normalizeKey(serial)}` : null;
    }
    default:
      return null;
  }
}

// ── Хүсэлтүүд ────────────────────────────────────────────────────────────────────────────────────────────────────
const CollateralCommon = z.object({
  /** Барьцаалагч = хүсэлтийн оролцогч (`customer.id`): үндсэн/хамтран зээлдэгч эсвэл PLEDGOR (FR-6.5). */
  ownerCustomerId: z.string().uuid(),
  source: z.enum(CollateralSource).default('MANUAL'),
  /** ХУР-ын хөрөнгийн ID (`source=XYP`). */
  xypRef: optText(100),
  /** Одоо байгаа ЭБ-ийн бүртгэлийн дугаар (FR-6.6: ижил дугаар өөр идэвхтэй хүсэлтэд байвал 409). */
  registryNo: optText(100),
  registryDate: IsoDate.optional(),
  insuranceExpiresAt: IsoDate.optional(),
  note: optText(1000),
});

export const CreateCollateralRequest = z.discriminatedUnion('assetType', [
  CollateralCommon.extend({ assetType: z.literal('VEHICLE'), description: VehicleDescription }),
  CollateralCommon.extend({ assetType: z.literal('APARTMENT'), description: ApartmentDescription }),
  CollateralCommon.extend({ assetType: z.literal('HOUSE'), description: HouseDescription }),
  CollateralCommon.extend({ assetType: z.literal('LAND'), description: LandDescription }),
  CollateralCommon.extend({ assetType: z.literal('LIVESTOCK'), description: LivestockDescription }),
  CollateralCommon.extend({ assetType: z.literal('INVENTORY'), description: InventoryDescription }),
  CollateralCommon.extend({ assetType: z.literal('EQUIPMENT'), description: EquipmentDescription }),
  CollateralCommon.extend({ assetType: z.literal('OTHER'), description: OtherDescription }),
]);
export type CreateCollateralRequest = z.infer<typeof CreateCollateralRequest>;

/**
 * PATCH: хөрөнгийн төрөл өөрчлөгдөхгүй. `description`-ийг сервис хадгалагдсан assetType-ийн схемээр бүтнээр нь шалгана (хэсэгчилсэн биш — UI бүх талбарыг илгээнэ).
 * Тодорхойлогч/өмчлөгч/тодорхойлолт өөрчлөгдвөл өмчлөл, ачаалал шалгалт, үнэлгээ хүчингүй болно (сервис дахин шалгуулна).
 */
export const UpdateCollateralRequest = z
  .object({
    ownerCustomerId: z.string().uuid().optional(),
    description: z.record(z.unknown()).optional(),
    registryNo: optText(100).nullable(),
    registryDate: IsoDate.nullable().optional(),
    insuranceExpiresAt: IsoDate.nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Өөрчлөх талбар өгөөгүй байна' });
export type UpdateCollateralRequest = z.infer<typeof UpdateCollateralRequest>;

export const OwnershipCheckRequest = z.object({
  /** REGISTRY = ХУР/АТҮТ-аас өмчлөгчийг татаж тулгана. DECLARED = бүртгэлгүй хөрөнгө (мал, бараа, тоног төхөөрөмж): ЗЭЗ өмчлөгчийг баталгаажуулна. */
  method: z.enum(['REGISTRY', 'DECLARED']).default('REGISTRY'),
  note: optText(500),
});
export type OwnershipCheckRequest = z.infer<typeof OwnershipCheckRequest>;

/** Систем санал болгосон үнэ (FR-14.2). `marketValue` өгвөл ЗЭЗ-ийн эцсийн дүн; санал болгосноос ялгаатай бол `overrideReason` заавал. */
export const SaveValuationRequest = z.object({
  marketValue: money.optional(),
  overrideReason: optText(500),
  /** Гүйлт — бүртгэлд байхгүй, ЗЭЗ оруулна (VEHICLE). `description.mileageKm`-ийг шинэчилнэ. */
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
});
export type SaveValuationRequest = z.infer<typeof SaveValuationRequest>;

/** Гадны лицензтэй үнэлгээчний үнэлгээ (FR-14.3). Тайлан (dms файл) заавал. */
export const ExternalValuationRequest = z.object({
  appraiser: text(200),
  licenseNo: optText(60),
  valuedAt: IsoDate,
  validUntil: IsoDate.optional(),
  marketValue: money,
  reportFileId: z.string().uuid(),
  note: optText(500),
});
export type ExternalValuationRequest = z.infer<typeof ExternalValuationRequest>;

export const AttachCollateralDocumentRequest = z.object({
  /** Checklist-ийн түлхүүр (`vehicle_certificate`, …) эсвэл `other` (нэмэлт баримт, зураг). */
  checklistKey: text(60),
  fileId: z.string().uuid(),
  note: optText(500),
});
export type AttachCollateralDocumentRequest = z.infer<typeof AttachCollateralDocumentRequest>;

/** Ачаалал шалгалт: REGISTRY = kyc-ийн ЗМС + ЭБ; DECLARED = бүртгэлгүй хөрөнгө (мал, бараа, тоног төхөөрөмж, бусад): ЗЭЗ "ачаалалгүй" гэж баталгаажуулна. */
export const RunEncumbranceCheckRequest = OwnershipCheckRequest;
export type RunEncumbranceCheckRequest = z.infer<typeof RunEncumbranceCheckRequest>;

export const RegisterPledgeRequest = z.object({ registryNo: text(100), registryDate: IsoDate });
export type RegisterPledgeRequest = z.infer<typeof RegisterPledgeRequest>;

export const CollateralMonitoringQuery = z.object({
  /** Хэдэн хоногийн дотор хугацаа дуусах/дахин үнэлэх ёстойг харуулах. Өгөөгүй бол setting `collateral.insurance_reminder_days`. */
  withinDays: z.coerce.number().int().min(0).max(3650).optional(),
});
export type CollateralMonitoringQuery = z.infer<typeof CollateralMonitoringQuery>;

export const XypAssetsQuery = z.object({ ownerCustomerId: z.string().uuid() });
export type XypAssetsQuery = z.infer<typeof XypAssetsQuery>;

// ── Checklist labels (FR-6.7). Бүтээгдэхүүний `collateral_checklist_json` нь зөвхөн түлхүүр; нэрийг энд. ─────────────────────
export const COLLATERAL_CHECKLIST_LABELS: Record<string, string> = {
  ownership_certificate: 'Өмчлөх эрхийн гэрчилгээ',
  cadastral_plan: 'Кадастрын зураг',
  registry_extract: 'Улсын бүртгэлийн лавлагаа',
  vehicle_certificate: 'Тээврийн хэрэгслийн гэрчилгээ',
  traffic_registry_extract: 'ТЭЗ-ийн лавлагаа',
  insurance: 'Даатгалын гэрээ',
  head_count_extract: 'Малын тоо толгойн лавлагаа',
  stocktake_act: 'Тооллогын акт',
  purchase_invoice: 'Худалдан авсан нэхэмжлэх',
  ownership_proof: 'Өмчлөлийн нотолгоо',
  other: 'Бусад (зураг, нэмэлт баримт)',
};
export const COLLATERAL_OTHER_DOC_KEY = 'other';
export const collateralChecklistLabel = (key: string): string => COLLATERAL_CHECKLIST_LABELS[key] ?? key;

/** `product.collateral_checklist_json`: AssetType → түлхүүрийн жагсаалт (бүгд заавал) эсвэл `{ key, required? }`. */
export const ProductCollateralChecklist = z.record(z.array(z.union([z.string().min(1), z.object({ key: z.string().min(1), required: z.boolean().default(true) })])));
export type ProductCollateralChecklist = z.infer<typeof ProductCollateralChecklist>;

// ── Хариу ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const GateIssueCode = [
  'PRODUCT_MISSING',
  'LOAN_AMOUNT_MISSING',
  'NO_COLLATERAL',
  'OWNERSHIP_NOT_CHECKED',
  'OWNERSHIP_STALE',
  'OWNER_MISMATCH',
  'OWNER_NOT_ON_APPLICATION',
  'ENCUMBRANCE_NOT_CHECKED',
  'ENCUMBRANCE_STALE',
  'ENCUMBERED',
  'ENCUMBRANCE_DISPUTED',
  'DUPLICATE_PLEDGE',
  'CHECKLIST_INCOMPLETE',
  'NOT_VALUED',
  'VALUATION_EXPIRED',
  'EXTERNAL_VALUATION_REQUIRED',
  'LTV_EXCEEDED',
] as const;
export type GateIssueCode = (typeof GateIssueCode)[number];

/** G0 хаалтыг хангаагүй шалтгаан. `collateralId=null` → хүсэлтийн түвшний (LTV, барьцаагүй …). `message` монгол. */
export const GateIssue = z.object({
  code: z.enum(GateIssueCode),
  collateralId: z.string().nullable(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type GateIssue = z.infer<typeof GateIssue>;

export const CollateralGate = z.object({
  /** G0 хангагдсан → 5-р алхам COMPLETED. */
  complete: z.boolean(),
  /** Барьцаа шаардахгүй бүтээгдэхүүн, барьцаа нэмээгүй (FR-6.4) → алхам алгасагдсан. */
  skipped: z.boolean(),
  issues: z.array(GateIssue),
  evaluatedAt: z.string().datetime(),
});
export type CollateralGate = z.infer<typeof CollateralGate>;

export const CollateralSummary = z.object({
  count: z.number().int(),
  totalMarketValue: z.number(),
  totalCollateralValue: z.number(),
  loanAmount: z.number().nullable(),
  /** LTV = зээл ÷ Σ барьцааны үнэлгээ (бутархай). Тооцох боломжгүй (дүн/үнэлгээ байхгүй) бол null. */
  ltv: z.number().nullable(),
  ltvLimit: z.number(),
  ltvPass: z.boolean().nullable(),
  requiresCollateral: z.boolean(),
});
export type CollateralSummary = z.infer<typeof CollateralSummary>;

export const CollateralDocumentView = z.object({
  id: z.string(),
  checklistKey: z.string(),
  fileId: z.string(),
  fileName: z.string().nullable(),
  mime: z.string().nullable(),
  size: z.number().int().nullable(),
  note: z.string().nullable(),
  uploadedBy: z.string().nullable(),
  uploadedAt: z.string().datetime(),
});
export type CollateralDocumentView = z.infer<typeof CollateralDocumentView>;

export const CollateralChecklistItem = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  satisfied: z.boolean(),
  documents: z.array(CollateralDocumentView),
});
export type CollateralChecklistItem = z.infer<typeof CollateralChecklistItem>;

export const OwnershipStatus = ['VERIFIED', 'OWNER_MISMATCH', 'OWNER_NOT_ON_APPLICATION'] as const;
export type OwnershipStatus = (typeof OwnershipStatus)[number];
/** Өмчлөлийн KYC-ийн үр дүн (`collateral.ownership_check_json`). Бүртгэлийн регистр нь зөвхөн далдлагдсан хэлбэрээр. */
export const OwnershipCheck = z.object({
  status: z.enum(OwnershipStatus),
  method: z.enum(['REGISTRY', 'DECLARED']),
  source: z.enum(['XYP', 'ATUT', 'DECLARED']),
  checkedAt: z.string().datetime(),
  owners: z.array(
    z.object({
      registerMasked: z.string(),
      name: z.string(),
      /** Хүсэлтийн оролцогчтой таарсан харилцагч (`customer.id`). */
      matchedCustomerId: z.string().nullable(),
      role: z.enum(['PRIMARY', 'CO_BORROWER', 'GUARANTOR', 'PLEDGOR']).nullable(),
    }),
  ),
  /** OWNER_NOT_ON_APPLICATION үед "Барьцаалагч бүртгэнэ үү" гэх мэт зөвлөмж. */
  message: z.string().nullable(),
  note: z.string().nullable(),
});
export type OwnershipCheck = z.infer<typeof OwnershipCheck>;

export const EncumbranceCheckView = z.object({
  status: z.enum(EncumbranceStatus),
  method: z.enum(['REGISTRY', 'DECLARED']),
  checkedAt: z.string().datetime(),
  /** DECLARED үед хоосон. */
  sources: z.array(z.object({ source: z.enum(['ZMS', 'EB']), status: z.string(), pledgee: z.string().nullable(), registeredAt: z.string().nullable(), note: z.string().nullable() })),
  note: z.string().nullable(),
});
export type EncumbranceCheckView = z.infer<typeof EncumbranceCheckView>;

export const ValuationSnapshot = z.object({
  valuationId: z.string(),
  source: z.enum(ValuationSource),
  valuedAt: z.string().datetime(),
  validUntil: z.string().datetime().nullable(),
  expired: z.boolean(),
  marketValue: z.number(),
  haircutRate: z.number(),
  collateralValue: z.number(),
  overrideReason: z.string().nullable(),
  externalRequired: z.boolean(),
  /** Гадны үнэлгээ заавал бөгөөд хийгдсэн эсэх (шаардлагагүй бол true). */
  externalSatisfied: z.boolean(),
});
export type ValuationSnapshot = z.infer<typeof ValuationSnapshot>;

export const CollateralOwnerView = z.object({
  customerId: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(['PRIMARY', 'CO_BORROWER', 'GUARANTOR', 'PLEDGOR']).nullable(),
});
export type CollateralOwnerView = z.infer<typeof CollateralOwnerView>;

export const CollateralView = z.object({
  id: z.string(),
  applicationId: z.string(),
  kind: z.string(),
  assetType: z.enum(AssetType),
  description: z.record(z.unknown()),
  source: z.enum(CollateralSource),
  owner: CollateralOwnerView,
  registryNo: z.string().nullable(),
  registryDate: IsoDate.nullable(),
  insuranceExpiresAt: IsoDate.nullable(),
  nextRevaluationAt: IsoDate.nullable(),
  releasedAt: z.string().datetime().nullable(),
  note: z.string().nullable(),
  ownership: OwnershipCheck.nullable(),
  encumbrance: EncumbranceCheckView.nullable(),
  valuation: ValuationSnapshot.nullable(),
  checklist: z.array(CollateralChecklistItem),
  /** Нэмэлт баримт/зураг (`other`). */
  extraDocuments: z.array(CollateralDocumentView),
  /** Энэ барьцаа G0-г хангаагүй шалтгаанууд. */
  issues: z.array(GateIssue),
  createdAt: z.string().datetime(),
});
export type CollateralView = z.infer<typeof CollateralView>;

export const CollateralWarningCode = ['IN_OTHER_DRAFT', 'INSURANCE_EXPIRING', 'REVALUATION_DUE', 'RELEASED'] as const;
export type CollateralWarningCode = (typeof CollateralWarningCode)[number];
export const CollateralWarning = z.object({ code: z.enum(CollateralWarningCode), collateralId: z.string(), message: z.string() });
export type CollateralWarning = z.infer<typeof CollateralWarning>;

export const CollateralListResponse = z.object({
  items: z.array(CollateralView),
  summary: CollateralSummary,
  gate: CollateralGate,
  warnings: z.array(CollateralWarning),
});
export type CollateralListResponse = z.infer<typeof CollateralListResponse>;

/** Өөрчлөлтийн хариу: өөрчлөгдсөн барьцаа + шинэ нийлбэр/хаалт (UI нэг дуудлагаар шинэчлэгдэнэ). */
export const CollateralMutationResponse = z.object({
  collateral: CollateralView,
  summary: CollateralSummary,
  gate: CollateralGate,
  warnings: z.array(CollateralWarning),
});
export type CollateralMutationResponse = z.infer<typeof CollateralMutationResponse>;

/** ХУР-аас татсан хөрөнгө — барьцаа үүсгэх урьдчилсан бөглөлт (FR-6.3). */
export const CollateralCandidate = z.object({
  xypRef: z.string(),
  assetType: z.enum(AssetType),
  label: z.string(),
  /** `CreateCollateralRequest.description`-д шууд хэрэглэх. */
  description: z.record(z.unknown()),
  /** Энэ хөрөнгө өөр идэвхтэй хүсэлтэд барьцаалагдсан эсвэл энэ хүсэлтэд бүртгэгдсэн. */
  alreadyPledged: z.boolean(),
});
export type CollateralCandidate = z.infer<typeof CollateralCandidate>;
export const CollateralCandidatesResponse = z.object({ items: z.array(CollateralCandidate), fetchedAt: z.string().datetime() });
export type CollateralCandidatesResponse = z.infer<typeof CollateralCandidatesResponse>;

/** Хугацаа дуусах / дахин үнэлэх барьцааны мониторинг (FR-6.9, FR-14.6). */
export const CollateralMonitoringItem = z.object({
  collateralId: z.string(),
  applicationId: z.string(),
  appNo: z.string(),
  assetType: z.enum(AssetType),
  label: z.string(),
  reasons: z.array(z.enum(['REVALUATION_DUE', 'INSURANCE_EXPIRING', 'INSURANCE_EXPIRED', 'LTV_BREACH'])),
  nextRevaluationAt: IsoDate.nullable(),
  insuranceExpiresAt: IsoDate.nullable(),
  ltv: z.number().nullable(),
  ltvLimit: z.number(),
});
export type CollateralMonitoringItem = z.infer<typeof CollateralMonitoringItem>;
export const CollateralMonitoringResponse = z.object({ items: z.array(CollateralMonitoringItem), asOf: z.string().datetime() });
export type CollateralMonitoringResponse = z.infer<typeof CollateralMonitoringResponse>;
