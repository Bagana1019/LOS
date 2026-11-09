import { describe, expect, it } from 'vitest';
import type { ProductAdminDto } from '@los/contracts';
import { EMPTY_FORM, formToProduct, productToForm, type ProductFormValues } from './product-form';

const valid: ProductFormValues = {
  ...EMPTY_FORM, code: 'SME_PLUS', productType: 'BUSINESS', name: 'ЖДҮ+',
  minAmount: 1_000_000, maxAmount: 80_000_000, minTerm: 3, maxTerm: 36, minRate: 20, maxRate: 38, defaultFeeRate: 0.0125,
  requiresCollateral: true, maxLtv: 0.65, haircut: { VEHICLE: 0.7, LAND: null },
  documentChecklist: [{ key: 'application_form', name: 'Маягт' }],
};

describe('formToProduct', () => {
  it('зөв формыг API body болгоно: хоосон → null, haircut-ийн хоосон хөрөнгө хасагдана, баримт default required', () => {
    const r = formToProduct(valid, 'create');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({
      code: 'SME_PLUS', currency: 'MNT', maxDti: null, haircut: { VEHICLE: 0.7 }, collateralChecklist: null,
      documentChecklist: [{ key: 'application_form', name: 'Маягт', required: true }],
    });
  });

  it('шинэчлэхэд код/төрөл шаардахгүй', () => {
    expect(formToProduct({ ...valid, code: undefined, productType: undefined }, 'update').ok).toBe(true);
  });

  it.each([
    ['доод дүн > дээд дүн', { minAmount: 90_000_000 }],
    ['хугацаа буруу', { minTerm: 40 }],
    ['хүү буруу', { minRate: 50 }],
    ['LTV > 1', { maxLtv: 1.5 }],
    ['барьцаатай ч LTV-гүй', { maxLtv: null }],
    ['барьцааны JSON буруу', { collateralChecklistText: '{oops' }],
    ['давхардсан баримтын түлхүүр', { documentChecklist: [{ key: 'a', name: 'A' }, { key: 'A', name: 'B' }] }],
  ])('няцаана: %s', (_n, over) => {
    const r = formToProduct({ ...valid, ...over }, 'create');
    expect(r.ok).toBe(false);
  });

  it('барьцааны JSON-ийг уншина', () => {
    const r = formToProduct({ ...valid, collateralChecklistText: '{"VEHICLE":["insurance"]}' }, 'create');
    expect(r.ok && r.value.collateralChecklist).toEqual({ VEHICLE: ['insurance'] });
  });
});

describe('productToForm', () => {
  it('DTO → форм → body хөрвүүлэлт эргэлт хийхэд утга алдагдахгүй', () => {
    const dto: ProductAdminDto = {
      id: 'p1', code: 'SME_PLUS', productType: 'BUSINESS', currency: 'MNT', isActive: true, name: 'ЖДҮ+', minAmount: 1_000_000, maxAmount: 80_000_000, minTerm: 3, maxTerm: 36,
      minRate: 20, maxRate: 38, defaultFeeRate: 0.0125, requiresCollateral: true, maxLtv: 0.65, maxDti: 0.5, minDscr: 1.2, calcWeightThreshold: 0.7, contractTemplateId: null,
      documentChecklist: [{ key: 'application_form', name: 'Маягт', required: false }], collateralChecklist: { VEHICLE: ['insurance'] }, haircut: { VEHICLE: 0.7 },
      externalValuationThreshold: 50_000_000, costOfGoodsRate: null, applicationCount: 2, updatedAt: '2026-11-09T00:00:00.000Z', updatedBy: null,
    };
    const r = formToProduct(productToForm(dto), 'update');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ maxDti: 0.5, minDscr: 1.2, documentChecklist: [{ required: false }], collateralChecklist: { VEHICLE: ['insurance'] }, haircut: { VEHICLE: 0.7 } });
  });
});
