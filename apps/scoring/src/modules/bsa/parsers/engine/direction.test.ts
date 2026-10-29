// direction — үлдэгдлийн өөрчлөлтөөр чиглэл, файлын дараалал (шинэ→хуучин), урвуу дебит/кредитийн санал хураалт. SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { detectReversed, flipHint, impliedDirection, voteSwap } from './direction';
import type { RawRow } from './row-parser';

const EPS = 0.011;
const row = (over: Partial<RawRow>): RawRow => ({
  page: 1,
  line: 1,
  date: '2026-03-01',
  time: null,
  amount: 100,
  hint: null,
  weakPositive: false,
  signedNegative: false,
  balance: null,
  descParts: [],
  counterpartyAccount: null,
  counterpartyName: null,
  viaFallback: false,
  ...over,
});

describe('impliedDirection', () => {
  it('income raises the balance, expense lowers it', () => {
    expect(impliedDirection(1000, 1100, 100, EPS)).toBe('INCOME');
    expect(impliedDirection(1000, 900, 100, EPS)).toBe('EXPENSE');
  });

  it('works with cents and tiny float noise', () => {
    expect(impliedDirection(1000.1, 1000.4, 0.3, EPS)).toBe('INCOME');
    expect(impliedDirection(0.3, 0.1, 0.2, EPS)).toBe('EXPENSE');
  });

  it('unknown balances give null', () => {
    expect(impliedDirection(null, 100, 10, EPS)).toBeNull();
    expect(impliedDirection(100, null, 10, EPS)).toBeNull();
  });

  it('a balance change that matches neither direction still picks the closer one', () => {
    expect(impliedDirection(1000, 1090, 100, EPS)).toBe('INCOME');
  });

  it('an amount of zero (both directions equal) is undecidable', () => {
    expect(impliedDirection(1000, 1000, 0, EPS)).toBeNull();
  });
});

describe('detectReversed', () => {
  const dated = (dates: string[]) => dates.map((date, i) => row({ date, balance: 100 + i }));

  it('ascending dates are chronological', () => {
    expect(detectReversed(dated(['2026-03-01', '2026-03-02', '2026-03-03']), EPS)).toEqual({ reversed: false, basis: 'dates' });
  });

  it('descending dates are newest-first', () => {
    expect(detectReversed(dated(['2026-03-03', '2026-03-02', '2026-03-01']), EPS)).toEqual({ reversed: true, basis: 'dates' });
  });

  it('the majority of adjacent pairs decides (a few out-of-order rows do not flip a chronological file)', () => {
    expect(detectReversed(dated(['2026-03-01', '2026-03-02', '2026-03-04', '2026-03-03', '2026-03-05']), EPS).reversed).toBe(false);
  });

  it('same-day rows are ordered by time when both have it', () => {
    const rows = [row({ time: '12:00:00' }), row({ time: '10:00:00' }), row({ time: '09:00:00' })];
    expect(detectReversed(rows, EPS)).toEqual({ reversed: true, basis: 'dates' });
  });

  it('all rows on one day without times: the balance chain tells the direction', () => {
    // хуучин→шинэ: 1000 -100-> 900 -50-> 850 ; файл шинэ→хуучин
    const newestFirst = [row({ amount: 50, balance: 850 }), row({ amount: 100, balance: 900 }), row({ amount: 0.01, balance: 1000 })];
    expect(detectReversed(newestFirst, EPS)).toEqual({ reversed: true, basis: 'balance' });
    const oldestFirst = [row({ amount: 100, balance: 900 }), row({ amount: 50, balance: 850 })];
    expect(detectReversed(oldestFirst, EPS)).toEqual({ reversed: false, basis: 'balance' });
  });

  it('undecidable input (single row, no balances) is not reversed', () => {
    expect(detectReversed([row({})], EPS).reversed).toBe(false);
    expect(detectReversed([row({}), row({})], EPS)).toEqual({ reversed: false, basis: 'none' });
    expect(detectReversed([], EPS).reversed).toBe(false);
  });
});

describe('voteSwap', () => {
  /** opening 1000, rows chronological, hints as the columns say */
  const build = (hints: Array<'INCOME' | 'EXPENSE' | null>, truth: Array<'INCOME' | 'EXPENSE'>) => {
    let bal = 1000;
    return hints.map((hint, i) => {
      bal += truth[i] === 'INCOME' ? 100 : -100;
      return row({ hint, amount: 100, balance: bal });
    });
  };

  it('columns that agree with the balance change are kept', () => {
    const truth = ['INCOME', 'EXPENSE', 'INCOME', 'EXPENSE'] as const;
    expect(voteSwap(build([...truth], [...truth]), 1000, EPS, 3)).toEqual({ swap: false, agree: 4, disagree: 0 });
  });

  it('systematically reversed columns are swapped', () => {
    const truth = ['INCOME', 'EXPENSE', 'INCOME', 'EXPENSE'] as const;
    const reversed = truth.map((d) => (d === 'INCOME' ? 'EXPENSE' : 'INCOME')) as Array<'INCOME' | 'EXPENSE'>;
    expect(voteSwap(build(reversed, [...truth]), 1000, EPS, 3)).toEqual({ swap: true, agree: 0, disagree: 4 });
  });

  it('fewer decided rows than the minimum never swap', () => {
    const truth = ['INCOME', 'EXPENSE'] as const;
    const reversed: Array<'INCOME' | 'EXPENSE'> = ['EXPENSE', 'INCOME'];
    expect(voteSwap(build(reversed, [...truth]), 1000, EPS, 3).swap).toBe(false);
  });

  it('a minority of wrong rows does not swap the whole file', () => {
    const truth = ['INCOME', 'INCOME', 'EXPENSE', 'INCOME', 'EXPENSE'] as const;
    const hints: Array<'INCOME' | 'EXPENSE'> = ['EXPENSE', 'INCOME', 'EXPENSE', 'INCOME', 'EXPENSE'];
    const v = voteSwap(build(hints, [...truth]), 1000, EPS, 3);
    expect(v.swap).toBe(false);
    expect(v).toMatchObject({ agree: 4, disagree: 1 });
  });

  it('rows without a hint or without balances do not vote', () => {
    const rows = [row({ hint: null, balance: 1100 }), row({ hint: 'INCOME', balance: null }), row({ hint: 'INCOME', balance: 1200 })];
    expect(voteSwap(rows, null, EPS, 1)).toEqual({ swap: false, agree: 0, disagree: 0 });
  });

  it('the opening balance gives the first row its previous balance', () => {
    const rows = [row({ hint: 'EXPENSE', amount: 100, balance: 1100 })];
    expect(voteSwap(rows, 1000, EPS, 1)).toMatchObject({ swap: true });
    expect(voteSwap(rows, null, EPS, 1)).toMatchObject({ swap: false, agree: 0, disagree: 0 });
  });
});

describe('flipHint', () => {
  it('flips INCOME and EXPENSE and leaves null', () => {
    const a = row({ hint: 'INCOME' });
    const b = row({ hint: 'EXPENSE' });
    const c = row({ hint: null });
    [a, b, c].forEach(flipHint);
    expect([a.hint, b.hint, c.hint]).toEqual(['EXPENSE', 'INCOME', null]);
  });
});
