import { describe, expect, it } from 'vitest';
import type { ProductAdminDto } from '@los/contracts';
import { EMPTY_FORM, formToProduct, productToForm, type ProductFormValues } from './product-form';

// Форм дээрх бутархай талбарууд (шимтгэл, LTV, ӨОХ, жингийн босго, ББӨ, haircut) ХУВИАР (65 = 65%); API-д бутархай (0.65). F9-2.
const valid: ProductFormValues = {
  ...EMPTY_FORM, code: 'SME_PLUS', productType: 'BUSINESS', name: 'ЖДҮ+',
  minAmount: 1_000_000, maxAmount: 80_000_000, minTerm: 3, maxTerm: 36, minRate: 20, maxRate: 38, defaultFeeRate: 1.25,
  requiresCollateral: true, maxLtv: 65, haircut: { VEHICLE: 70, LAND: null },
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
    ['LTV > 100%', { maxLtv: 150 }],
    ['барьцаатай ч LTV-гүй', { maxLtv: null }],
    ['барьцааны JSON буруу', { collateralChecklistText: '{oops' }],
    ['давхардсан баримтын түлхүүр', { documentChecklist: [{ key: 'a', name: 'A' }, { key: 'A', name: 'B' }] }],
  ])('няцаана: %s', (_n, over) => {
    const r = formToProduct({ ...valid, ...over }, 'create');
    expect(r.ok).toBe(false);
  });

  it('хувиар бичсэн утга API-д бутархай болж явна: LTV 70 → 0.7 (1.00 болж clamp хийхгүй), шимтгэл 1.5 → 0.015', () => {
    const r = formToProduct({ ...valid, maxLtv: 70, maxDti: 55, defaultFeeRate: 1.5, calcWeightThreshold: 80, costOfGoodsRate: 10, haircut: { VEHICLE: 70, LAND: 50 } }, 'create');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ maxLtv: 0.7, maxDti: 0.55, defaultFeeRate: 0.015, calcWeightThreshold: 0.8, costOfGoodsRate: 0.1, haircut: { VEHICLE: 0.7, LAND: 0.5 } });
  });

  it('хүү (жилийн %) хувиараа үлдэнэ: 24.5 → 24.5', () => {
    const r = formToProduct({ ...valid, minRate: 24.5, maxRate: 30 }, 'create');
    expect(r.ok && r.value).toMatchObject({ minRate: 24.5, maxRate: 30 });
  });

  it('тоо биш текстээс (NaN) үлдсэн утгыг чимээгүй 0/null болгохгүй, тодорхой алдаа', () => {
    for (const over of [{ minAmount: Number.NaN }, { maxLtv: Number.NaN }, { minTerm: Number.NaN }, { haircut: { VEHICLE: Number.NaN } }]) {
      const r = formToProduct({ ...valid, ...over }, 'create');
      expect(r).toEqual({ ok: false, error: 'Зөвхөн тоо оруулна уу (жишээ: 12)' });
    }
  });

  it('барьцааны JSON-ийг уншина', () => {
    const r = formToProduct({ ...valid, collateralChecklistText: '{"VEHICLE":["insurance"]}' }, 'create');
    expect(r.ok && r.value.collateralChecklist).toEqual({ VEHICLE: ['insurance'] });
  });
});

describe('productToForm', () => {
  it('API-ийн бутархайг форм дээр хувиар харуулна: 0.65 → 65, 0.0125 → 1.25, haircut 0.7 → 70; хоосон нь хоосон', () => {
    const dto = { id: 'p1', code: 'X', productType: 'T', currency: 'MNT', isActive: true, name: 'n', minAmount: 1, maxAmount: 2, minTerm: 1, maxTerm: 2, minRate: 20, maxRate: 38,
      defaultFeeRate: 0.0125, requiresCollateral: true, maxLtv: 0.65, maxDti: null, minDscr: 1.25, calcWeightThreshold: 0.7, contractTemplateId: null, documentChecklist: null,
      collateralChecklist: null, haircut: { VEHICLE: 0.7 }, externalValuationThreshold: null, costOfGoodsRate: 0.1, applicationCount: 0, updatedAt: '2026-11-09T00:00:00.000Z', updatedBy: null } as ProductAdminDto;
    expect(productToForm(dto)).toMatchObject({ defaultFeeRate: 1.25, maxLtv: 65, maxDti: null, minDscr: 1.25, calcWeightThreshold: 70, costOfGoodsRate: 10, minRate: 20, haircut: { VEHICLE: 70 } });
  });

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
