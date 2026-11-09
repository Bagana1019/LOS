import { describe, expect, it } from 'vitest';
import { ProductCreateRequest, ProductSetActiveRequest, ProductUpdateRequest, validateProductRanges } from './product-admin';

const product = {
  code: 'SME_PLUS', productType: 'BUSINESS', name: 'ЖДҮ+', minAmount: 1_000_000, maxAmount: 80_000_000, minTerm: 3, maxTerm: 36, minRate: 20, maxRate: 38,
  requiresCollateral: true, maxLtv: 0.65,
};

describe('product admin DTO', () => {
  it('create: default-ууд (currency MNT, null талбар) бөглөгдөнө; шалтгаан заавал', () => {
    const r = ProductCreateRequest.parse({ reason: 'шинэ бүтээгдэхүүн', product });
    expect(r.product).toMatchObject({ currency: 'MNT', maxDti: null, haircut: null, documentChecklist: null });
    expect(ProductCreateRequest.safeParse({ product }).success).toBe(false);
    expect(ProductCreateRequest.safeParse({ reason: 'ab', product }).success).toBe(false);
  });

  it('код UPPER_SNAKE; 4-оос олон бутархай, хоёр оронтой дүнгээс олон бутархай няцна', () => {
    for (const bad of [{ code: 'sme' }, { code: 'A' }, { maxLtv: 0.65001 }, { minAmount: 1000.123 }, { haircut: { BOAT: 0.5 } }, { haircut: { VEHICLE: 1.2 } }]) {
      expect(ProductCreateRequest.safeParse({ reason: 'шалтгаан', product: { ...product, ...bad } }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('update: код/төрөл/валют талбар агуулгад орохгүй (strip)', () => {
    const { code: _c, productType: _t, ...rest } = product;
    const r = ProductUpdateRequest.parse({ reason: 'засвар', product: { ...rest, code: 'X_X', productType: 'Y' } });
    expect(r.product).not.toHaveProperty('code');
    expect(r.product).not.toHaveProperty('productType');
  });

  it('set-active: isActive заавал', () => {
    expect(ProductSetActiveRequest.safeParse({ reason: 'зогсоох' }).success).toBe(false);
    expect(ProductSetActiveRequest.parse({ reason: 'зогсоох', isActive: false }).isActive).toBe(false);
  });

  it('validateProductRanges: хүрээ, барьцаа⇒LTV, баримтын давхардал', () => {
    const ok = { ...product, documentChecklist: null };
    expect(validateProductRanges(ok as never)).toBeNull();
    expect(validateProductRanges({ ...ok, minAmount: 0 } as never)).toMatch(/Доод дүн/);
    expect(validateProductRanges({ ...ok, minAmount: 9e9 } as never)).toMatch(/дээд дүн/);
    expect(validateProductRanges({ ...ok, minTerm: 99 } as never)).toMatch(/хугацаа/);
    expect(validateProductRanges({ ...ok, minRate: 99 } as never)).toMatch(/хүү/);
    expect(validateProductRanges({ ...ok, maxLtv: null } as never)).toMatch(/LTV/);
    expect(validateProductRanges({ ...ok, requiresCollateral: false, maxLtv: null } as never)).toBeNull();
  });
});
