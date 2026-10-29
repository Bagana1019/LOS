// FR-14.1–14.3 · Барьцааны зах зээлийн үнийн санал (суурь үнэ × коэффициент), haircut-ийн эрэмбэ, хүчинтэй хугацаа, гадны үнэлгээний босго, override шалтгаан.
// Цэвэр функц: I/O, цаг, DB байхгүй. Коэффициент, элэгдэл, haircut-ийн анхдагч бүгд `CollateralPricingParams` аргументаар ирнэ —
// функц дотор бизнесийн утга hardcode хийхгүй (CLAUDE.md §6.2). Мөнгөн дүн ₮, 2 орноор (ROUND_HALF_UP) бөөрөнхийлнө.
// Эцсийн барьцааны үнэлгээ = зах зээлийн үнэ × haircut → `collateralValue` (ltv.ts).
import Decimal from 'decimal.js';
import type { AssetType, HaircutResolution, LandUse, RealtyPurpose } from '@los/contracts';
import { diffDays } from './aging';

const MS_PER_DAY = 86_400_000;
const KM_PER_MILEAGE_STEP = 10_000;

// ── Параметр ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Автомашины суурь үнэ → зах зээлийн үнэ (FR-14.1): суурь үнэ × (1 − элэгдэл(нас)) × (1 − гүйлтийн хасалт). */
export interface VehiclePricingParams {
  /** Нэг насанд хасагдах хувь (0.03 = суурь үнийн 3%). */
  annualDepreciationRate: number;
  /** Нийт элэгдлийн дээд хязгаар (0.5 → үнэ суурь үнийн 50%-иас доошгүй). */
  maxDepreciation: number;
  /** Жилд хасалтгүй гүйлт, км. Хэтэрсэн км-ээс хасалт тооцно. */
  freeMileageKmPerYear: number;
  /** Хэтэрсэн 10 000 км тутамд хасагдах хувь (0.01 = 1%). */
  mileageDeductionPer10kKm: number;
  /** Гүйлтийн хасалтын дээд хязгаар. */
  maxMileageDeduction: number;
}

export interface RealtyFloorCoefficients {
  basement: number; // давхар < 1 (зоорь, хагас зоорь)
  ground: number; // 1-р давхар
  middle: number; // завсрын давхар (мөн давхар мэдэгдэхгүй үед)
  top: number; // сүүлийн давхар
}

/** Барилгын насны зэрэг: `maxAgeYears` нас хүртэл (оруулан). `null` = үлдсэн бүх нас (заавал сүүлийн зэрэг). Өсөх дарааллаар. */
export interface BuildingAgeBand {
  maxAgeYears: number | null;
  coefficient: number;
}

export interface RealtyPricingParams {
  floor: RealtyFloorCoefficients;
  purpose: Record<RealtyPurpose, number>;
  buildingAge: { bands: readonly BuildingAgeBand[]; unknownCoefficient: number };
}

export interface LandPricingParams {
  landUse: Record<LandUse, number>;
}

export interface CollateralPricingParams {
  vehicle: VehiclePricingParams;
  realty: RealtyPricingParams;
  land: LandPricingParams;
  /** Суурь үнийн `validFrom` энэ хоногоос хуучирвал `BASE_PRICE_STALE` анхааруулга. */
  basePriceStaleDays: number;
  /** haircut-ийн эцсийн нөөц (`DEMO_DEFAULT`): хөрөнгийн төрөл бүрээр, 0…1. */
  defaultHaircuts: Record<AssetType, number>;
}

// ── Тусгаарлагч ───────────────────────────────────────────────────────────────────────────────────────────────────

/** 2 орноор бөөрөнхийлнө (ROUND_HALF_UP). */
export const round2 = (n: number): number => new Decimal(n).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();

/** Хоёр дүн 2 орноор бөөрөнхийлсний дараа тэнцүү эсэх. */
export const sameValue = (a: number, b: number): boolean => round2(a) === round2(b);

function need(value: number, name: string, min: 'positive' | 'nonnegative'): number {
  if (!Number.isFinite(value) || (min === 'positive' ? value <= 0 : value < 0)) throw new RangeError(`${name} must be a finite ${min} number`);
  return value;
}

const product = (...factors: number[]): number => round2(factors.reduce((acc, f) => acc.mul(f), new Decimal(1)).toNumber());

// ── Автомашин (VEHICLE_BASE_PRICE) ────────────────────────────────────────────────────────────────────────────────

export const vehicleAgeYears = (manufactureYear: number, valuationYear: number): number => Math.max(0, valuationYear - manufactureYear);

/** Элэгдлийн хувь = min(дээд хязгаар, жилийн хувь × нас). */
export function vehicleDepreciationRate(ageYears: number, p: VehiclePricingParams): number {
  return Decimal.min(new Decimal(p.annualDepreciationRate).mul(ageYears), p.maxDepreciation).toNumber();
}

