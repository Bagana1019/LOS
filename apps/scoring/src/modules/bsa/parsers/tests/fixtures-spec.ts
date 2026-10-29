// Synthetic fixture-ийн тодорхойлолт (apps/scoring/test-fixtures/bsa/parsers/**). БҮХ өгөгдөл ЗОХИОМОЛ (SYNTHETIC): бодит хуулга, хүн, данс БАЙХГҮЙ.
// Файлууд энэ тодорхойлолтоос үүснэ: `UPDATE_FIXTURES=1 npx vitest run src/modules/bsa/parsers/tests/fixtures.test.ts`.
// TODO(samples): банк бүрийн формат ТААМАГ — бодит хуулгаар солигдтол эдгээр нь зөвхөн engine-ийн регрессийн хамгаалалт.
import type { BankCode } from '@los/contracts';
import { ALL_BANKS, BANK_SPECS, bankStatement, specTransactions, SYNTHETIC_BANNER, type SpecOverrides } from '../banks/testing/bank-specs';
import { statementTextToDump } from '../engine/text-dump';
import type { SynExpected } from '../engine/testing/synthetic-statement';

export interface FixtureDef {
  bank: BankCode;
  name: string;
  seed: number;
  count: number;
  overrides: SpecOverrides;
  description: string;
}

const FOOTER = { showClosing: true, showCount: true, footerSummary: true };

export const FIXTURES: FixtureDef[] = [
  ...ALL_BANKS.flatMap((bank, i): FixtureDef[] => [
    {
      bank,
      name: 'oldest-first',
      seed: 100 + i,
      count: 14,
      overrides: { header: FOOTER },
      description: 'assumed layout, oldest first, closing balance and row count printed at the end',
    },
    {
      bank,
      name: 'newest-first-multipage',
      seed: 200 + i,
      count: 18,
      overrides: { newestFirst: true, rowsPerPage: 6, repeatHeader: true, subtotalRows: true, pageFooters: true, wrapAt: 16, header: { showClosing: true, showCount: true } },
      description: 'newest first, 3 pages with repeated headers, subtotal rows, page footers and wrapped descriptions',
    },
  ]),
  {
    bank: 'GOLOMT',
    name: 'reversed-debit-credit',
    seed: 301,
    count: 16,
    overrides: { debitIsIncome: true, header: FOOTER },
    description: 'debit and credit columns systematically reversed (the engine swaps them back from the balance changes)',
  },
  {
    bank: 'TDB',
    name: 'dropped-cells-wrapped',
    seed: 302,
    count: 16,
    overrides: { emptyAmount: '', dropEmptyCells: true, wrapAt: 14, header: FOOTER },
    description: 'PDF-like: empty cells dropped, descriptions wrapped',
  },
  {
    bank: 'CAPITRON',
    name: 'single-text-cell',
    seed: 303,
    count: 16,
    overrides: { textMode: 'spaced', header: FOOTER },
    description: 'every line is one text cell, columns separated by two spaces (plain-text dump)',
  },
];

export interface BuiltFixture {
  dump: string;
  expected: SynExpected & { _synthetic: true; _note: string };
}

export function buildFixture(def: FixtureDef): BuiltFixture {
  const spec = BANK_SPECS[def.bank];
  const { text, expected } = bankStatement(spec, specTransactions(spec, def.seed, def.count), def.overrides);
  const dump = statementTextToDump(text);
  if (!dump.startsWith(SYNTHETIC_BANNER)) throw new Error('fixture must start with the SYNTHETIC banner');
  return {
    dump,
    expected: {
      _synthetic: true,
      _note: `SYNTHETIC TEST DATA - NOT A REAL STATEMENT. ${def.description}. Assumed ${def.bank} layout (TODO(samples)).`,
      ...expected,
    },
  };
}

/** apps/scoring/test-fixtures/bsa/parsers/<хавтас> — samples/-тэй ижил нэршил */
export const FIXTURE_DIR: Record<BankCode, string> = {
  KHAN: 'khan',
  GOLOMT: 'golomt',
  TDB: 'tdb',
  XAC: 'xac',
  CAPITRON: 'capitron',
  STATE: 'state',
  MBANK: 'm-bank',
};
