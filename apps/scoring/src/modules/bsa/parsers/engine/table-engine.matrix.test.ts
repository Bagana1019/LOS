// Engine-ийн layout матриц: багана/цаг/дүнгийн хэлбэр/дараалал/wrap/хуудас/дүнгийн мөр бүрийг SYNTHETIC хуулгаар шалгана.
// Бүх нэр/данс/дүн зохиомол. TODO(samples): банк бүрийн бодит формат баталгаажаагүй.
import { describe, expect, it } from 'vitest';
import type { BankProfile } from './bank-profile';
import { parseTableStatement } from './table-engine';
import { DEFAULT_SYN_HEADER, generateTransactions, renderStatement, type SynLayout, type SynTxn } from './testing/synthetic-statement';

const PROFILE: BankProfile = {
  bank: 'KHAN',
  parserId: 'test-profile-v1',
  verified: false,
  nameKeywords: ['Тест банк'],
  dateOrder: 'DMY',
  hasTime: true,
  acceptsImages: true,
};

const OPENING = 2_500_000;
const seed = (n: number, withTime: boolean): SynTxn[] => generateTransactions({ seed: n, count: 14, startDate: '2026-03-05', withTime, perDay: 2 }, OPENING);

interface Case {
  name: string;
  layout: Partial<SynLayout>;
  profile?: Partial<BankProfile>;
  withTime?: boolean;
  /** Хүлээгдэх анхааруулгын кодууд (хамгийн багадаа эдгээр) */
  warns?: string[];
}

const CASES: Case[] = [
  { name: 'debit/credit + time column (ISO)', layout: {} },
  {
    name: 'income/expense, expense first, no time, empty cells dropped (PDF-like)',
    layout: { columns: ['date', 'description', 'expense', 'income', 'balance'], emptyAmount: '', dropEmptyCells: true },
    withTime: false,
    profile: { hasTime: false },
  },
  {
    name: 'signed amount with + sign, time inside date cell, dd/mm/yyyy',
    layout: { columns: ['date', 'description', 'amount', 'balance'], plusSign: true, timeInDateCell: true, dateFormat: 'dmy-slash' },
  },
  {
    name: 'signed amount without + sign (positive means income because the column is signed)',
    layout: { columns: ['date', 'time', 'description', 'amount', 'balance'] },
  },
  { name: 'amount + word type column', layout: { columns: ['date', 'time', 'description', 'amount', 'type', 'balance'], plusSign: true } },
  {
    name: 'unsigned amount + Dr/Cr type column',
    layout: { columns: ['date', 'description', 'type', 'amount', 'balance'], typeStyle: 'drcr', labels: 'en' },
    withTime: false,
    profile: { hasTime: false },
  },
  {
    name: 'systematically reversed debit/credit',
    layout: { debitIsIncome: true },
    warns: ['DIRECTION_SWAPPED'],
  },
  { name: 'newest first', layout: { newestFirst: true }, warns: ['REVERSED_ORDER'] },
  { name: 'newest first + reversed debit/credit', layout: { newestFirst: true, debitIsIncome: true }, warns: ['REVERSED_ORDER', 'DIRECTION_SWAPPED'] },
  { name: 'wrapped descriptions', layout: { wrapAt: 14 } },
  {
    name: 'many pages: repeated headers, subtotal rows, page footers, page titles',
    layout: {
      rowsPerPage: 4,
      repeatHeader: true,
      subtotalRows: true,
      pageFooters: true,
      pageTitleLines: ['Тест банк - Дансны хуулга', 'Данс: 5011223344'],
    },
  },
  { name: 'columns spaced by two spaces in one cell (plain text)', layout: { textMode: 'spaced' } },
  {
    name: 'single-space plain text, plain amounts (token mode)',
    layout: { textMode: 'single', amountStyle: 'plain', columns: ['date', 'time', 'description', 'debit', 'credit', 'balance'] },
  },
  {
    name: "single-space plain text with '1 234 567' amounts",
    layout: { textMode: 'single', amountStyle: 'space', columns: ['date', 'time', 'description', 'debit', 'credit', 'balance'] },
    profile: { spaceThousands: true },
  },
  { name: "'1 234 567.89' amounts in cells", layout: { amountStyle: 'space' } },
  { name: 'English labels, header values in the next cell', layout: { labels: 'en', header: { ...DEFAULT_SYN_HEADER, placement: 'nextCell' } } },
  { name: 'header values on the next line', layout: { header: { ...DEFAULT_SYN_HEADER, placement: 'nextLine' } } },
  {
    name: 'counterparty combined column, branch, seq and value date',
    layout: { columns: ['seq', 'date', 'valueDate', 'time', 'branch', 'description', 'debit', 'credit', 'balance', 'counterparty'] },
  },
  {
    name: 'counterparty account and name columns after the balance',
    layout: { columns: ['date', 'time', 'description', 'debit', 'credit', 'balance', 'counterpartyAccount', 'counterpartyName'], emptyAmount: '-' },
  },
  { name: "dd.mm.yyyy and '-' for empty amounts", layout: { dateFormat: 'dmy-dot', emptyAmount: '-' } },
  { name: 'Mongolian long dates', layout: { dateFormat: 'mn-long', columns: ['date', 'description', 'debit', 'credit', 'balance'] }, withTime: false, profile: { hasTime: false } },
  {
    name: 'closing balance and row count printed at the end',
    layout: { header: { ...DEFAULT_SYN_HEADER, showClosing: true, showCount: true, footerSummary: true } },
  },
  {
    name: 'IBAN and register in the header',
    layout: { header: { ...DEFAULT_SYN_HEADER, iban: 'MN580050099123456789', register: 'УБ90010203' } },
  },
  { name: 'integer amounts without decimals', layout: { decimals: 0, amountStyle: 'comma' } },
  {
    name: 'no balance column, signed amounts',
    layout: { columns: ['date', 'time', 'description', 'amount'], header: { ...DEFAULT_SYN_HEADER, showOpening: false } },
  },
];

