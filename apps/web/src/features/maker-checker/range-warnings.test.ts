import { describe, expect, it } from 'vitest';
import { rangeWarnings } from './range-warnings';

// F9-5: бүтээгдэхүүний саналд хэвийн бус утга (LTV > 90%, доод дүн < 10,000₮, жилийн хүү ≥ 100%) батлагчид анхааруулагдана. Хориглохгүй.
const BEFORE = { id: 'p1', isActive: true, name: 'X', minAmount: 100000, maxAmount: 5000000, minRate: 24, maxRate: 36, maxLtv: 0.25 };
const update = (product: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  targetType: 'PRODUCT', action: 'UPDATE', before: BEFORE, payload: { id: 'p1', product: { name: 'X', minAmount: 100000, maxAmount: 5000000, minRate: 24, maxRate: 36, maxLtv: 0.25, ...product } }, ...over,
});
const paths = (dto: ReturnType<typeof update>) => rangeWarnings(dto).map((w) => w.path);

describe('rangeWarnings: product thresholds', () => {
  it('LTV above 90% warns, 90% and below does not', () => {
    expect(paths(update({ maxLtv: 1 }))).toEqual(['maxLtv']);
    expect(paths(update({ maxLtv: 0.91 }))).toEqual(['maxLtv']);
    expect(paths(update({ maxLtv: 0.9 }))).toEqual([]);
    expect(paths(update({ maxLtv: 0.7 }))).toEqual([]);
  });

  it('a minimum amount below 10,000₮ warns, 10,000₮ and above does not', () => {
    expect(paths(update({ minAmount: 5 }))).toEqual(['minAmount']);
    expect(paths(update({ minAmount: 9999 }))).toEqual(['minAmount']);
    expect(paths(update({ minAmount: 10000 }))).toEqual([]);
  });

  it('an annual rate of 100% or more warns (min and max), 99.99% does not', () => {
    expect(paths(update({ maxRate: 100 }))).toEqual(['maxRate']);
    expect(paths(update({ minRate: 120, maxRate: 150 })).sort()).toEqual(['maxRate', 'minRate']);
    expect(paths(update({ maxRate: 99.99 }))).toEqual([]);
  });

  it('the message names the field, the value with its unit and the limit', () => {
    const msgs = rangeWarnings(update({ maxLtv: 1, minAmount: 5 })).map((w) => w.message);
    expect(msgs).toContain('Дээд LTV: 100% — хэтэрхий өндөр (хэвийн: 90% хүртэл)');
    expect(msgs).toContain('Доод дүн: 5₮ — хэтэрхий бага (хэвийн: 10,000₮ ба түүнээс дээш)');
    expect(rangeWarnings(update({ maxRate: 100 }))[0]?.message).toBe('Дээд хүү (жилийн): 100% — хэтэрхий өндөр (хэвийн: 100% хүрэхгүй)');
  });

  it('only CHANGED values are checked: an old odd value that this request does not touch is not repeated', () => {
    expect(paths(update({ maxLtv: 1 }, { before: { ...BEFORE, maxLtv: 1 } }))).toEqual([]);
  });

  it('CREATE checks every proposed value', () => {
    const dto = { targetType: 'PRODUCT', action: 'CREATE', before: null, payload: { product: { code: 'NEW', minAmount: 1, maxLtv: 0.95 } } };
    expect(rangeWarnings(dto).map((w) => w.path).sort()).toEqual(['maxLtv', 'minAmount']);
  });

  it('null (no limit) and non-numeric values never warn', () => {
    expect(paths(update({ maxLtv: null }, { before: { ...BEFORE, maxLtv: 0.5 } }))).toEqual([]);
    expect(paths(update({ maxLtv: 'high' }))).toEqual([]);
  });

  it('activating/deactivating and other target types never warn', () => {
    expect(rangeWarnings({ targetType: 'PRODUCT', action: 'SET_ACTIVE', before: { isActive: true }, payload: { id: 'p1', isActive: false } })).toEqual([]);
    expect(rangeWarnings({ targetType: 'SETTING', action: 'UPDATE', before: { maxLtv: 0.2 }, payload: { maxLtv: 5 } })).toEqual([]);
  });

  it('a malformed request does not crash', () => {
    expect(rangeWarnings({ targetType: 'PRODUCT', action: 'UPDATE', before: null, payload: 'oops' })).toEqual([]);
  });
});
