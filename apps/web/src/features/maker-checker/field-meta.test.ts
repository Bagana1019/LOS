import { describe, expect, it } from 'vitest';
import { BLACKLIST_FIELD_NAMES, fieldMeta, formatUnitValue, PRODUCT_FIELD_NAMES } from './field-meta';

// F8-3 / F9-5: diff-ийн талбарыг нэр + нэгжтэй харуулах (түлхүүр, утга нэгжгүй байсан).
describe('formatUnitValue', () => {
  it('money gets thousand separators and the ₮ sign', () => {
    expect(formatUnitValue('mnt', 5)).toBe('5₮');
    expect(formatUnitValue('mnt', 1234567)).toBe('1,234,567₮');
  });

  it('a 0..1 fraction is shown as a percent', () => {
    expect(formatUnitValue('ratio', 0.25)).toBe('25%');
    expect(formatUnitValue('ratio', 1)).toBe('100%');
    expect(formatUnitValue('ratio', 0.2399)).toBe('23.99%');
  });

  it('an annual rate is already a percent (0..100) and is not multiplied again', () => {
    expect(formatUnitValue('annualPercent', 24)).toBe('24%');
    expect(formatUnitValue('annualPercent', 24.5)).toBe('24.5%');
    expect(formatUnitValue('annualPercent', 100)).toBe('100%');
  });

  it('terms are in months, booleans are Тийм/Үгүй', () => {
    expect(formatUnitValue('months', 12)).toBe('12 сар');
    expect(formatUnitValue('yesNo', true)).toBe('Тийм');
    expect(formatUnitValue('yesNo', false)).toBe('Үгүй');
  });

  it('null / undefined read as "not set", not as the word null', () => {
    expect(formatUnitValue('ratio', null)).toBe('Заагаагүй');
    expect(formatUnitValue('mnt', undefined)).toBe('Заагаагүй');
  });

  it('blacklist codes use the Mongolian labels and fall back to the raw code when unknown', () => {
    expect(formatUnitValue('severity', 'GREY')).toBe('Саарал');
    expect(formatUnitValue('severity', 'BLACK')).toBe('Хар');
    expect(formatUnitValue('reason', 'FRAUD_CASE')).toBe('Залилангийн хэрэг');
    expect(formatUnitValue('reason', 'WEIRD_CODE')).toBe('WEIRD_CODE');
    expect(formatUnitValue('listType', 'DELINQUENT')).toBe('Зээлийн хугацаа хэтрэлт');
    expect(formatUnitValue('listType', 'NEW_LIST')).toBe('NEW_LIST');
  });

  it('a value of an unexpected type is shown as it is instead of crashing', () => {
    expect(formatUnitValue('mnt', 'abc')).toBe('abc');
    expect(formatUnitValue('yesNo', 'maybe')).toBe('maybe');
    expect(formatUnitValue('ratio', { a: 1 })).toBe('{"a":1}');
  });
});

describe('fieldMeta', () => {
  it('knows the product fields with their label and unit', () => {
    expect(fieldMeta('PRODUCT', 'maxLtv')).toEqual({ label: 'Дээд LTV', unit: 'ratio' });
    expect(fieldMeta('PRODUCT', 'minAmount')).toEqual({ label: 'Доод дүн', unit: 'mnt' });
    expect(fieldMeta('PRODUCT', 'maxRate')).toMatchObject({ unit: 'annualPercent' });
    expect(fieldMeta('PRODUCT', 'minTerm')).toMatchObject({ unit: 'months' });
    expect(fieldMeta('PRODUCT', 'isActive')).toMatchObject({ label: 'Идэвхтэй', unit: 'yesNo' });
  });

  it('nested haircut paths are labelled by the asset type and shown as a percent', () => {
    const meta = fieldMeta('PRODUCT', 'haircut.VEHICLE');
    expect(meta?.unit).toBe('ratio');
    expect(meta?.label).toContain('Тээврийн хэрэгсэл');
  });

  it('knows the blacklist fields', () => {
    expect(fieldMeta('BLACKLIST_ENTRY', 'severity')).toEqual({ label: 'Түвшин', unit: 'severity' });
    expect(fieldMeta('BLACKLIST_ENTRY', 'isActive')).toEqual({ label: 'Идэвхтэй', unit: 'yesNo' });
  });

  it('every known field has a Mongolian label (no raw i18n key leaks into the UI)', () => {
    for (const name of PRODUCT_FIELD_NAMES) expect(fieldMeta('PRODUCT', name)?.label, `PRODUCT ${name}`).not.toMatch(/^maker_checker\./);
    for (const name of BLACKLIST_FIELD_NAMES) expect(fieldMeta('BLACKLIST_ENTRY', name)?.label, `BLACKLIST ${name}`).not.toMatch(/^maker_checker\./);
  });

  it('returns null for an unknown path or target type (caller falls back to the raw path)', () => {
    expect(fieldMeta('PRODUCT', 'nope')).toBeNull();
    expect(fieldMeta('SETTING', 'maxLtv')).toBeNull();
    expect(fieldMeta('PRODUCT', 'constructor')).toBeNull();
    expect(fieldMeta('PRODUCT', '__proto__')).toBeNull();
  });
});
