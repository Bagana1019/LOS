// analyzeCoverage / dedupeKey / dedupeAcrossStatements (BSA-FR-2.4). SYNTHETIC огноо, дансны шошго.
import { describe, expect, it } from 'vitest';
import { analyzeCoverage, COVERAGE_DEFAULTS, dedupeAcrossStatements, dedupeKey, type DedupeInput, type StatementPeriod } from './coverage';

const SIX_MONTHS = { from: '2025-10-01', to: '2026-03-31' };
const p = (from: string, to: string, extra: Partial<StatementPeriod> = {}): StatementPeriod => ({ from, to, ...extra });

describe('analyzeCoverage — months and gaps', () => {
  it('full coverage by several adjacent statements: no gaps, no shortfall', () => {
    const r = analyzeCoverage([p('2025-10-01', '2025-12-31'), p('2026-01-01', '2026-03-31')], SIX_MONTHS);
    expect(r).toMatchObject({ coveredMonths: 6, missingMonths: [], gaps: [], overlaps: [], shortfallMonths: 0, ignoredPeriods: 0 });
  });

  it('6-month requirement with one missing month: "1 сарын хуулга дутуу"', () => {
    const r = analyzeCoverage([p('2025-10-01', '2025-12-31'), p('2026-02-01', '2026-03-31')], SIX_MONTHS);
    expect(r.coveredMonths).toBe(5);
    expect(r.missingMonths).toEqual(['2026-01']);
    expect(r.shortfallMonths).toBe(1);
    expect(r.gaps).toEqual([{ from: '2026-01-01', to: '2026-01-31' }]);
  });

  it('no statements at all: every month is missing and the gap is the whole required period', () => {
    const r = analyzeCoverage([], SIX_MONTHS);
    expect(r.coveredMonths).toBe(0);
    expect(r.missingMonths).toEqual(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(r.shortfallMonths).toBe(6);
    expect(r.gaps).toEqual([SIX_MONTHS]);
  });

  it('a partly covered month counts as missing and the uncovered days are the gap', () => {
    const r = analyzeCoverage([p('2025-10-01', '2026-03-20')], SIX_MONTHS);
    expect(r.coveredMonths).toBe(5);
    expect(r.missingMonths).toEqual(['2026-03']);
    expect(r.gaps).toEqual([{ from: '2026-03-21', to: '2026-03-31' }]);
  });

  it('leading and trailing gaps are reported', () => {
    const r = analyzeCoverage([p('2025-11-15', '2026-02-10')], SIX_MONTHS);
    expect(r.gaps).toEqual([
      { from: '2025-10-01', to: '2025-11-14' },
      { from: '2026-02-11', to: '2026-03-31' },
    ]);
    expect(r.missingMonths).toEqual(['2025-10', '2025-11', '2026-02', '2026-03']);
    expect(r.coveredMonths).toBe(2);
  });

  it('a one-day gap is a gap (adjacent days are not); the tolerance option forgives short gaps', () => {
    const periods = [p('2025-10-01', '2026-01-30'), p('2026-02-01', '2026-03-31')];
    const strict = analyzeCoverage(periods, SIX_MONTHS);
    expect(strict.gaps).toEqual([{ from: '2026-01-31', to: '2026-01-31' }]);
    expect(strict.missingMonths).toEqual(['2026-01']);
    const lenient = analyzeCoverage(periods, SIX_MONTHS, { gapToleranceDays: 1 });
    expect(lenient.gaps).toEqual([]);
    expect(lenient.coveredMonths).toBe(6);
    expect(COVERAGE_DEFAULTS.gapToleranceDays).toBe(0);
  });

  it('statements are used in any order and may extend beyond the required period', () => {
    const r = analyzeCoverage([p('2026-01-01', '2026-06-30'), p('2025-06-01', '2025-12-31')], SIX_MONTHS);
    expect(r.coveredMonths).toBe(6);
    expect(r.gaps).toEqual([]);
  });

  it('required period starting/ending mid-month needs only the days inside it', () => {
    const r = analyzeCoverage([p('2026-01-15', '2026-03-10')], { from: '2026-01-15', to: '2026-03-10' });
    expect(r.coveredMonths).toBe(3);
    expect(r.missingMonths).toEqual([]);
    const short = analyzeCoverage([p('2026-01-16', '2026-03-10')], { from: '2026-01-15', to: '2026-03-10' });
    expect(short.missingMonths).toEqual(['2026-01']);
    expect(short.gaps).toEqual([{ from: '2026-01-15', to: '2026-01-15' }]);
  });

  it('works across a year boundary, in a leap year February and for a single day', () => {
    const leap = analyzeCoverage([p('2024-01-01', '2024-02-28')], { from: '2024-01-01', to: '2024-03-01' });
    expect(leap.missingMonths).toEqual(['2024-02', '2024-03']);
    expect(leap.gaps).toEqual([{ from: '2024-02-29', to: '2024-03-01' }]);
    const one = analyzeCoverage([p('2026-03-05', '2026-03-05')], { from: '2026-03-05', to: '2026-03-05' });
    expect(one.coveredMonths).toBe(1);
    const year = analyzeCoverage([p('2025-12-01', '2026-01-31')], { from: '2025-12-01', to: '2026-01-31' });
    expect(year.coveredMonths).toBe(2);
  });

  it('12-month requirement', () => {
    const r = analyzeCoverage([p('2025-04-01', '2026-03-31')], { from: '2025-04-01', to: '2026-03-31' });
    expect(r.coveredMonths).toBe(12);
  });

  it('statements for different accounts together cover the required period', () => {
    const r = analyzeCoverage([p('2025-10-01', '2025-12-31', { bank: 'KHAN', account: 'A' }), p('2026-01-01', '2026-03-31', { bank: 'TDB', account: 'B' })], SIX_MONTHS);
    expect(r.coveredMonths).toBe(6);
    expect(r.gaps).toEqual([]);
  });
});

describe('analyzeCoverage — overlaps (same account only)', () => {
  it('two statements of one account that overlap: the overlapping range is reported with the account', () => {
    const r = analyzeCoverage(
      [p('2025-10-01', '2026-01-31', { bank: 'KHAN', account: 'A' }), p('2026-01-15', '2026-03-31', { bank: 'KHAN', account: 'A' })],
      SIX_MONTHS,
    );
    expect(r.overlaps).toEqual([{ from: '2026-01-15', to: '2026-01-31', accounts: ['KHAN:A'] }]);
    expect(r.coveredMonths).toBe(6);
  });

  it('the same statement uploaded twice overlaps over its whole period', () => {
    const r = analyzeCoverage([p('2026-01-01', '2026-01-31', { bank: 'GOLOMT', account: 'A' }), p('2026-01-01', '2026-01-31', { bank: 'GOLOMT', account: 'A' })], SIX_MONTHS);
    expect(r.overlaps).toEqual([{ from: '2026-01-01', to: '2026-01-31', accounts: ['GOLOMT:A'] }]);
  });

  it('adjacent statements (to = day before from) do not overlap; sharing one day does', () => {
    const adjacent = analyzeCoverage([p('2026-01-01', '2026-01-31', { account: 'A' }), p('2026-02-01', '2026-02-28', { account: 'A' })], SIX_MONTHS);
    expect(adjacent.overlaps).toEqual([]);
    const shared = analyzeCoverage([p('2026-01-01', '2026-01-31', { account: 'A' }), p('2026-01-31', '2026-02-28', { account: 'A' })], SIX_MONTHS);
    expect(shared.overlaps).toEqual([{ from: '2026-01-31', to: '2026-01-31', accounts: ['A'] }]);
  });

  it('different accounts covering the same time are normal and not an overlap', () => {
    const r = analyzeCoverage([p('2026-01-01', '2026-03-31', { bank: 'KHAN', account: 'A' }), p('2026-01-01', '2026-03-31', { bank: 'KHAN', account: 'B' })], SIX_MONTHS);
    expect(r.overlaps).toEqual([]);
    const banks = analyzeCoverage([p('2026-01-01', '2026-03-31', { bank: 'KHAN', account: 'A' }), p('2026-01-01', '2026-03-31', { bank: 'TDB', account: 'A' })], SIX_MONTHS);
    expect(banks.overlaps).toEqual([]);
  });

  it('statements with an unknown account are compared with each other (accounts is empty)', () => {
    const r = analyzeCoverage([p('2026-01-01', '2026-02-15'), p('2026-02-01', '2026-03-31')], SIX_MONTHS);
    expect(r.overlaps).toEqual([{ from: '2026-02-01', to: '2026-02-15', accounts: [] }]);
  });

  it('three statements: the range covered by two or more is reported once', () => {
    const r = analyzeCoverage(
      [p('2026-01-01', '2026-01-20', { account: 'A' }), p('2026-01-10', '2026-01-31', { account: 'A' }), p('2026-01-15', '2026-02-10', { account: 'A' })],
      SIX_MONTHS,
    );
    expect(r.overlaps).toEqual([{ from: '2026-01-10', to: '2026-01-31', accounts: ['A'] }]);
  });

  it('overlaps outside the required period are not reported', () => {
    const r = analyzeCoverage([p('2025-01-01', '2025-06-30', { account: 'A' }), p('2025-03-01', '2025-05-31', { account: 'A' })], SIX_MONTHS);
    expect(r.overlaps).toEqual([]);
  });

  it('per-account gaps: the account misses February even though another account covers it', () => {
    const r = analyzeCoverage(
      [
        p('2026-01-01', '2026-01-31', { bank: 'KHAN', account: 'A' }),
        p('2026-03-01', '2026-03-31', { bank: 'KHAN', account: 'A' }),
        p('2025-10-01', '2026-03-31', { bank: 'TDB', account: 'B' }),
      ],
      SIX_MONTHS,
    );
    expect(r.gaps).toEqual([]);
    expect(r.accountGaps).toEqual([{ from: '2026-02-01', to: '2026-02-28', account: 'KHAN:A' }]);
  });

  it('a single statement per account has no per-account gap', () => {
    expect(analyzeCoverage([p('2025-10-01', '2025-10-31', { account: 'A' })], SIX_MONTHS).accountGaps).toEqual([]);
  });
});

describe('analyzeCoverage — invalid input', () => {
  it('statements with bad dates or from > to are ignored and counted', () => {
    const r = analyzeCoverage([p('2026-13-01', '2026-02-01'), p('2026-03-31', '2026-03-01'), p('garbage', 'x'), p('2025-10-01', '2026-03-31')], SIX_MONTHS);
    expect(r.ignoredPeriods).toBe(3);
    expect(r.coveredMonths).toBe(6);
  });

  it('impossible calendar dates are rejected', () => {
    expect(analyzeCoverage([p('2026-02-30', '2026-03-31')], SIX_MONTHS).ignoredPeriods).toBe(1);
  });

  it('an invalid required period throws', () => {
    expect(() => analyzeCoverage([], { from: '2026-03-31', to: '2026-03-01' })).toThrow(RangeError);
    expect(() => analyzeCoverage([], { from: 'x', to: '2026-03-01' })).toThrow(RangeError);
  });

  it('handles thousands of statements quickly', () => {
    const many: StatementPeriod[] = Array.from({ length: 5000 }, (_, i) => p('2025-10-01', '2025-10-0' + (1 + (i % 9)), { account: String(i % 50) }));
    const t = Date.now();
    const r = analyzeCoverage(many, SIX_MONTHS);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(r.coveredMonths).toBe(0);
  });
});

const txn = (over: Partial<DedupeInput> = {}): DedupeInput => ({
  txnDate: '2026-03-05',
  txnTime: '10:15:30',
  amount: 12500,
  direction: 'EXPENSE',
  balanceAfter: 987500,
  description: 'QPay төлбөр Supermarket',
  ...over,
});

describe('dedupeKey', () => {
  it('is stable and identical for the same transaction', () => {
    expect(dedupeKey(txn())).toBe(dedupeKey(txn()));
  });

  it('ignores case, extra spaces, Latin/Cyrillic look-alikes in the description', () => {
    const k = dedupeKey(txn());
    expect(dedupeKey(txn({ description: '  QPAY  төлбөр   supermarket ' }))).toBe(k);
    expect(dedupeKey(txn({ description: 'QРay төлбөр Supermarket' }))).toBe(k); // кирилл Р
  });

  it('compares time to the minute (seconds may differ between exports)', () => {
    expect(dedupeKey(txn({ txnTime: '10:15:59' }))).toBe(dedupeKey(txn()));
    expect(dedupeKey(txn({ txnTime: '10:16:00' }))).not.toBe(dedupeKey(txn()));
    expect(dedupeKey(txn({ txnTime: null }))).not.toBe(dedupeKey(txn()));
  });

  it('differs when the date, amount, direction, balance or description differ', () => {
    const k = dedupeKey(txn());
    for (const change of [
      { txnDate: '2026-03-06' },
      { amount: 12500.01 },
      { direction: 'INCOME' as const },
      { balanceAfter: 987501 },
      { balanceAfter: null },
      { description: 'Өөр утга' },
    ]) {
      expect(dedupeKey(txn(change)), JSON.stringify(change)).not.toBe(k);
    }
  });

  it('amount and balance are compared at 2 decimals (float noise ignored)', () => {
    expect(dedupeKey(txn({ amount: 12500.000000001, balanceAfter: 987500.0000001 }))).toBe(dedupeKey(txn()));
  });
});

describe('dedupeAcrossStatements', () => {
  const rows = (n: number, start = 0): DedupeInput[] => Array.from({ length: n }, (_, i) => txn({ amount: 1000 + start + i, balanceAfter: 5000 + start + i, description: `d${start + i}` }));

  it('drops the rows that the second statement repeats from the first', () => {
    const a = rows(6, 0); // 0..5
    const b = rows(6, 4); // 4..9 — 4,5 repeat
    const { merged, dropped } = dedupeAcrossStatements([a, b]);
    expect(dropped).toBe(2);
    expect(merged.map((t) => t.description)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']);
  });

  it('keeps genuine repeats inside one statement (the same payment twice)', () => {
    const twice = [txn(), txn(), txn({ amount: 1 })];
    const { merged, dropped } = dedupeAcrossStatements([twice]);
    expect(dropped).toBe(0);
    expect(merged).toHaveLength(3);
  });

  it('keeps the maximum multiplicity when two statements both contain a genuine repeat', () => {
    const { merged, dropped } = dedupeAcrossStatements([[txn(), txn()], [txn(), txn()]]);
    expect(merged).toHaveLength(2);
    expect(dropped).toBe(2);
  });

  it('keeps an extra occurrence that only the later statement has', () => {
    const { merged, dropped } = dedupeAcrossStatements([[txn()], [txn(), txn()]]);
    expect(merged).toHaveLength(2);
    expect(dropped).toBe(1);
  });

  it('the same statement uploaded three times collapses to one copy', () => {
    const a = rows(5);
    const { merged, dropped } = dedupeAcrossStatements([a, [...a], [...a]]);
    expect(merged).toHaveLength(5);
    expect(dropped).toBe(10);
  });

  it('no overlap keeps everything in the original order; empty input is fine', () => {
    const { merged, dropped } = dedupeAcrossStatements([rows(3, 0), rows(3, 100)]);
    expect(dropped).toBe(0);
    expect(merged.map((t) => t.description)).toEqual(['d0', 'd1', 'd2', 'd100', 'd101', 'd102']);
    expect(dedupeAcrossStatements([])).toEqual({ merged: [], dropped: 0 });
    expect(dedupeAcrossStatements([[], []])).toEqual({ merged: [], dropped: 0 });
  });

  it('keeps the original objects (extra fields survive)', () => {
    const a = [{ ...txn(), seq: 1, sourcePage: 3 }];
    const b = [{ ...txn(), seq: 7, sourcePage: 9 }];
    const { merged } = dedupeAcrossStatements([a, b]);
    expect(merged).toEqual(a);
  });
});
