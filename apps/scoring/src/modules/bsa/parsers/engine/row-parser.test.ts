// row-parser — нэг мөрийг гүйлгээ болгох: огноо/цаг, баганаар (positional), нүд хасагдсан (DP) ба token горим. SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { compileColumnMatcher, type TableHeader } from './column-matcher';
import { compileProfile } from './compiled-profile';
import { ENGINE_DEFAULTS as cfg } from './defaults';
import { leadingDate, parseRowLine, type RawRow, type RowContext } from './row-parser';

const matcher = compileColumnMatcher(cfg);
const MARKERS = compileProfile({ bank: 'KHAN', parserId: 'test', verified: false, nameKeywords: [], dateOrder: 'DMY', hasTime: true, acceptsImages: true }).markerKeys;
const header = (...cells: string[]): TableHeader => {
  const h = matcher.detectHeader({ text: cells.join(' '), cells });
  if (!h) throw new Error('test header not recognised');
  return h;
};
const ctxOf = (h: TableHeader | null, over: Partial<RowContext> = {}): RowContext => ({
  cfg,
  order: 'DMY',
  header: h,
  debitDir: 'EXPENSE',
  creditDir: 'INCOME',
  spaceThousands: false,
  markerKeys: MARKERS,
  ...over,
});
const rowOf = (cells: string[], ctx: RowContext): RawRow => {
  const r = parseRowLine(cells, 1, 7, ctx);
  if (r.kind !== 'row') throw new Error(`expected a row, got ${r.kind}`);
  return r.row;
};

const DC = header('Огноо', 'Цаг', 'Гүйлгээний утга', 'Дебит', 'Кредит', 'Үлдэгдэл');

describe('leadingDate', () => {
  const lead = (cells: string[], order: 'DMY' | 'MDY' | 'YMD' = 'DMY') => leadingDate(cells, { order });

  it('date in its own cell, then a time cell, then the rest', () => {
    expect(lead(['2026-03-10', '14:25:07', 'Цалин', '1.00'])).toMatchObject({ date: '2026-03-10', time: '14:25:07', rest: ['Цалин', '1.00'] });
  });

  it('date and time in one cell, with a trailing text', () => {
    expect(lead(['2026-03-10 14:25 Цалин'])).toMatchObject({ date: '2026-03-10', time: '14:25', rest: ['Цалин'] });
  });

  it('a sequence number before the date (own cell or same cell)', () => {
    expect(lead(['12', '10.03.2026', 'x'])).toMatchObject({ date: '2026-03-10', dateIdx: 1 });
    expect(lead(['12 10.03.2026 x'])).toMatchObject({ date: '2026-03-10', rest: ['x'] });
  });

  it('a value date after the date is skipped', () => {
    expect(lead(['2026-03-10', '2026-03-11', '09:00', 'Цалин'])).toMatchObject({ date: '2026-03-10', time: '09:00', rest: ['Цалин'] });
  });

  it('numeric dates follow the profile order; long Mongolian dates are read', () => {
    expect(lead(['03/04/2026', 'x'], 'DMY')?.date).toBe('2026-04-03');
    expect(lead(['03/04/2026', 'x'], 'MDY')?.date).toBe('2026-03-04');
    expect(lead(['2026 оны 3 дугаар сарын 5', 'x'])?.date).toBe('2026-03-05');
  });

  it('a line that does not start with a date is not a candidate', () => {
    for (const cells of [['Цалин 2026-03-10'], ['Нийт', '12'], [''], ['2026-13-45', 'x']]) expect(lead(cells), cells.join('|')).toBeNull();
  });
});