/** Гүйлтийн хасалт: (гүйлт − жилийн хасалтгүй гүйлт × max(нас, 1)) хэтэрсэн хэсгээс. Гүйлт мэдэгдэхгүй (`null`) бол хасалтгүй. */
export function mileageDeduction(mileageKm: number | null, ageYears: number, p: VehiclePricingParams): { rate: number; excessKm: number } {
  if (mileageKm === null) return { rate: 0, excessKm: 0 };
  const allowance = p.freeMileageKmPerYear * Math.max(1, ageYears);
  const excessKm = Math.max(0, mileageKm - allowance);
  const rate = Decimal.min(new Decimal(excessKm).div(KM_PER_MILEAGE_STEP).mul(p.mileageDeductionPer10kKm), p.maxMileageDeduction).toNumber();
  return { rate, excessKm };
}

export interface VehicleBasePriceInput {
  /** Марк/загвар/оны суурь үнэ (base_price.unit_price). */
  basePrice: number;
  manufactureYear: number;
  /** Үнэлгээний он (дуудагч цагаас гаргана). */
  valuationYear: number;
  mileageKm: number | null;
}

export interface VehicleBasePriceResult {
  marketValue: number;
  ageYears: number;
  depreciationRate: number;
  mileageDeductionRate: number;
  excessMileageKm: number;
}

export function vehicleBasePriceValue(input: VehicleBasePriceInput, p: VehiclePricingParams): VehicleBasePriceResult {
  need(input.basePrice, 'basePrice', 'positive');
  if (input.mileageKm !== null) need(input.mileageKm, 'mileageKm', 'nonnegative');
  const ageYears = vehicleAgeYears(input.manufactureYear, input.valuationYear);
  const depreciationRate = vehicleDepreciationRate(ageYears, p);
  const { rate: mileageDeductionRate, excessKm } = mileageDeduction(input.mileageKm, ageYears, p);
  const marketValue = product(input.basePrice, new Decimal(1).minus(depreciationRate).toNumber(), new Decimal(1).minus(mileageDeductionRate).toNumber());
  return { marketValue, ageYears, depreciationRate, mileageDeductionRate, excessMileageKm: excessKm };
}

// ── Үл хөдлөх: орон сууц, байшин (REALTY_BASE_PRICE), газар (LAND_BASE_PRICE) ────────────────────────────────────────────

export type FloorPosition = 'BASEMENT' | 'GROUND' | 'MIDDLE' | 'TOP' | 'UNKNOWN';

export function floorCoefficient(floor: number | null, totalFloors: number | null, p: RealtyFloorCoefficients): { position: FloorPosition; coefficient: number } {
  if (floor === null) return { position: 'UNKNOWN', coefficient: p.middle };
  if (floor < 1) return { position: 'BASEMENT', coefficient: p.basement };
  if (floor === 1) return { position: 'GROUND', coefficient: p.ground };
  if (totalFloors !== null && totalFloors > 1 && floor >= totalFloors) return { position: 'TOP', coefficient: p.top };
  return { position: 'MIDDLE', coefficient: p.middle };
}

/** Барилгын насны коэффициент. `buildYear` мэдэгдэхгүй бол `unknownCoefficient`. Зэрэг тохирохгүй (catch-all алга) бол тохиргооны алдаа. */
export function buildingAgeCoefficient(buildYear: number | null, valuationYear: number, p: RealtyPricingParams['buildingAge']): { ageYears: number | null; coefficient: number } {
  if (buildYear === null) return { ageYears: null, coefficient: p.unknownCoefficient };
  const ageYears = Math.max(0, valuationYear - buildYear);
  const band = p.bands.find((b) => b.maxAgeYears === null || ageYears <= b.maxAgeYears);
  if (!band) throw new RangeError('buildingAge.bands must end with a band whose maxAgeYears is null');
  return { ageYears, coefficient: band.coefficient };
}

export interface RealtyValueInput {
  assetType: 'APARTMENT' | 'HOUSE';
  /** ₮/м² (base_price.unit_price). */
  unitPrice: number;
  areaM2: number;
  /** Зөвхөн APARTMENT-д. */
  floor: number | null;
  totalFloors: number | null;
  purpose: RealtyPurpose;
  buildYear: number | null;
  valuationYear: number;
}

export interface RealtyValueResult {
  marketValue: number;
  floorPosition: FloorPosition | 'NOT_APPLICABLE';
  floorCoefficient: number;
  purposeCoefficient: number;
  buildingAgeYears: number | null;
  buildingAgeCoefficient: number;
}

