import { describe, expect, it } from 'vitest';
import { resolveImpact } from './bsa.resolve';

// F6-10: the toast states what the SERVER changed (changedTransactions / unchangedTransactions). The web only decides which direction to name.

const server = (changedTransactions: number, unchangedTransactions: number) => ({ changedTransactions, unchangedTransactions });

describe('resolveImpact', () => {
  it('approve changes no transaction category, so there is nothing to report', () => {
    expect(resolveImpact('APPROVE', server(0, 0), null)).toBeNull();
  });

  it('reclassify to an income category: the server numbers pass through and the left-over legs are named as expense (the F6-10 case)', () => {
    expect(resolveImpact('RECLASSIFY', server(1, 1), 'INCOME')).toEqual({ changed: 1, unchanged: 1, unchangedDirection: 'EXPENSE' });
  });

  it('reclassify to an expense category names the left-over legs as income', () => {
    expect(resolveImpact('RECLASSIFY', server(1, 1), 'EXPENSE')).toEqual({ changed: 1, unchanged: 1, unchangedDirection: 'INCOME' });
  });

  it('reclassify with nothing left over names no direction', () => {
    expect(resolveImpact('RECLASSIFY', server(2, 0), 'INCOME')).toEqual({ changed: 2, unchanged: 0, unchangedDirection: null });
  });

  it('exclude passes the server count through; both directions change, so there is no mismatch', () => {
    expect(resolveImpact('EXCLUDE', server(4, 0), null)).toEqual({ changed: 4, unchanged: 0, unchangedDirection: null });
  });

  it('exclude that changed nothing (own-account transfers only) reports 0 rather than hiding it', () => {
    expect(resolveImpact('EXCLUDE', server(0, 0), null)).toEqual({ changed: 0, unchanged: 0, unchangedDirection: null });
  });

  it('never recomputes: the numbers are exactly what the server sent', () => {
    expect(resolveImpact('RECLASSIFY', server(7, 3), 'EXPENSE')).toEqual({ changed: 7, unchanged: 3, unchangedDirection: 'INCOME' });
  });

  it('keeps the counts but cannot name the direction when the picked category is unknown', () => {
    expect(resolveImpact('RECLASSIFY', server(1, 2), null)).toEqual({ changed: 1, unchanged: 2, unchangedDirection: null });
  });
});
