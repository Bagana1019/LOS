// BSA-BR-7 "Бусад" босго. Бүх өгөгдөл синтетик.
import { describe, expect, it } from 'vitest';
import type { ClassifiedTxn, ClassificationResult } from './classify.types';
import { DEFAULT_BSA_CATEGORIES } from './default-catalog';
import { computeOtherShare } from './other-share';
import { expenseTxn, incomeTxn } from './testing/factories';

const result = (key: string, categoryCode: string, over: Partial<ClassificationResult> = {}): ClassificationResult => ({
  key, categoryCode, categoryGroup: '', confidence: 50, channel: 'OTHER', isOwnTransfer: false, reason: '', ...over,
});
const inc = (key: string, amount: number, categoryCode: string, over: Partial<ClassificationResult> = {}): ClassifiedTxn => ({
  txn: incomeTxn(key, 'x', { amount }), result: result(key, categoryCode, over),
});
const exp = (key: string, amount: number, categoryCode: string, over: Partial<ClassificationResult> = {}): ClassifiedTxn => ({
  txn: expenseTxn(key, 'x', { amount }), result: result(key, categoryCode, over),
});
const report = (items: ClassifiedTxn[], threshold: number, direction: 'INCOME' | 'EXPENSE' = 'INCOME') =>
  computeOtherShare(items, DEFAULT_BSA_CATEGORIES, threshold).find((r) => r.direction === direction)!;

describe('computeOtherShare', () => {
  it('returns one report per direction, even when empty (share 0, never exceeded)', () => {
    const r = computeOtherShare([], DEFAULT_BSA_CATEGORIES, 0.3);
    expect(r).toEqual([
      { direction: 'INCOME', otherAmount: 0, totalAmount: 0, share: 0, exceeded: false },
      { direction: 'EXPENSE', otherAmount: 0, totalAmount: 0, share: 0, exceeded: false },
    ]);
  });

  it('share = amount in "?"-group categories / total, per direction', () => {
    const items = [inc('a', 700, 'SALARY'), inc('b', 300, 'OTHER_INCOME'), exp('c', 50, 'FIXED_EXPENSE'), exp('d', 50, 'OTHER_EXPENSE')];
    expect(report(items, 0.5)).toEqual({ direction: 'INCOME', otherAmount: 300, totalAmount: 1000, share: 0.3, exceeded: false });
    expect(report(items, 0.4, 'EXPENSE')).toEqual({ direction: 'EXPENSE', otherAmount: 50, totalAmount: 100, share: 0.5, exceeded: true });
  });

  it('boundary: exactly at the threshold is NOT exceeded; one minor unit above is', () => {
    expect(report([inc('a', 700, 'SALARY'), inc('b', 300, 'OTHER_INCOME')], 0.3).exceeded).toBe(false);
    expect(report([inc('a', 699.99, 'SALARY'), inc('b', 300.01, 'OTHER_INCOME')], 0.3).exceeded).toBe(true);
    expect(report([inc('a', 700.01, 'SALARY'), inc('b', 299.99, 'OTHER_INCOME')], 0.3).exceeded).toBe(false);
  });

  it('boundary is exact for thresholds whose float product is inexact (0.1, 0.2, 0.3, 0.7)', () => {
    for (const t of [0.1, 0.2, 0.3, 0.7, 0.55]) {
      const other = Math.round(t * 1000);
      const items = [inc('a', 1000 - other, 'SALARY'), inc('b', other, 'OTHER_INCOME')];
      expect(report(items, t).exceeded, `t=${t}`).toBe(false);
      const above = [inc('a', 1000 - other - 0.01, 'SALARY'), inc('b', other + 0.01, 'OTHER_INCOME')];
      expect(report(above, t).exceeded, `t=${t}`).toBe(true);
    }
  });

  it('threshold 0 flags any "Бусад"; threshold 1 never flags', () => {
    const items = [inc('a', 1000, 'SALARY'), inc('b', 0.01, 'OTHER_INCOME')];
    expect(report(items, 0).exceeded).toBe(true);
    expect(report([inc('a', 10, 'OTHER_INCOME')], 1).exceeded).toBe(false);
    expect(report([inc('a', 1000, 'SALARY')], 0).exceeded).toBe(false);
  });

  it('own transfers are excluded from both the numerator and the denominator', () => {
    const items = [
      inc('a', 1000, 'SALARY'),
      inc('b', 100, 'OTHER_INCOME'),
      inc('c', 5000, 'OWN_TRANSFER_IN', { isOwnTransfer: true }),
      inc('d', 5000, 'OTHER_INCOME', { isOwnTransfer: true }), // илрүүлэлтээр өөрийн шилжүүлэг болсон, ангилал нь өөр байсан ч
    ];
    expect(report(items, 0.3)).toMatchObject({ otherAmount: 100, totalAmount: 1100 });
  });

  it('EXCLUDE-role categories (savings, own-transfer category) are not part of the base', () => {
    const items = [exp('a', 100, 'FIXED_EXPENSE'), exp('b', 900, 'NON_EXPENSE'), exp('c', 100, 'OTHER_EXPENSE')];
    expect(report(items, 0.3, 'EXPENSE')).toMatchObject({ otherAmount: 100, totalAmount: 200, share: 0.5, exceeded: true });
  });

  it('an unknown category code is unclassified data and counts as "Бусад"', () => {
    expect(report([inc('a', 100, 'SALARY'), inc('b', 100, 'GHOST')], 0.4)).toMatchObject({ otherAmount: 100, share: 0.5, exceeded: true });
  });

  it('sums are decimal-safe', () => {
    const items = [inc('a', 0.1, 'OTHER_INCOME'), inc('b', 0.2, 'OTHER_INCOME'), inc('c', 0.7, 'SALARY')];
    expect(report(items, 0.3)).toMatchObject({ otherAmount: 0.3, totalAmount: 1, share: 0.3, exceeded: false });
  });

  it('ignores non-positive and non-finite amounts instead of corrupting the shares', () => {
    const items = [inc('a', 100, 'SALARY'), inc('b', -50, 'OTHER_INCOME'), inc('c', Number.NaN, 'OTHER_INCOME'), inc('d', 0, 'OTHER_INCOME'), inc('e', 1e300, 'OTHER_INCOME')];
    expect(report(items, 0.3)).toMatchObject({ otherAmount: 0, totalAmount: 100, exceeded: false });
  });

  it('rejects an invalid threshold', () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => computeOtherShare([], DEFAULT_BSA_CATEGORIES, bad)).toThrow(RangeError);
  });
});
