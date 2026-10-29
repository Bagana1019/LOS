// aggregateCategoryMonthly / filterByPeriod (BSA-BR-3, BSA-BR-5). Бүх өгөгдөл синтетик.
import { describe, expect, it } from 'vitest';
import type { ClassifiedTxn, ClassificationResult } from '../classify/classify.types';
import { DEFAULT_BSA_CATEGORIES } from '../classify/default-catalog';
import { category, expenseTxn, incomeTxn } from '../classify/testing/factories';
import {
  aggregateCategoryMonthly, aggregateCategoryMonthlyDetailed, BsaAggregationError, filterByPeriod, isIsoDate,
} from './aggregate';

const result = (key: string, categoryCode: string, over: Partial<ClassificationResult> = {}): ClassificationResult => ({
  key, categoryCode, categoryGroup: 'X', confidence: 90, channel: 'OTHER', isOwnTransfer: false, reason: '', ...over,
});
const inc = (key: string, date: string, amount: number, code: string, over: Partial<ClassificationResult> = {}): ClassifiedTxn => ({
  txn: incomeTxn(key, 'x', { txnDate: date, amount }), result: result(key, code, over),
});
const exp = (key: string, date: string, amount: number, code: string, over: Partial<ClassificationResult> = {}): ClassifiedTxn => ({
  txn: expenseTxn(key, 'x', { txnDate: date, amount }), result: result(key, code, over),
});
const row = (rows: ReturnType<typeof aggregateCategoryMonthly>, code: string) => rows.find((r) => r.code === code)!;

describe('aggregateCategoryMonthly', () => {
  it('buckets amounts by category and calendar month taken from txnDate (month boundaries respected)', () => {
    const rows = aggregateCategoryMonthly(
      [
        inc('a', '2026-03-31', 1000, 'SALARY'),
        inc('b', '2026-04-01', 2000, 'SALARY'),
        inc('c', '2026-04-30', 500, 'SALARY'),
        inc('d', '2026-12-31', 7, 'SALARY'),
        inc('e', '2027-01-01', 8, 'SALARY'),
        exp('f', '2026-03-15', 300, 'FIXED_EXPENSE'),
      ],
      DEFAULT_BSA_CATEGORIES,
    );
    expect(row(rows, 'SALARY').monthly).toEqual({ '2026-03': 1000, '2026-04': 2500, '2026-12': 7, '2027-01': 8 });
    expect(row(rows, 'SALARY').txnCount).toBe(5);
    expect(row(rows, 'FIXED_EXPENSE').monthly).toEqual({ '2026-03': 300 });
  });

  it('copies the category definition fields calc needs', () => {
    const rows = aggregateCategoryMonthly([], DEFAULT_BSA_CATEGORIES);
    expect(row(rows, 'BUSINESS_INCOME')).toEqual({
      code: 'BUSINESS_INCOME', name: 'Бизнесийн орлого', direction: 'INCOME', groupCode: 'B', weight: 0.85, dtiRole: 'INCOME', monthly: {}, txnCount: 0,
    });
    expect(row(rows, 'LOAN_PAYMENT')).toMatchObject({ direction: 'EXPENSE', groupCode: 'A', weight: 1, dtiRole: 'DEBT_SERVICE' });
  });

  it('every ACTIVE category appears even with no transactions (zero amounts); inactive ones do not', () => {
    const categories = DEFAULT_BSA_CATEGORIES.map((c) => (c.code === 'DISCRETIONARY_EXPENSE' ? { ...c, isActive: false } : c));
    const rows = aggregateCategoryMonthly([inc('a', '2026-03-10', 10, 'SALARY')], categories);
    expect(rows.map((r) => r.code)).toEqual(categories.filter((c) => c.isActive).map((c) => c.code));
    expect(rows.map((r) => r.code)).not.toContain('DISCRETIONARY_EXPENSE');
    const empty = rows.filter((r) => r.code !== 'SALARY');
    expect(empty.every((r) => r.txnCount === 0 && Object.keys(r.monthly).length === 0)).toBe(true);
  });

  it('own transfers are excluded entirely — amounts AND counts — whatever category they carry', () => {
    const rows = aggregateCategoryMonthly(
      [
        inc('a', '2026-03-10', 1_000_000, 'OWN_TRANSFER_IN', { isOwnTransfer: true }),
        exp('b', '2026-03-10', 1_000_000, 'NON_EXPENSE', { isOwnTransfer: true }),
        inc('c', '2026-03-11', 55, 'SALARY', { isOwnTransfer: true }), // илрүүлэлт ангиллаас давуу
        inc('d', '2026-03-12', 100, 'SALARY'),
      ],
      DEFAULT_BSA_CATEGORIES,
    );
    expect(row(rows, 'OWN_TRANSFER_IN')).toMatchObject({ monthly: {}, txnCount: 0 });
    expect(row(rows, 'NON_EXPENSE')).toMatchObject({ monthly: {}, txnCount: 0 });
    expect(row(rows, 'SALARY')).toMatchObject({ monthly: { '2026-03': 100 }, txnCount: 1 });
  });

  it('sums are decimal-safe: no float drift and exact 2-dp output', () => {
    const items = [0.1, 0.2, 0.3].map((a, i) => inc(`k${i}`, '2026-03-10', a, 'SALARY'));
    expect(row(aggregateCategoryMonthly(items, DEFAULT_BSA_CATEGORIES), 'SALARY').monthly['2026-03']).toBe(0.6);
    const many = Array.from({ length: 10_000 }, (_, i) => exp(`m${i}`, '2026-03-10', 0.01, 'BANK_FEE'));
    expect(row(aggregateCategoryMonthly(many, DEFAULT_BSA_CATEGORIES), 'BANK_FEE').monthly['2026-03']).toBe(100);
    const big = [inc('a', '2026-03-10', 123_456_789.12, 'SALARY'), inc('b', '2026-03-11', 987_654_321.88, 'SALARY')];
    expect(row(aggregateCategoryMonthly(big, DEFAULT_BSA_CATEGORIES), 'SALARY').monthly['2026-03']).toBe(1_111_111_111);
  });

  it('amounts with more than two decimals are rounded per transaction, not truncated', () => {
    const items = [inc('a', '2026-03-10', 10.004, 'SALARY'), inc('b', '2026-03-10', 10.006, 'SALARY')];
    expect(row(aggregateCategoryMonthly(items, DEFAULT_BSA_CATEGORIES), 'SALARY').monthly['2026-03']).toBe(20.01);
  });

  it('month keys are listed in ascending order', () => {
    const rows = aggregateCategoryMonthly([inc('a', '2026-09-01', 1, 'SALARY'), inc('b', '2026-03-01', 1, 'SALARY')], DEFAULT_BSA_CATEGORIES);
    expect(Object.keys(row(rows, 'SALARY').monthly)).toEqual(['2026-03', '2026-09']);
  });

  it('accepts a zero amount (counted, adds nothing)', () => {
    const rows = aggregateCategoryMonthly([inc('a', '2026-03-10', 0, 'SALARY')], DEFAULT_BSA_CATEGORIES);
    expect(row(rows, 'SALARY')).toMatchObject({ monthly: { '2026-03': 0 }, txnCount: 1 });
  });
});

