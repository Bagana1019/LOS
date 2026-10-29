// text-utils — нүд/дүн/цаг/харьцсан дансны туслахууд (engine дотор). SYNTHETIC өгөгдөл.
import { describe, expect, it } from 'vitest';
import { ENGINE_DEFAULTS as cfg } from './defaults';
import { accountCell, amountCell, clip, endsWithAmountPair, findAccountInText, isBlankish, rowCells, timeCell } from './text-utils';

const line = (cells: string[], text = cells.join(' ')) => ({ text, cells });

describe('rowCells', () => {
  it('keeps multi-cell lines as they are, including empty cells', () => {
    expect(rowCells(line(['a', '', 'b']), cfg)).toEqual(['a', '', 'b']);
  });

  it('splits a single-cell line on TAB or two or more spaces', () => {
    expect(rowCells(line(['a\tb\tc']), cfg)).toEqual(['a', 'b', 'c']);
    expect(rowCells(line(['a  b   c d']), cfg)).toEqual(['a', 'b', 'c d']);
  });

  it('a single space does not split (token mode)', () => {
    expect(rowCells(line(['2026-03-01 Цалин 1,000.00']), cfg)).toEqual(['2026-03-01 Цалин 1,000.00']);
  });

  it('falls back to text when cells is empty, and trims', () => {
    expect(rowCells({ text: '  hello ', cells: [] }, cfg)).toEqual(['hello']);
  });

  it('limits cell and line length (adversarial input)', () => {
    const long = 'x'.repeat(cfg.maxLineLength * 3);
    expect(rowCells(line([long]), cfg)[0].length).toBeLessThanOrEqual(cfg.maxLineLength);
    expect(rowCells(line(['a', long]), cfg)[1].length).toBe(cfg.maxCellLength);
  });
});

describe('clip / isBlankish', () => {
  it('clip', () => {
    expect(clip('abcdef', 3)).toBe('abc');
    expect(clip('ab', 3)).toBe('ab');
  });

  it.each(['', ' ', '-', '–', '—', '- -', '.', '  -  '])('"%s" is blank-ish', (s) => expect(isBlankish(s)).toBe(true));
  it.each(['0.00', 'a', '-5', '1-2'])('"%s" is not blank-ish', (s) => expect(isBlankish(s)).toBe(false));
});

describe('amountCell', () => {
  it('reads formatted amounts with their sign', () => {
    expect(amountCell('1,234,567.89', cfg)).toMatchObject({ value: 1234567.89, formatted: true, idLike: false });
    expect(amountCell('-500.00', cfg)?.value).toBe(-500);
    expect(amountCell('(500.00)', cfg)?.value).toBe(-500);
    expect(amountCell('1 234 567', cfg)).toMatchObject({ value: 1234567, formatted: true });
  });

  it('marks long plain integers as ids / phone numbers', () => {
    expect(amountCell('5011223344', cfg)).toMatchObject({ idLike: true, plainLong: true });
    expect(amountCell('99112233', cfg)).toMatchObject({ idLike: false, plainLong: true });
    expect(amountCell('12345', cfg)).toMatchObject({ idLike: false, plainLong: false });
  });

  it('rejects text, dates, times and empty / oversize cells', () => {
    for (const s of ['', 'abc', '2026-03-01', '10:15', 'x'.repeat(50), '1'.repeat(30)]) expect(amountCell(s, cfg), s).toBeNull();
  });
});

describe('timeCell', () => {
  it('reads whole-cell times only', () => {
    expect(timeCell('09:05')).toBe('09:05');
    expect(timeCell(' 14:25:07 ')).toBe('14:25:07');
    expect(timeCell('2026-03-01 10:00')).toBeNull();
    expect(timeCell('Цалин 10:00')).toBeNull();
    expect(timeCell('')).toBeNull();
  });
});

describe('accountCell', () => {
  it('accepts 8-20 digit accounts and MN IBANs', () => {
    expect(accountCell('5011223344', cfg)).toBe('5011223344');
    expect(accountCell('5011-2233 44', cfg)).toBe('5011223344');
    expect(accountCell('MN640005123456789012', cfg)).toBe('MN640005123456789012');
  });

  it('rejects short, long, mixed and amount-like cells', () => {
    for (const s of ['1234567', '1'.repeat(21), 'abc12345678', '12,345.00', '']) expect(accountCell(s, cfg), s).toBeNull();
  });

  it('an 8-digit number starting with 6-9 is a phone when the column is not a dedicated account column', () => {
    expect(accountCell('99112233', cfg, false)).toBeNull();
    expect(accountCell('99112233', cfg, true)).toBe('99112233');
    expect(accountCell('51122334', cfg, false)).toBe('51122334');
  });
});

describe('findAccountInText', () => {
  it('finds a 10-digit account inside a description', () => {
    expect(findAccountInText('Шилжүүлэг 5011223344 орлого', cfg)).toBe('5011223344');
  });

  it('prefers an IBAN', () => {
    expect(findAccountInText('to MN640005123456789012 ref 5011223344', cfg)).toBe('MN640005123456789012');
  });

  it('ignores phone numbers, compact dates, decimals and digits inside longer runs', () => {
    expect(findAccountInText('Утас 99112233 төлбөр', cfg)).toBeNull();
    expect(findAccountInText('огноо 20260310', cfg)).toBeNull();
    expect(findAccountInText('дүн 12345678.50', cfg)).toBeNull();
    expect(findAccountInText('x'.repeat(5) + '1'.repeat(25), cfg)).toBeNull();
  });

  it('an 8-digit number after an account cue is an account', () => {
    expect(findAccountInText('данс 99112233 руу', cfg)).toBe('99112233');
  });

  it('does not backtrack on long digit/text input', () => {
    const t = Date.now();
    findAccountInText('1 '.repeat(5000) + '9'.repeat(4000), cfg);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('endsWithAmountPair', () => {
  it('detects a line that ends with two decimal amounts', () => {
    expect(endsWithAmountPair('Цалин 1,000.00 25,000.50')).toBe(true);
    expect(endsWithAmountPair('Цалин 1,000.00')).toBe(false);
    expect(endsWithAmountPair('ref 12 34')).toBe(false);
    expect(endsWithAmountPair('')).toBe(false);
  });
});
