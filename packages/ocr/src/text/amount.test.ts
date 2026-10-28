import { describe, expect, it } from 'vitest';
import {
  AMOUNT_MAX_FRACTION_DIGITS,
  AMOUNT_MAX_INPUT_LENGTH,
  AMOUNT_MAX_INTEGER_DIGITS,
  parseMnAmount,
} from './amount';

describe('parseMnAmount: numbers', () => {
  it.each([
    // US хэлбэр
    ['1,234,567.89', 1234567.89],
    ['1234567.89', 1234567.89],
    ['1,234,567', 1234567],
    ['12,345', 12345],
    ['1,234', 1234],
    ['0.5', 0.5],
    ['1.5', 1.5],
    ['1.234', 1.234], // хоёрдмол ганц цэг: аравтын
    ['0', 0],
    ['0.00', 0],
    ['100', 100],
    ['123456789012345', 123456789012345], // яг 15 цифр
    ['1,234,567,890,123.45', 1234567890123.45],
    ['1.123456', 1.123456],
    // зайгаар мянгалсан
    ['1 234 567', 1234567],
    ['1\u{A0}234\u{A0}567', 1234567],
    ['1\u{202F}234\u{202F}567', 1234567],
    ['1\u{2009}234', 1234],
    ['1  234', 1234],
    ["1'234'567.89", 1234567.89],
    ['1\u{2019}234', 1234],
    ['1 234 567,89', 1234567.89],
    ['1 234.5', 1234.5],
    // EU хэлбэр
    ['1.234.567,89', 1234567.89],
    ['1.234.567', 1234567],
    ['1,5', 1.5],
    ['0,5', 0.5],
    ['1234,56', 1234.56],
    ['1234,567', 1234.567],
    ['12,3456', 12.3456],
    ['12.345,6', 12345.6],
    // бүтэн өргөнтэй цифр (NFKC)
    ['１２３', 123],
  ])('%j -> %j', (input, expected) => {
    expect(parseMnAmount(input)).toBe(expected);
  });

  it('avoids negative zero', () => {
    expect(Object.is(parseMnAmount('-0'), 0)).toBe(true);
    expect(Object.is(parseMnAmount('(0.00)'), 0)).toBe(true);
  });
});

describe('parseMnAmount: signs', () => {
  it.each([
    ['(1,000.00)', -1000],
    ['( 1,000 )', -1000],
    ['(1.234.567,89)', -1234567.89],
    ['1,000-', -1000],
    ['1,000.00-', -1000],
    ['1,000 -', -1000],
    ['-1,000.50', -1000.5],
    ['- 500', -500],
    ['+500', 500],
    ['+ 1,000.25', 1000.25],
    ['1,000+', 1000],
    ['\u{2212}1,000', -1000], // unicode minus
    ['\u{2013}1,000', -1000], // en dash
    ['1,000\u{2212}', -1000],
  ])('%j -> %j', (input, expected) => {
    expect(parseMnAmount(input)).toBe(expected);
  });

  it.each(['--5', '+-5', '-5-', '+5+', '(5)-', '-(5)', '(-5)', '(+5)', '- -5'])('rejects conflicting sign forms: %j', (input) => {
    expect(parseMnAmount(input)).toBeNull();
  });
});

describe('parseMnAmount: currency noise', () => {
  it.each([
    ['\u{20AE}1,000', 1000],
    ['\u{20AE} 1,000.50', 1000.5],
    ['1,000\u{20AE}', 1000],
    ['1000 MNT', 1000],
    ['1000MNT', 1000],
    ['mnt 1,000.50', 1000.5],
    ['MNT1000', 1000],
    ['1,000 төгрөг', 1000],
    ['1,000 төг.', 1000],
    ['1,000.00 ТӨГРӨГ', 1000],
    ['1 000 000 Төг', 1000000],
    ['-1,000 tugrik', -1000],
    ['1,000 tugrug', 1000],
    ['(1,000.00) MNT', -1000],
    ['MNT -1,000', -1000],
    ['-\u{20AE}1,000', -1000],
  ])('%j -> %j', (input, expected) => {
    expect(parseMnAmount(input)).toBe(expected);
  });

  it('does not strip currency words that are part of other words', () => {
    expect(parseMnAmount('1000 mnts')).toBeNull();
    expect(parseMnAmount('1000 amnt')).toBeNull();
    expect(parseMnAmount('төгрөгийн 1000')).toBeNull();
  });
});