describe('aggregate error reporting (never silently drops money)', () => {
  it('an unknown category code is reported with a count and the first offending key, then throws from the strict variant', () => {
    const items = [inc('a', '2026-03-10', 100, 'GHOST'), inc('b', '2026-03-11', 200, 'GHOST'), inc('c', '2026-03-12', 300, 'SALARY')];
    const detailed = aggregateCategoryMonthlyDetailed(items, DEFAULT_BSA_CATEGORIES);
    expect(detailed.issues).toEqual([
      { code: 'UNKNOWN_CATEGORY', categoryCode: 'GHOST', count: 2, firstTxnKey: 'a', message: expect.stringContaining('GHOST') },
    ]);
    expect(row(detailed.categories, 'SALARY').monthly).toEqual({ '2026-03': 300 }); // бусад нь хэвийн
    expect(() => aggregateCategoryMonthly(items, DEFAULT_BSA_CATEGORIES)).toThrow(BsaAggregationError);
    try {
      aggregateCategoryMonthly(items, DEFAULT_BSA_CATEGORIES);
    } catch (e) {
      expect(e).toBeInstanceOf(BsaAggregationError);
      expect((e as BsaAggregationError).issues).toHaveLength(1);
      expect((e as Error).message).toMatch(/UNKNOWN_CATEGORY\(GHOST\)×2/);
    }
  });

  it('a transaction classified into an inactive category is an error (reclassify first)', () => {
    const categories = DEFAULT_BSA_CATEGORIES.map((c) => (c.code === 'SALARY' ? { ...c, isActive: false } : c));
    const { issues } = aggregateCategoryMonthlyDetailed([inc('a', '2026-03-10', 1, 'SALARY')], categories);
    expect(issues).toMatchObject([{ code: 'INACTIVE_CATEGORY', categoryCode: 'SALARY', count: 1 }]);
  });

  it('direction mismatch between the transaction and its category is an error', () => {
    const { issues } = aggregateCategoryMonthlyDetailed([exp('a', '2026-03-10', 1, 'SALARY'), inc('b', '2026-03-10', 1, 'FIXED_EXPENSE')], DEFAULT_BSA_CATEGORIES);
    expect(issues.map((i) => [i.code, i.categoryCode, i.count])).toEqual([['DIRECTION_MISMATCH', 'SALARY', 1], ['DIRECTION_MISMATCH', 'FIXED_EXPENSE', 1]]);
  });

  it('invalid dates and amounts are reported', () => {
    const items = [
      inc('d1', '2026-02-30', 1, 'SALARY'),
      inc('d2', '2026-3-1', 1, 'SALARY'),
      inc('d3', '', 1, 'SALARY'),
      inc('a1', '2026-03-10', -5, 'SALARY'),
      inc('a2', '2026-03-10', Number.NaN, 'SALARY'),
      inc('a3', '2026-03-10', Number.POSITIVE_INFINITY, 'SALARY'),
      inc('a4', '2026-03-10', 1e300, 'SALARY'),
      inc('ok', '2026-03-10', 5, 'SALARY'),
    ];
    const { issues, categories } = aggregateCategoryMonthlyDetailed(items, DEFAULT_BSA_CATEGORIES);
    expect(issues.map((i) => [i.code, i.count, i.firstTxnKey])).toEqual([['INVALID_DATE', 3, 'd1'], ['INVALID_AMOUNT', 4, 'a1']]);
    expect(row(categories, 'SALARY')).toMatchObject({ monthly: { '2026-03': 5 }, txnCount: 1 });
  });

  it('issue text never contains transaction descriptions or accounts', () => {
    const item: ClassifiedTxn = {
      txn: incomeTxn('a', 'Болд Бат 5011234567', { counterpartyAccount: '5011234567', counterpartyName: 'Болд' }),
      result: result('a', 'GHOST'),
    };
    expect(JSON.stringify(aggregateCategoryMonthlyDetailed([item], DEFAULT_BSA_CATEGORIES).issues)).not.toMatch(/Болд|5011/);
  });

  it('duplicate / unusual category setup still aggregates per code', () => {
    const cats = [category({ code: 'X', direction: 'INCOME' }), category({ code: 'Y', direction: 'EXPENSE' })];
    const rows = aggregateCategoryMonthly([inc('a', '2026-03-10', 5, 'X'), exp('b', '2026-04-10', 6, 'Y')], cats);
    expect(rows.map((r) => [r.code, r.txnCount])).toEqual([['X', 1], ['Y', 1]]);
  });
});