const strip = <T extends { sourcePage?: number; sourceLine?: number }>(t: T): Omit<T, 'sourcePage' | 'sourceLine'> => {
  const { sourcePage: _p, sourceLine: _l, ...rest } = t;
  return rest;
};

describe('table engine — layout matrix (synthetic)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const withTime = c.withTime ?? true;
      const { text, expected } = renderStatement(seed(7, withTime), OPENING, c.layout);
      const parsed = parseTableStatement(text, { ...PROFILE, ...c.profile });

      expect(parsed.transactions.map(strip)).toEqual(expected.transactions);
      expect(parsed.accountNo).toBe(expected.accountNo);
      expect(parsed.iban).toBe(expected.iban);
      expect(parsed.holderName).toBe(expected.holderName);
      expect(parsed.holderRegisterNo ?? null).toBe(expected.holderRegisterNo);
      expect(parsed.currency).toBe(expected.currency);
      expect(parsed.periodFrom).toBe(expected.periodFrom);
      expect(parsed.periodTo).toBe(expected.periodTo);
      expect(parsed.openingBalance).toBe(expected.openingBalance);
      expect(parsed.closingBalance).toBe(expected.closingBalance);
      expect(parsed.declaredRowCount).toBe(expected.declaredRowCount);
      const codes = parsed.warnings.map((w) => w.code);
      expect(codes).not.toContain('UNPARSED_ROW');
      for (const code of c.warns ?? []) expect(codes).toContain(code);
      if (!(c.warns ?? []).includes('REVERSED_ORDER')) expect(codes).not.toContain('REVERSED_ORDER');
      if (!(c.warns ?? []).includes('DIRECTION_SWAPPED')) expect(codes).not.toContain('DIRECTION_SWAPPED');
    });
  }
});
