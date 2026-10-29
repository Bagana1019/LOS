import { LandUse, LivestockAgeGroup, LivestockType, RealtyPurpose, VehicleFuelType, type AssetType } from '@los/contracts';
import { EMPTY_VALUE, formatMnt, formatNumber } from '../../lib/format';
import { t } from '../../lib/i18n';

// Хөрөнгийн төрөл бүрийн description талбарын НЭГ тодорхойлолт: форм (CollateralFormFields), дэлгэрэнгүй (descriptionRows), нэг мөр хураангуй (describeCollateral)
// гурвуулаа үүнийг хэрэглэнэ. Талбарын нэр/дүрмийн эх сурвалж нь `@los/contracts` COLLATERAL_DESCRIPTION_SCHEMAS (FR-6.1); эндхийн жагсаалт зөвхөн харагдац.

export type FieldKind = 'text' | 'integer' | 'decimal' | 'money' | 'select' | 'date' | 'textarea';

export interface FieldSpec {
  /** Цэгээр бүлэглэсэн зам: `address.province`. */
  name: string;
  kind: FieldKind;
  /** Харагдацын од (*) — шалгалтыг zod схем хийнэ. */
  required?: boolean;
  options?: readonly string[];
  /** Сонголтын i18n угтвар: `collateral.fuelType.` + утга. */
  optionPrefix?: string;
  unitKey?: string;
  maxLength?: number;
  placeholderKey?: string;
  /** Талбарын доорх тайлбарын i18n түлхүүр. */
  extraKey?: string;
  /** Бүтэн өргөн (хоёр баганыг эзэлнэ). */
  wide?: boolean;
  /** Мянгатын таслалгүй (он, дугаар). */
  plain?: boolean;
}

const ADDRESS: FieldSpec[] = [
  { name: 'address.province', kind: 'text', required: true, maxLength: 60 },
  { name: 'address.district', kind: 'text', required: true, maxLength: 60 },
  { name: 'address.khoroo', kind: 'text', maxLength: 40 },
  { name: 'address.detail', kind: 'text', maxLength: 200, wide: true },
];
const REALTY_ID: FieldSpec[] = [
  { name: 'propertyId', kind: 'text', maxLength: 60, extraKey: 'collateral.field.realtyIdHint' },
  { name: 'certificateNo', kind: 'text', maxLength: 60 },
];
const PURPOSE: FieldSpec = { name: 'purpose', kind: 'select', options: RealtyPurpose, optionPrefix: 'collateral.purpose.' };

export const FIELD_SPECS: Record<AssetType, readonly FieldSpec[]> = {
  VEHICLE: [
    { name: 'plateNo', kind: 'text', required: true, maxLength: 12, placeholderKey: 'collateral.field.plateNo.placeholder' },
    { name: 'vin', kind: 'text', maxLength: 30 },
    { name: 'make', kind: 'text', required: true, maxLength: 60 },
    { name: 'model', kind: 'text', required: true, maxLength: 60 },
    { name: 'manufactureYear', kind: 'integer', plain: true, required: true },
    { name: 'importYear', kind: 'integer', plain: true },
    { name: 'mileageKm', kind: 'integer', unitKey: 'collateral.unit.km' },
    { name: 'engineCc', kind: 'integer', unitKey: 'collateral.unit.cc' },
    { name: 'fuelType', kind: 'select', options: VehicleFuelType, optionPrefix: 'collateral.fuelType.' },
    { name: 'color', kind: 'text', maxLength: 40 },
  ],
  APARTMENT: [
    ...REALTY_ID,
    ...ADDRESS,
    { name: 'areaM2', kind: 'decimal', required: true, unitKey: 'collateral.unit.m2' },
    { name: 'floor', kind: 'integer' },
    { name: 'totalFloors', kind: 'integer' },
    { name: 'rooms', kind: 'integer' },
    { name: 'buildYear', kind: 'integer', plain: true },
    PURPOSE,
  ],
  HOUSE: [
    ...REALTY_ID,
    ...ADDRESS,
    { name: 'areaM2', kind: 'decimal', required: true, unitKey: 'collateral.unit.m2' },
    { name: 'landAreaM2', kind: 'decimal', unitKey: 'collateral.unit.m2' },
    { name: 'floors', kind: 'integer' },
    { name: 'buildYear', kind: 'integer', plain: true },
    PURPOSE,
  ],
  LAND: [
    ...REALTY_ID,
    ...ADDRESS,
    { name: 'areaM2', kind: 'decimal', required: true, unitKey: 'collateral.unit.m2' },
    { name: 'landUse', kind: 'select', options: LandUse, optionPrefix: 'collateral.landUse.' },
  ],
  LIVESTOCK: [
    { name: 'livestockType', kind: 'select', required: true, options: LivestockType, optionPrefix: 'collateral.livestockType.' },
    { name: 'ageGroup', kind: 'select', options: LivestockAgeGroup, optionPrefix: 'collateral.ageGroup.' },
    { name: 'headCount', kind: 'integer', required: true, unitKey: 'collateral.unit.head' },
    { name: 'location', kind: 'text', maxLength: 200, wide: true },
  ],
  INVENTORY: [
    { name: 'name', kind: 'text', required: true, maxLength: 200, wide: true },
    { name: 'stocktakeValue', kind: 'money', required: true, extraKey: 'collateral.field.stocktakeValueHint' },
    { name: 'stocktakeDate', kind: 'date', required: true },
    { name: 'location', kind: 'text', maxLength: 200, wide: true },
  ],
  EQUIPMENT: [
    { name: 'name', kind: 'text', required: true, maxLength: 200, wide: true },
    { name: 'make', kind: 'text', maxLength: 60 },
    { name: 'model', kind: 'text', maxLength: 60 },
    { name: 'serialNo', kind: 'text', maxLength: 60, extraKey: 'collateral.field.serialNoHint' },
    { name: 'manufactureYear', kind: 'integer', plain: true },
    { name: 'purchasePrice', kind: 'money' },
  ],
  OTHER: [
    { name: 'name', kind: 'text', required: true, maxLength: 200, wide: true },
    { name: 'details', kind: 'textarea', maxLength: 1000, wide: true },
  ],
};

