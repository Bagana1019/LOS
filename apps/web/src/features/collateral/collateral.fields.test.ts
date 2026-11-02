import { describe, expect, it } from 'vitest';
import { AssetType, COLLATERAL_DESCRIPTION_SCHEMAS } from '@los/contracts';
import type { ZodTypeAny } from 'zod';
import { hasMessage } from '../../lib/i18n';
import { descriptionRows, describeCollateral, fieldLabelKey, FIELD_SPECS, formatFieldValue, formNamePath, getPath, optionLabelKey, setPath } from './collateral.fields';

/** ZodEffects (`.refine`) дотроос ZodObject-ийн shape-ийг гаргана. */
function shapeOf(schema: ZodTypeAny): Record<string, ZodTypeAny> {
  let s = schema;
  while (s._def.schema) s = s._def.schema as ZodTypeAny;
  return (s as unknown as { shape: Record<string, ZodTypeAny> }).shape;
}

/** Талбарын нэрийн бүрэн жагсаалт (`address.province` гэх мэт цэгтэй зам). */
function schemaPaths(schema: ZodTypeAny): string[] {
  return Object.entries(shapeOf(schema)).flatMap(([key, field]) => {
    let inner: ZodTypeAny = field;
    while (inner._def.innerType) inner = inner._def.innerType as ZodTypeAny;
    return inner._def.typeName === 'ZodObject' ? schemaPaths(inner).map((p) => `${key}.${p}`) : [key];
  });
}

describe('FIELD_SPECS нь гэрээний description схемтэй нийцнэ', () => {
  it.each(AssetType.map((a) => [a]))('%s: талбарын жагсаалт ижил', (assetType) => {
    const fromSchema = schemaPaths(COLLATERAL_DESCRIPTION_SCHEMAS[assetType]).sort();
    const fromSpecs = FIELD_SPECS[assetType].map((s) => s.name).sort();
    expect(fromSpecs).toEqual(fromSchema);
  });

  it('талбар бүр, сонголт бүр монгол шошготой', () => {
    for (const assetType of AssetType) {
      for (const spec of FIELD_SPECS[assetType]) {
        expect(hasMessage(fieldLabelKey(spec.name)), fieldLabelKey(spec.name)).toBe(true);
        if (spec.unitKey) expect(hasMessage(spec.unitKey), spec.unitKey).toBe(true);
        if (spec.extraKey) expect(hasMessage(spec.extraKey), spec.extraKey).toBe(true);
        if (spec.placeholderKey) expect(hasMessage(spec.placeholderKey), spec.placeholderKey).toBe(true);
        for (const option of spec.options ?? []) expect(hasMessage(optionLabelKey(spec, option)), optionLabelKey(spec, option)).toBe(true);
      }
    }
  });
});

describe('getPath / setPath / formNamePath', () => {
  it('цэгтэй замаар уншиж бичнэ', () => {
    const target: Record<string, unknown> = {};
    setPath(target, 'address.province', 'Улаанбаатар');
    setPath(target, 'address.district', 'Хан-Уул');
    setPath(target, 'areaM2', 40);
    expect(target).toEqual({ address: { province: 'Улаанбаатар', district: 'Хан-Уул' }, areaM2: 40 });
    expect(getPath(target, 'address.district')).toBe('Хан-Уул');
    expect(getPath(target, 'address.khoroo')).toBeUndefined();
    expect(getPath(undefined, 'a.b')).toBeUndefined();
    expect(getPath({ a: 5 }, 'a.b')).toBeUndefined();
  });
  it('скаляр дээр зам үүсгэхэд скалярыг объектоор солино', () => {
    const target: Record<string, unknown> = { address: 'text' };
    setPath(target, 'address.province', 'X');
    expect(target).toEqual({ address: { province: 'X' } });
  });
  it('antd name нь description угтвартай', () => {
    expect(formNamePath('address.province')).toEqual(['description', 'address', 'province']);
    expect(formNamePath('plateNo')).toEqual(['description', 'plateNo']);
  });
});

