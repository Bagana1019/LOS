import { z } from 'zod';
import { AssetType, EncumbranceStatus } from '../enums';
import { normalizeRegisterNo } from '../customer';
import { LandUse, RealtyAddress, RealtyPurpose } from './collateral';
import { PlateNo, VehicleFuelType } from './valuation';

// ── kyc: ХУР-аас хөрөнгө татах (FR-6.3), ачаалал шалгах ЗМС/ЭБ (FR-6.6) — origination → kyc (sync REST) ───────────────────────
// Бодит холболт хараахан байхгүй (INTEGRATION_MODE=real → 501); mock нь deterministic DEMO fixture. Регистр, өмчлөгчийн нэр нь зөвхөн дуудагчид
// буцна — kyc лог, DB-д хадгалахгүй.

export const XypAssetsRequest = z.object({ registerNo: z.string().trim().min(1).transform(normalizeRegisterNo) });
export type XypAssetsRequest = z.infer<typeof XypAssetsRequest>;

export const XypPropertyOwner = z.object({ registerNo: z.string(), name: z.string(), sharePercent: z.number().min(0).max(100).nullable() });
export type XypPropertyOwner = z.infer<typeof XypPropertyOwner>;

/** ХУР-ын үл хөдлөх хөрөнгийн өмчлөх эрхийн бүртгэл. */
export const XypPropertyAsset = z.object({
  propertyId: z.string(),
  certificateNo: z.string().nullable(),
  assetType: z.enum(['APARTMENT', 'HOUSE', 'LAND']),
  address: RealtyAddress,
  areaM2: z.number().positive(),
  floor: z.number().int().nullable(),
  totalFloors: z.number().int().nullable(),
  rooms: z.number().int().nullable(),
  buildYear: z.number().int().nullable(),
  purpose: z.enum(RealtyPurpose).nullable(),
  landUse: z.enum(LandUse).nullable(),
  owners: z.array(XypPropertyOwner).min(1),
});
export type XypPropertyAsset = z.infer<typeof XypPropertyAsset>;

export const XypVehicleAsset = z.object({
  plateNo: PlateNo,
  vin: z.string().nullable(),
  make: z.string(),
  model: z.string(),
  manufactureYear: z.number().int(),
  importYear: z.number().int().nullable(),
  engineCc: z.number().int().nullable(),
  fuelType: z.enum(VehicleFuelType).nullable(),
  color: z.string().nullable(),
});
export type XypVehicleAsset = z.infer<typeof XypVehicleAsset>;

/** `POST /api/xyp/assets` — регистрийн эзэмшлийн хөрөнгө (үл хөдлөх + тээвэр). */
export const XypAssetsResponse = z.object({ properties: z.array(XypPropertyAsset), vehicles: z.array(XypVehicleAsset), fetchedAt: z.string().datetime() });
export type XypAssetsResponse = z.infer<typeof XypAssetsResponse>;

/** `POST /api/xyp/property` — өмчлөх эрхийн дугаараар өмчлөгчдийг тулгах (FR-6.5). Олдохгүй бол 404 `XYP_NOT_FOUND`. */
export const XypPropertyRequest = z.object({ propertyId: z.string().trim().min(1).max(60) });
export type XypPropertyRequest = z.infer<typeof XypPropertyRequest>;

// ── Ачаалал шалгалт: ЗМС (зээлийн мэдээллийн сан) + ЭБ (барьцаа хөрөнгийн бүртгэл) ────────────────────────────────────────────
export const EncumbranceSourceId = ['ZMS', 'EB'] as const;
export type EncumbranceSourceId = (typeof EncumbranceSourceId)[number];
export const EncumbranceSourceStatus = ['CLEAR', 'ENCUMBERED', 'DISPUTED', 'NOT_APPLICABLE'] as const;
export type EncumbranceSourceStatus = (typeof EncumbranceSourceStatus)[number];

/** `identifier` = VEHICLE → улсын дугаар; APARTMENT/HOUSE/LAND → өмчлөх эрхийн дугаар; EQUIPMENT → серийн дугаар. Бусад төрөлд ачаалал шалгах бүртгэлгүй (422). */
export const EncumbranceCheckRequest = z.object({
  assetType: z.enum(AssetType),
  identifier: z.string().trim().min(1).max(100),
});
export type EncumbranceCheckRequest = z.infer<typeof EncumbranceCheckRequest>;

export const EncumbranceSourceResult = z.object({
  source: z.enum(EncumbranceSourceId),
  status: z.enum(EncumbranceSourceStatus),
  pledgee: z.string().nullable(),
  registeredAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type EncumbranceSourceResult = z.infer<typeof EncumbranceSourceResult>;

/** Нэгдсэн дүгнэлт: DISPUTED > ENCUMBERED > CLEAR. Аль нэг эх сурвалж унавал үр дүн "цэвэр" гэж буцахгүй — 503 `ENCUMBRANCE_UNAVAILABLE` (fail closed). */
export const EncumbranceCheckResult = z.object({
  status: z.enum(EncumbranceStatus),
  sources: z.array(EncumbranceSourceResult),
  checkedAt: z.string().datetime(),
});
export type EncumbranceCheckResult = z.infer<typeof EncumbranceCheckResult>;