describe('filterByPeriod', () => {
  const items = [
    inc('before', '2026-03-09', 1, 'SALARY'),
    inc('from', '2026-03-10', 1, 'SALARY'),
    inc('mid', '2026-06-01', 1, 'SALARY'),
    inc('to', '2026-09-10', 1, 'SALARY'),
    inc('after', '2026-09-11', 1, 'SALARY'),
  ];

  it('keeps transactions within [from, to] — both ends inclusive — in original order and identity', () => {
    const out = filterByPeriod(items, '2026-03-10', '2026-09-10');
    expect(out.map((i) => i.txn.key)).toEqual(['from', 'mid', 'to']);
    expect(out[0]).toBe(items[1]);
  });

  it('a single-day period works; an empty result is fine', () => {
    expect(filterByPeriod(items, '2026-06-01', '2026-06-01').map((i) => i.txn.key)).toEqual(['mid']);
    expect(filterByPeriod(items, '2030-01-01', '2030-12-31')).toEqual([]);
  });

  it('keeps invalid-date transactions so the aggregator can report them instead of silently losing them', () => {
    const bad = inc('bad', '2026-13-45', 1, 'SALARY');
    expect(filterByPeriod([bad, ...items], '2026-03-10', '2026-09-10').map((i) => i.txn.key)).toContain('bad');
    expect(() => aggregateCategoryMonthly(filterByPeriod([bad], '2026-03-10', '2026-09-10'), DEFAULT_BSA_CATEGORIES)).toThrow(BsaAggregationError);
  });

  it('rejects an invalid or inverted period', () => {
    expect(() => filterByPeriod(items, '2026-09-10', '2026-03-10')).toThrow(RangeError);
    expect(() => filterByPeriod(items, '2026-02-30', '2026-03-10')).toThrow(RangeError);
    expect(() => filterByPeriod(items, 'x', 'y')).toThrow(RangeError);
  });
});

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    for (const ok of ['2026-03-10', '2024-02-29', '2026-12-31']) expect(isIsoDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-3-1', '26-03-10', '2026/03/10', '', null, undefined, 20260310]) {
      expect(isIsoDate(bad), String(bad)).toBe(false);
    }
  });
});