describe('parseMnAmount: not an amount -> null', () => {
  it.each([
    '',
    '   ',
    '\u{200B}',
    'abc',
    'NaN',
    'Infinity',
    '1e5',
    '0x10',
    '-',
    '+',
    '()',
    '(',
    '5.',
    '.5',
    ',5',
    '-.5',
    '1,,000',
    '1..5',
    '1 ,5',
    '1, 5',
    '12abc',
    '1,000abc',
    '12 абц',
    '$100',
    '1/2',
    'MNT',
    '\u{20AE}',
  ])('%j', (input) => {
    expect(parseMnAmount(input)).toBeNull();
  });

  it.each([
    '2026-03-10',
    '2026/03/10',
    '2026.03.10',
    '10.03.2026',
    '10/03/2026',
    '10-03-2026',
    '2026-03-10 12:30:45',
    '12:30',
    '12:30:45',
    '2026 оны 3 дугаар сарын 10',
    '-2026-03-10',
  ])('rejects date/time %j', (input) => {
    expect(parseMnAmount(input)).toBeNull();
  });

  it.each([
    '1234567890123456', // 16 цифр
    '12345678901234567890',
    '1,234,567,890,123,456', // тусгаарлагчтай боловч 16 цифр
    '5011 2345 6789', // дансны дугаар (4-4-4 бүлэг)
    '5011-2345-6789',
    'MN580050099123456789',
    '12 34',
    '1 2345',
    '1,23,456',
    '1.234,567.89',
    '1,234.567,89',
    '1.1234567', // бутархай > 6 цифр
    '1,000.50.25',
    '1.234.567.89',
  ])('rejects account-like / malformed grouping %j', (input) => {
    expect(parseMnAmount(input)).toBeNull();
  });

  it.each(['007', '0012345678', '00.5', '01,234.50', '000'])('rejects leading-zero identifiers %j', (input) => {
    expect(parseMnAmount(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseMnAmount(undefined as unknown as string)).toBeNull();
    expect(parseMnAmount(null as unknown as string)).toBeNull();
    expect(parseMnAmount(1234 as unknown as string)).toBeNull();
  });

  it('never behaves like parseFloat (trailing garbage is rejected)', () => {
    expect(parseFloat('12abc')).toBe(12);
    expect(parseMnAmount('12abc')).toBeNull();
    expect(parseMnAmount('1,000.00 ABC')).toBeNull();
  });
});

describe('parseMnAmount: decimalSeparator option', () => {
  it.each([
    ['1.234', ',', 1234],
    ['1.234.567', ',', 1234567],
    ['1.234,56', ',', 1234.56],
    ['1,234', '.', 1234],
    ['1,234.5', '.', 1234.5],
    ['1 234,5', ',', 1234.5],
    ['1,5', ',', 1.5],
    ['1.5', '.', 1.5],
    ['1.234', 'auto', 1.234],
    ['1,234', 'auto', 1234],
    ['1234', '.', 1234],
    ['1234', ',', 1234],
  ] as const)('%j with %j -> %j', (input, decimalSeparator, expected) => {
    expect(parseMnAmount(input, { decimalSeparator })).toBe(expected);
  });

  it('rejects a separator that the forced convention does not allow', () => {
    expect(parseMnAmount('1.5', { decimalSeparator: ',' })).toBeNull();
    expect(parseMnAmount('1,5', { decimalSeparator: '.' })).toBeNull();
    expect(parseMnAmount('1,5,5', { decimalSeparator: ',' })).toBeNull();
    expect(parseMnAmount('1.5.5', { decimalSeparator: '.' })).toBeNull();
  });
});

describe('parseMnAmount: limits and adversarial input', () => {
  it('documents the limits', () => {
    expect(AMOUNT_MAX_INPUT_LENGTH).toBe(100);
    expect(AMOUNT_MAX_INTEGER_DIGITS).toBe(15);
    expect(AMOUNT_MAX_FRACTION_DIGITS).toBe(6);
  });

  it('trims outer whitespace before the length guard', () => {
    expect(parseMnAmount(`${' '.repeat(500)}5${' '.repeat(500)}`)).toBe(5);
  });

  it('rejects over-long input immediately', () => {
    expect(parseMnAmount('1'.repeat(AMOUNT_MAX_INPUT_LENGTH + 1))).toBeNull();
    expect(parseMnAmount(`1${' 000'.repeat(40)}`)).toBeNull();
  });

  it.each([
    ['digit,comma', '1,'.repeat(50_000)],
    ['digits', '9'.repeat(100_000)],
    ['spaces+digit+spaces', `${' '.repeat(50_000)}x${' '.repeat(50_000)}`],
    ['open paren', `(${'1'.repeat(100_000)}`],
    ['signs', '-'.repeat(100_000)],
    ['noise', 'mnt '.repeat(25_000)],
    ['apostrophes', "1'".repeat(50_000)],
  ])('%s within the time budget', (_name, input) => {
    const started = performance.now();
    expect(parseMnAmount(input)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
