// TEST HELPER — банк бүрийн parser-т ИЖИЛ багц тест (SYNTHETIC хуулга). Банк тус бүрийн *.parser.test.ts дуудна.
// TODO(samples): эдгээр нь таамагласан формат — бодит файлаар баталгаажаагүй.
import { describe, expect, it } from 'vitest';
import type { ParsedStatement } from '../../statement.types';
import type { SynExpected } from '../../engine/testing/synthetic-statement';
import { REGISTRY_DEFAULTS } from '../../parser.registry';
import { bankStatement, specTransactions, type BankSpec, type SpecOverrides } from './bank-specs';

const strip = <T extends { sourcePage?: number; sourceLine?: number }>(t: T): Omit<T, 'sourcePage' | 'sourceLine'> => {
  const { sourcePage: _p, sourceLine: _l, ...rest } = t;
  return rest;
};

/** Parse-ийн үр дүнг SYNTHETIC "үнэн"-тэй яг тулгана (гүйлгээ бүр + толгойн талбарууд) */
export function expectParsedExactly(parsed: ParsedStatement, expected: SynExpected): void {
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
}

interface Variant {
  name: string;
  overrides: SpecOverrides;
  warns?: string[];
}

const VARIANTS: Variant[] = [
  { name: 'assumed layout', overrides: {} },
  { name: 'newest first', overrides: { newestFirst: true }, warns: ['REVERSED_ORDER'] },
  { name: 'wrapped descriptions', overrides: { wrapAt: 14 } },
  {
    name: 'several pages with repeated headers, subtotal rows and footers',
    overrides: { rowsPerPage: 5, repeatHeader: true, subtotalRows: true, pageFooters: true, pageTitleLines: ['Дансны хуулга (үргэлжлэл)'] },
  },
  { name: 'closing balance and row count in the footer', overrides: { header: { showClosing: true, showCount: true, footerSummary: true } } },
  { name: 'columns separated by double spaces in a single text cell', overrides: { textMode: 'spaced' } },
];

/** Банкны SYNTHETIC хуулгыг ТААМАГЛАСАН форматаар уншиж, detect-ийн үндсэн шаардлагыг шалгана */
export function describeBankParser(spec: BankSpec): void {
  const { parser } = spec;
  describe(`${spec.bank} parser (assumed layout, SYNTHETIC)`, () => {
    it('is registered unverified and stamps bank / parserId / parserVerified', () => {
      expect(parser.bank).toBe(spec.bank);
      expect(parser.verified).toBe(false);
      const { text } = bankStatement(spec, specTransactions(spec));
      const parsed = parser.parse(text);
      expect(parsed.bank).toBe(spec.bank);
      expect(parsed.parserId).toBe(parser.id);
      expect(parsed.parserVerified).toBe(false);
      expect(parser.id).toMatch(/-table-v\d+$/);
    });

    for (const v of VARIANTS) {
      it(`parses exactly: ${v.name}`, () => {
        const { text, expected } = bankStatement(spec, specTransactions(spec), v.overrides);
        const parsed = parser.parse(text);
        expectParsedExactly(parsed, expected);
        const codes = parsed.warnings.map((w) => w.code);
        expect(codes).not.toContain('UNPARSED_ROW');
        expect(codes).not.toContain('DIRECTION_SWAPPED');
        for (const code of v.warns ?? []) expect(codes).toContain(code);
        if (!(v.warns ?? []).includes('REVERSED_ORDER')) expect(codes).not.toContain('REVERSED_ORDER');
      });
    }

    it('time of day is read only when the bank prints it (BSA-BR-5)', () => {
      const { text } = bankStatement(spec, specTransactions(spec));
      const parsed = parser.parse(text);
      for (const t of parsed.transactions) {
        if (spec.withTime) expect(t.txnTime).toMatch(/^\d{2}:\d{2}(:\d{2})?$/);
        else expect(t.txnTime).toBeNull();
      }
    });

    it('detects its own statement above the registry minimum, in every variant', () => {
      for (const v of VARIANTS) {
        const { text } = bankStatement(spec, specTransactions(spec), v.overrides);
        expect(parser.detect(text), v.name).toBeGreaterThanOrEqual(REGISTRY_DEFAULTS.minScore);
      }
    });

    it('does not claim a statement that has only the generic structure (no bank name)', () => {
      const { text } = bankStatement(spec, specTransactions(spec), { header: { titleLines: ['SYNTHETIC TEST DATA - NOT A REAL STATEMENT', 'Дансны хуулга'] } });
      expect(parser.detect(text)).toBeLessThan(REGISTRY_DEFAULTS.minScore);
    });

    it('transaction descriptions that mention bank names do not change the score', () => {
      const plain = specTransactions(spec);
      const noisy = plain.map((t, i) => ({
        ...t,
        description: ['Khan Bank ATM', 'TDB шилжүүлэг', 'Golomt Bank', 'Хас банк', 'Capitron', 'Төрийн банк', 'M Bank', 'State Bank'][i % 8] + ' ' + t.description,
      }));
      const a = parser.detect(bankStatement(spec, plain).text);
      const b = parser.detect(bankStatement(spec, noisy).text);
      expect(b).toBe(a);
    });

    it('returns 0 for empty input and garbage text', () => {
      expect(parser.detect({ source: 'TEXT', pages: [], meta: bankStatement(spec, []).text.meta })).toBe(0);
      const garbage = bankStatement(spec, []).text;
      garbage.pages = [{ pageNo: 1, lines: [{ text: '%%%% ### ???', cells: ['%%%% ### ???'] }] }];
      expect(parser.detect(garbage)).toBe(0);
    });

    it('an empty statement yields no transactions and no crash', () => {
      const { text } = bankStatement(spec, []);
      const parsed = parser.parse(text);
      expect(parsed.transactions).toEqual([]);
    });
  });
}