/** м² суурь үнэ × талбай × давхрын × зориулалтын × барилгын насны коэффициент. Давхрын коэффициент зөвхөн орон сууцанд (байшинд 1). */
export function realtyValue(input: RealtyValueInput, p: RealtyPricingParams): RealtyValueResult {
  need(input.unitPrice, 'unitPrice', 'positive');
  need(input.areaM2, 'areaM2', 'positive');
  const floor = input.assetType === 'APARTMENT' ? floorCoefficient(input.floor, input.totalFloors, p.floor) : { position: 'NOT_APPLICABLE' as const, coefficient: 1 };
  const purposeCoef = p.purpose[input.purpose];
  const age = buildingAgeCoefficient(input.buildYear, input.valuationYear, p.buildingAge);
  return {
    marketValue: product(input.unitPrice, input.areaM2, floor.coefficient, purposeCoef, age.coefficient),
    floorPosition: floor.position,
    floorCoefficient: floor.coefficient,
    purposeCoefficient: purposeCoef,
    buildingAgeYears: age.ageYears,
    buildingAgeCoefficient: age.coefficient,
  };
}

export interface LandValueInput {
  /** ₮/м². */
  unitPrice: number;
  areaM2: number;
  landUse: LandUse;
}

/** м² суурь үнэ × талбай × зориулалтын коэффициент. */
export function landValue(input: LandValueInput, p: LandPricingParams): { marketValue: number; landUseCoefficient: number } {
  need(input.unitPrice, 'unitPrice', 'positive');
  need(input.areaM2, 'areaM2', 'positive');
  const landUseCoefficient = p.landUse[input.landUse];
  return { marketValue: product(input.unitPrice, input.areaM2, landUseCoefficient), landUseCoefficient };
}

// ── Мал (LIVESTOCK_UNIT_PRICE) ────────────────────────────────────────────────────────────────────────────────────

/** Нэгж үнэ (төрөл, нас) × тоо толгой. */
export function livestockValue(input: { unitPrice: number; headCount: number }): number {
  need(input.unitPrice, 'unitPrice', 'positive');
  need(input.headCount, 'headCount', 'positive');
  return product(input.unitPrice, input.headCount);
}

// ── Haircut, хүчинтэй хугацаа, гадны үнэлгээ, override ───────────────────────────────────────────────────────────────

export interface HaircutCandidates {
  /** `haircut_rule(product, assetType)` */
  productRule?: number | null;
  /** `product.haircut_json[assetType]` */
  productJson?: number | null;
  /** `haircut_rule(null, assetType)` */
  orgRule?: number | null;
  /** DEMO нөөц (`CollateralPricingParams.defaultHaircuts[assetType]`). */
  demoDefault: number;
}

const validRate = (r: number | null | undefined): r is number => typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 1;

/** FR-14.2 · эрэмбэ: PRODUCT_RULE > PRODUCT_JSON > ORG_RULE > DEMO_DEFAULT. 0…1-ээс гадуурх/тоо биш утгыг алгасна; нөөц буруу бол тохиргооны алдаа. */
export function resolveHaircut(c: HaircutCandidates): HaircutResolution {
  if (validRate(c.productRule)) return { rate: c.productRule, source: 'PRODUCT_RULE' };
  if (validRate(c.productJson)) return { rate: c.productJson, source: 'PRODUCT_JSON' };
  if (validRate(c.orgRule)) return { rate: c.orgRule, source: 'ORG_RULE' };
  if (!validRate(c.demoDefault)) throw new RangeError('demoDefault haircut must be a number between 0 and 1');
  return { rate: c.demoDefault, source: 'DEMO_DEFAULT' };
}

/** FR-14.3 · хүчинтэй хугацаа = үнэлсэн огноо + хоног (24 цаг × хоног). */
export function validUntilFrom(valuedAt: Date, validityDays: number): Date {
  if (!Number.isInteger(validityDays) || validityDays <= 0) throw new RangeError('validityDays must be a positive integer');
  return new Date(valuedAt.getTime() + validityDays * MS_PER_DAY);
}

/** FR-14.3 · зах зээлийн үнэ ≥ босго бол гадны лицензтэй үнэлгээ заавал. Босго `null` бол шаардахгүй. */
export const requiresExternalValuation = (marketValue: number, threshold: number | null | undefined): boolean =>
  typeof threshold === 'number' && marketValue >= threshold;

/**
 * FR-14.2 · гараар засахад шалтгаан заавал: гараар оруулдаг төрөл (бараа, тоног төхөөрөмж, бусад) биш бөгөөд
 * (систем санал өгөөгүй (`suggestedValue = null`) эсвэл эцсийн дүн саналаас 2 орноор бөөрөнхийлсний дараа ялгаатай).
 */
export function needsOverrideReason(input: { manualValueAsset: boolean; suggestedValue: number | null; finalValue: number }): boolean {
  if (input.manualValueAsset) return false;
  return input.suggestedValue === null || !sameValue(input.suggestedValue, input.finalValue);
}

/** Суурь үнийн `validFrom` (YYYY-MM-DD) `asOf`-оос `maxAgeDays`-ээс илүү хоногоор хуучирсан эсэх. */
export const isBasePriceStale = (validFrom: string, asOf: string, maxAgeDays: number): boolean => diffDays(validFrom, asOf) > maxAgeDays;
