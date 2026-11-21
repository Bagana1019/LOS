import { describe, expect, it } from 'vitest';
import type { TxnDirection } from '@los/contracts';
import { readResolveOutcome, resolveImpact } from './bsa.resolve';

// F6-10: сэжигтэй дохио шийдвэрлэсний үр дүн — сервер юу буцаасан, гүйлгээний ангилал хэд өөрчлөгдөх.

type Row = Parameters<typeof resolveImpact>[1][number];
const txn = (id: string, direction: TxnDirection, categoryCode: string | null = null) => ({ id, direction, categoryCode });
const row = (flag: Row['flag'], transactions: Row['transactions'], status: Row['status'] = 'PENDING'): Row => ({ flag, status, transactions });

const INCOME_TARGET = { code: 'LOAN_PROCEEDS', direction: 'INCOME' as const };
const pair = row('CIRCULAR', [txn('t2', 'INCOME', 'OTHER_INCOME'), txn('t3', 'EXPENSE', 'OTHER_EXPENSE')]);

describe('readResolveOutcome', () => {
  it('reads resolved and skipped from the server response', () => {
    expect(readResolveOutcome({ resolved: 2, skipped: 1, pending: 3, summary: null, repushRequired: false }, 3)).toEqual({ resolved: 2, skipped: 1 });
  });
  it.each([[null], [undefined], ['ok'], [{}], [{ updated: 2 }], [{ resolved: -1, skipped: 0 }], [{ resolved: 1.5, skipped: 0 }], [{ resolved: '2', skipped: 0 }]])(
    'falls back to the selection size when the body is not the expected shape (%j)',
    (raw) => { expect(readResolveOutcome(raw, 4)).toEqual({ resolved: 4, skipped: 0 }); },
  );
  it('treats a missing skipped as 0', () => {
    expect(readResolveOutcome({ resolved: 2 }, 5)).toEqual({ resolved: 2, skipped: 0 });
  });
});

describe('resolveImpact', () => {
  it('approve changes no transaction category, so there is nothing to report', () => {
    expect(resolveImpact('APPROVE', [pair], null)).toBeNull();
  });

  it('reclassify of an income+expense pair to an income category changes only the income leg (the F6-10 case)', () => {
    expect(resolveImpact('RECLASSIFY', [pair], INCOME_TARGET)).toEqual({ changed: 1, unchanged: 1, unchangedDirection: 'EXPENSE' });
  });

  it('reclassify to an expense category leaves the income leg and names that direction', () => {
    expect(resolveImpact('RECLASSIFY', [pair], { code: 'LOAN_PAYMENT', direction: 'EXPENSE' })).toEqual({ changed: 1, unchanged: 1, unchangedDirection: 'INCOME' });
  });

  it('reclassify of same-direction rows changes all of them and reports no mismatch', () => {
    const rows = [row('QUICK_CASH', [txn('a', 'INCOME'), txn('b', 'INCOME')])];
    expect(resolveImpact('RECLASSIFY', rows, INCOME_TARGET)).toEqual({ changed: 2, unchanged: 0, unchangedDirection: null });
  });

  it('a transaction already in the target category is not counted as changed', () => {
    const rows = [row('QUICK_CASH', [txn('a', 'INCOME', 'LOAN_PROCEEDS'), txn('b', 'INCOME', 'OTHER_INCOME')])];
    expect(resolveImpact('RECLASSIFY', rows, INCOME_TARGET)).toEqual({ changed: 1, unchanged: 0, unchangedDirection: null });
  });

  it('exclude moves every transaction of both directions', () => {
    expect(resolveImpact('EXCLUDE', [pair], null)).toEqual({ changed: 2, unchanged: 0, unchangedDirection: null });
  });

  it('counts a transaction shared by two selected signals once', () => {
    const rows = [row('CIRCULAR', [txn('t1', 'INCOME')]), row('QUICK_CASH', [txn('t1', 'INCOME'), txn('t2', 'INCOME')])];
    expect(resolveImpact('EXCLUDE', rows, null)).toEqual({ changed: 2, unchanged: 0, unchangedDirection: null });
  });

  it('own-account signals hold own transfers, which the server never recategorises', () => {
    const rows = [row('OWN_ACCOUNT', [txn('t1', 'INCOME'), txn('t2', 'EXPENSE')])];
    expect(resolveImpact('EXCLUDE', rows, null)).toEqual({ changed: 0, unchanged: 0, unchangedDirection: null });
    expect(resolveImpact('RECLASSIFY', rows, INCOME_TARGET)).toEqual({ changed: 0, unchanged: 0, unchangedDirection: null });
  });

  it('already resolved signals are skipped by the server, so they add nothing', () => {
    const rows = [row('CIRCULAR', [txn('t1', 'INCOME')], 'RESOLVED'), row('QUICK_CASH', [txn('t2', 'INCOME')])];
    expect(resolveImpact('EXCLUDE', rows, null)).toEqual({ changed: 1, unchanged: 0, unchangedDirection: null });
  });

  it('reclassify without a known target category cannot state a count', () => {
    expect(resolveImpact('RECLASSIFY', [pair], null)).toBeNull();
  });

  it('empty selection changes nothing', () => {
    expect(resolveImpact('EXCLUDE', [], null)).toEqual({ changed: 0, unchanged: 0, unchangedDirection: null });
  });
});