describe('parseRowLine — positional (cell count equals the header)', () => {
  it('debit / credit columns give the direction and the balance', () => {
    const row = rowOf(['2026-03-10', '09:15', 'QPay төлбөр', '12,500.00', '0.00', '987,500.00'], ctxOf(DC));
    expect(row).toMatchObject({ date: '2026-03-10', time: '09:15', amount: 12500, hint: 'EXPENSE', balance: 987500, viaFallback: false });
    expect(row.descParts).toEqual(['QPay төлбөр']);
    const income = rowOf(['2026-03-10', '09:15', 'Цалин', '0.00', '2,000,000.00', '3,000,000.00'], ctxOf(DC));
    expect(income).toMatchObject({ amount: 2_000_000, hint: 'INCOME' });
  });

  it("'-' and empty cells mark the empty side", () => {
    expect(rowOf(['2026-03-10', '09:15', 'x', '-', '500.00', '1,500.00'], ctxOf(DC))).toMatchObject({ amount: 500, hint: 'INCOME' });
    expect(rowOf(['2026-03-10', '09:15', 'x', '500.00', '', '1,500.00'], ctxOf(DC))).toMatchObject({ amount: 500, hint: 'EXPENSE' });
  });

  it('debitMeans swaps the meaning of the debit column', () => {
    const swapped = ctxOf(DC, { debitDir: 'INCOME', creditDir: 'EXPENSE' });
    expect(rowOf(['2026-03-10', '09:15', 'x', '500.00', '0.00', '1,500.00'], swapped).hint).toBe('INCOME');
  });

  it('signed amount: the minus sign gives EXPENSE; a plain positive amount is only a weak INCOME', () => {
    const h = header('Огноо', 'Гүйлгээний утга', 'Дүн', 'Үлдэгдэл');
    const out = rowOf(['2026-03-10', 'x', '-500.00', '1,000.00'], ctxOf(h));
    expect(out).toMatchObject({ amount: 500, hint: 'EXPENSE', signedNegative: true });
    const plus = rowOf(['2026-03-10', 'x', '+500.00', '1,500.00'], ctxOf(h));
    expect(plus).toMatchObject({ amount: 500, hint: 'INCOME' });
    const plain = rowOf(['2026-03-10', 'x', '500.00', '1,500.00'], ctxOf(h));
    expect(plain).toMatchObject({ amount: 500, weakPositive: true });
  });

  it('type column words give the direction (Орлого, Зарлага, Дт, Кт, Dr, Cr)', () => {
    const h = header('Огноо', 'Гүйлгээний утга', 'Төрөл', 'Дүн', 'Үлдэгдэл');
    const dir = (word: string) => rowOf(['2026-03-10', 'x', word, '500.00', '1,500.00'], ctxOf(h)).hint;
    expect(dir('Орлого')).toBe('INCOME');
    expect(dir('Зарлага')).toBe('EXPENSE');
    expect(dir('Кт')).toBe('INCOME');
    expect(dir('Дт')).toBe('EXPENSE');
    expect(dir('Cr')).toBe('INCOME');
    expect(dir('Dr')).toBe('EXPENSE');
  });

  it('counterparty account and name columns', () => {
    const h = header('Огноо', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл', 'Харьцсан дансны дугаар', 'Харьцсан дансны нэр');
    const row = rowOf(['2026-03-10', 'x', '5.00', '0.00', '95.00', '5099887766', 'Тест Харилцагч'], ctxOf(h));
    expect(row).toMatchObject({ counterpartyAccount: '5099887766', counterpartyName: 'Тест Харилцагч' });
  });

  it('one counterparty cell is split into account and name', () => {
    const h = header('Огноо', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл', 'Харьцсан данс');
    const row = rowOf(['2026-03-10', 'x', '5.00', '0.00', '95.00', '5099887766 Тест Харилцагч'], ctxOf(h));
    expect(row).toMatchObject({ counterpartyAccount: '5099887766', counterpartyName: 'Тест Харилцагч' });
  });

  it('an unreadable amount in a money column falls back to the right-aligned reading instead of failing', () => {
    const row = rowOf(['2026-03-10', '09:15', 'x', 'abc', '500.00', '1,500.00'], ctxOf(DC));
    expect(row.viaFallback).toBe(true);
    expect(row.amount).toBe(500);
  });
});

describe('parseRowLine — cells dropped (PDF) and token mode', () => {
  it('fewer cells than the header: aligned with the header roles (credit-only row)', () => {
    const row = rowOf(['2026-03-10', '09:15', 'Цалин', '2,000,000.00', '3,000,000.00'], ctxOf(DC));
    expect(row).toMatchObject({ amount: 2_000_000, balance: 3_000_000, viaFallback: true });
    expect(row.hint).toBeNull(); // аль тал нь тодорхойгүй — үлдэгдлээр шийднэ
  });

  it('a counterparty account column that was dropped does not shift the amounts', () => {
    const h = header('Огноо', 'Утга', 'Дебит', 'Кредит', 'Үлдэгдэл', 'Харьцсан данс');
    const row = rowOf(['2026-03-10', 'x', '5.00', '0.00', '95.00'], ctxOf(h));
    expect(row).toMatchObject({ amount: 5, hint: 'EXPENSE', balance: 95, counterpartyAccount: null });
  });

  it('single text cell: amounts from the right, description in between', () => {
    const row = rowOf(['2026-03-10 09:15 QPay төлбөр дэлгүүр 0.00 12,500.00 987,500.00'], ctxOf(DC));
    expect(row).toMatchObject({ date: '2026-03-10', time: '09:15', balance: 987500, viaFallback: true });
    expect(row.descParts.join(' ')).toContain('QPay төлбөр дэлгүүр');
  });

  it("'1 234 567' amounts only when the profile says spaces are thousands separators", () => {
    const on = ctxOf(DC, { spaceThousands: true });
    const row = rowOf(['2026-03-10 09:15 Цалин 0.00 2 000 000.00 3 000 000.00'], on);
    expect(row).toMatchObject({ balance: 3_000_000 });
  });

  it('no table header: the last number is the balance', () => {
    const row = rowOf(['2026-03-10', 'Цалин', '500.00', '1,500.00'], ctxOf(null));
    expect(row).toMatchObject({ amount: 500, balance: 1500 });
  });
});

describe('parseRowLine — other outcomes', () => {
  it('not a transaction line', () => {
    expect(parseRowLine(['Нийт', '12'], 1, 1, ctxOf(DC))).toEqual({ kind: 'none' });
  });

  it('a date with no amounts is dateOnly (a wrapped description line)', () => {
    expect(parseRowLine(['2026-03-10 Тайлбарын үргэлжлэл'], 1, 1, ctxOf(DC))).toEqual({ kind: 'dateOnly' });
  });

  it('both debit and credit filled with different amounts is unparsed', () => {
    const r = parseRowLine(['2026-03-10', '09:15', 'x', '500.00', '300.00', '1,500.00'], 1, 1, ctxOf(DC));
    expect(r.kind).toBe('unparsed');
  });

  it('zero amount is unparsed', () => {
    const r = parseRowLine(['2026-03-10', '09:15', 'x', '0.00', '0.00', '1,500.00'], 1, 1, ctxOf(DC));
    expect(r.kind).toBe('unparsed');
  });

  it('a balance row inside the table is a marker, not a transaction', () => {
    const opening = parseRowLine(['2026-03-01', '', 'Эхний үлдэгдэл', '', '', '1,000,000.00'], 1, 1, ctxOf(DC));
    expect(opening).toEqual({ kind: 'marker', which: 'opening', balance: 1_000_000 });
    const closing = parseRowLine(['2026-03-31', '', 'Эцсийн үлдэгдэл', '', '', '2,500.50'], 1, 1, ctxOf(DC));
    expect(closing).toEqual({ kind: 'marker', which: 'closing', balance: 2500.5 });
  });

  it('a zero-amount row that is not a balance marker is unparsed', () => {
    expect(parseRowLine(['2026-03-01', '', 'Тодорхойгүй', '', '', '1,000.00'], 1, 1, ctxOf(DC)).kind).toBe('unparsed');
  });

  it('every returned amount is positive and finite', () => {
    const row = rowOf(['2026-03-10', '09:15', 'x', '(500.00)', '', '1,500.00'], ctxOf(DC));
    expect(row.amount).toBeGreaterThan(0);
    expect(Number.isFinite(row.amount)).toBe(true);
  });

  it('regression: a strange header whose date column comes after the money columns never makes the alignment loop forever', () => {
    const odd = header('Дебит', 'Кредит', 'Огноо', 'Үлдэгдэл');
    expect(odd.bodyRoles).toContain('date');
    for (const cells of [['2026-03-01 '], ['2026-03-01'], ['2026-03-01', '5.00'], ['2026-03-01', '5.00', '6.00', '7.00', '8.00', '9.00']]) {
      const r = parseRowLine(cells, 1, 1, ctxOf(odd));
      expect(['none', 'dateOnly', 'row', 'unparsed', 'marker']).toContain(r.kind);
    }
  });

  it('adversarial: a very long line with many numbers is handled in linear time', () => {
    const t = Date.now();
    parseRowLine([`2026-03-10 ${'1,000.00 '.repeat(20000)}`], 1, 1, ctxOf(DC));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