describe('describeCollateral (нэг мөр тодорхойлолт)', () => {
  it('автомашин: марк загвар · он · дугаар', () => {
    expect(describeCollateral('VEHICLE', { plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012 })).toBe('Toyota Prius · 2012 он · 1234УБА');
  });
  it('орон сууц: дүүрэг, хороо, хаяг · талбай · давхар', () => {
    const line = describeCollateral('APARTMENT', { address: { province: 'Улаанбаатар', district: 'Хан-Уул', khoroo: '11-р хороо', detail: '15-р байр' }, areaM2: 56.5, floor: 4 });
    expect(line).toBe('Хан-Уул, 11-р хороо, 15-р байр · 56.5 м² · 4-р давхар');
  });
  it('газар: зориулалтыг монголоор', () => {
    expect(describeCollateral('LAND', { address: { province: 'Улаанбаатар', district: 'Налайх' }, areaM2: 700, landUse: 'RESIDENTIAL' })).toBe('Налайх · 700 м² · Оршин суух');
  });
  it('мал: төрөл (нас) · толгой', () => {
    expect(describeCollateral('LIVESTOCK', { livestockType: 'HORSE', ageGroup: 'ADULT', headCount: 1200 })).toBe('Адуу (Том мал) · 1,200 толгой');
  });
  it('бараа, тоног төхөөрөмж, бусад', () => {
    expect(describeCollateral('INVENTORY', { name: 'Хүнсний бараа', location: 'Сүхбаатар дүүрэг' })).toBe('Хүнсний бараа · Сүхбаатар дүүрэг');
    expect(describeCollateral('EQUIPMENT', { name: 'Зуух', make: 'LG', model: 'X1', serialNo: 'SN-1' })).toBe('Зуух · LG X1 · SN-1');
    expect(describeCollateral('OTHER', { name: 'Тавилга' })).toBe('Тавилга');
  });
  it('хоосон тодорхойлолтод хөрөнгийн төрлийн нэр', () => {
    expect(describeCollateral('VEHICLE', {})).toBe('Тээврийн хэрэгсэл');
    expect(describeCollateral('OTHER', {})).toBe('Бусад');
  });
  it('тоо биш/хоосон мөрийг тоолохгүй', () => {
    expect(describeCollateral('VEHICLE', { make: '  ', model: 'Prius', manufactureYear: 'x' })).toBe('Prius');
  });
});

describe('descriptionRows / formatFieldValue', () => {
  it('утгатай талбарыг л үзүүлнэ; showEmpty үед «—»', () => {
    const rows = descriptionRows('VEHICLE', { plateNo: '1234УБА', make: 'Toyota', model: 'Prius', manufactureYear: 2012, mileageKm: 150000, fuelType: 'HYBRID' });
    expect(rows.map((r) => r.name)).toEqual(['plateNo', 'make', 'model', 'manufactureYear', 'mileageKm', 'fuelType']);
    expect(rows.find((r) => r.name === 'mileageKm')).toMatchObject({ label: 'Гүйлт', value: '150,000 км' });
    expect(rows.find((r) => r.name === 'fuelType')?.value).toBe('Хайбрид');
    expect(rows.find((r) => r.name === 'manufactureYear')?.value).toBe('2012'); // он: мянгатын таслалгүй
    const all = descriptionRows('VEHICLE', { plateNo: '1234УБА' }, true);
    expect(all).toHaveLength(FIELD_SPECS.VEHICLE.length);
    expect(all.find((r) => r.name === 'vin')?.value).toBe('—');
  });
  it('мөнгө, нэгж, огноо', () => {
    const money = FIELD_SPECS.INVENTORY.find((s) => s.name === 'stocktakeValue')!;
    expect(formatFieldValue(money, 8_000_000)).toBe('8,000,000₮');
    expect(formatFieldValue(money, 'x')).toBeNull();
    const area = FIELD_SPECS.APARTMENT.find((s) => s.name === 'areaM2')!;
    expect(formatFieldValue(area, 56.5)).toBe('56.5 м²');
    expect(formatFieldValue(area, 56)).toBe('56 м²');
    const date = FIELD_SPECS.INVENTORY.find((s) => s.name === 'stocktakeDate')!;
    expect(formatFieldValue(date, '2026-10-20')).toBe('2026-10-20');
    expect(formatFieldValue(date, '')).toBeNull();
  });
});