export const fieldLabelKey = (name: string): string => `collateral.field.${name}`;
export const optionLabelKey = (spec: FieldSpec, value: string): string => `${spec.optionPrefix ?? ''}${value}`;
/** antd Form.Item name: `address.province` → ['description', 'address', 'province']. */
export const formNamePath = (name: string): string[] => ['description', ...name.split('.')];

// ── зам унших/бичих (цэгээр) ─────────────────────────────────────────────────────────────
export function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source);
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (next === null || typeof next !== 'object') cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1] as string] = value;
}

const asText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Бүхэл тоог мянгатын таслалтай, бутархайг (м²) алдалгүй. */
const plainNumber = (n: number): string => (Number.isInteger(n) ? formatNumber(n) : String(n));

// ── нэг мөр хураангуй (жагсаалтын карт) ───────────────────────────────────────────────────
const join = (parts: Array<string | null | undefined>, sep = ' · '): string => parts.filter((p): p is string => !!p).join(sep);
const label = (prefix: string, value: unknown): string | null => {
  const v = asText(value);
  return v ? t(`${prefix}${v}`) : null;
};

/** Хөрөнгийн төрлөөр нэг мөр тодорхойлолт: «Toyota Prius · 2012 он · 1234УБА». Хоосон бол төрлийн нэр. */
export function describeCollateral(assetType: AssetType, description: Record<string, unknown>): string {
  const d = description;
  const area = asNumber(d.areaM2);
  const areaText = area !== null ? t('collateral.line.area', { value: plainNumber(area) }) : null;
  const addressLine = join([asText(getPath(d, 'address.district')), asText(getPath(d, 'address.khoroo')), asText(getPath(d, 'address.detail'))], ', ');
  const line = (() => {
    switch (assetType) {
      case 'VEHICLE': {
        const year = asNumber(d.manufactureYear);
        return join([join([asText(d.make), asText(d.model)], ' '), year !== null ? t('collateral.line.year', { year }) : null, asText(d.plateNo)]);
      }
      case 'APARTMENT': {
        const floor = asNumber(d.floor);
        return join([addressLine, areaText, floor !== null ? t('collateral.line.floor', { floor }) : null]);
      }
      case 'HOUSE':
        return join([addressLine, areaText]);
      case 'LAND':
        return join([addressLine, areaText, label('collateral.landUse.', d.landUse)]);
      case 'LIVESTOCK': {
        const heads = asNumber(d.headCount);
        const type = label('collateral.livestockType.', d.livestockType);
        const age = label('collateral.ageGroup.', d.ageGroup);
        return join([type && age ? `${type} (${age})` : type, heads !== null ? t('collateral.line.heads', { count: formatNumber(heads) }) : null]);
      }
      case 'INVENTORY':
        return join([asText(d.name), asText(d.location)]);
      case 'EQUIPMENT':
        return join([asText(d.name), join([asText(d.make), asText(d.model)], ' '), asText(d.serialNo)]);
      case 'OTHER':
        return asText(d.name) ?? '';
    }
  })();
  return line || t(`collateral.assetType.${assetType}`);
}

// ── дэлгэрэнгүй мөрүүд ───────────────────────────────────────────────────────────────────
export interface DescriptionRow {
  name: string;
  label: string;
  value: string;
}

export function formatFieldValue(spec: FieldSpec, raw: unknown): string | null {
  switch (spec.kind) {
    case 'money': {
      const n = asNumber(raw);
      return n === null ? null : formatMnt(n);
    }
    case 'integer':
    case 'decimal': {
      const n = asNumber(raw);
      if (n === null) return null;
      const text = spec.plain ? String(n) : plainNumber(n);
      return spec.unitKey ? `${text} ${t(spec.unitKey)}` : text;
    }
    case 'select': {
      const v = asText(raw);
      return v ? t(optionLabelKey(spec, v)) : null;
    }
    default:
      return asText(raw);
  }
}

/** Дэлгэрэнгүй самбарын «Талбар: утга» мөрүүд. Утгагүй талбарыг алгасна (`showEmpty` үед «—»). */
export function descriptionRows(assetType: AssetType, description: Record<string, unknown>, showEmpty = false): DescriptionRow[] {
  return FIELD_SPECS[assetType].flatMap((spec) => {
    const value = formatFieldValue(spec, getPath(description, spec.name));
    if (value === null && !showEmpty) return [];
    return [{ name: spec.name, label: t(fieldLabelKey(spec.name)), value: value ?? EMPTY_VALUE }];
  });
}
