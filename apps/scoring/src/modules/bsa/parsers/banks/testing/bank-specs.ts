// TEST HELPER — банк бүрийн ТААМАГЛАСАН хуулгын формат (SYNTHETIC). Бодит файл байхгүй (samples/ хоосон): TODO(samples) — тохируулга
// нь профайлын таамагтай нийцэх ёстой, гэхдээ бодит хуулгыг дүрсэлсэн гэж БОДОХГҮЙ. Бүх нэр/данс/дүн зохиомол.
import type { BankCode } from '@los/contracts';
import { SYNTHETIC_IBAN, SYNTHETIC_REGISTER_NO } from '@los/ocr';
import type { StatementParser } from '../../statement.types';
import {
  DEFAULT_SYN_HEADER,
  generateTransactions,
  renderStatement,
  type SynHeader,
  type SynLayout,
  type SynResult,
  type SynTxn,
} from '../../engine/testing/synthetic-statement';
import { CapitronStatementParser } from '../capitron.parser';
import { GolomtStatementParser } from '../golomt.parser';
import { KhanStatementParser } from '../khan.parser';
import { MbankStatementParser } from '../mbank.parser';
import { StateStatementParser } from '../state.parser';
import { TdbStatementParser } from '../tdb.parser';
import { XacStatementParser } from '../xac.parser';

export const SYNTHETIC_BANNER = 'SYNTHETIC TEST DATA - NOT A REAL STATEMENT';
export const SPEC_OPENING = 3_000_000;

export interface BankSpec {
  bank: BankCode;
  parser: StatementParser;
  /** Хуулгад цаг хэвлэгддэг эсэх (profile.hasTime-тай таарна) */
  withTime: boolean;
  /** Банкны нэр гарчигт (эхний мөрүүдэд) */
  titleLines: string[];
  /** Таамагласан хүснэгтийн бүтэц */
  layout: Partial<SynLayout>;
  header?: Partial<SynHeader>;
}

export const BANK_SPECS: Record<BankCode, BankSpec> = {
  KHAN: {
    bank: 'KHAN',
    parser: new KhanStatementParser(),
    withTime: true,
    titleLines: ['Хаан банк', 'Дансны хуулга'],
    layout: {
      columns: ['date', 'branch', 'prevBalance', 'debit', 'credit', 'balance', 'description', 'counterparty'],
      labelOverrides: { prevBalance: 'Эхний үлдэгдэл', debit: 'Дебит гүйлгээ', credit: 'Кредит гүйлгээ', balance: 'Эцсийн үлдэгдэл' },
      timeInDateCell: true,
      emptyAmount: '0.00',
    },
    header: { iban: SYNTHETIC_IBAN, register: SYNTHETIC_REGISTER_NO },
  },
  GOLOMT: {
    bank: 'GOLOMT',
    parser: new GolomtStatementParser(),
    withTime: false,
    titleLines: ['Golomt Bank', 'Голомт банк - Дансны хуулга'],
    layout: { columns: ['date', 'description', 'debit', 'credit', 'balance', 'counterparty'], dateFormat: 'dmy-dot', emptyAmount: '0.00' },
    header: { iban: SYNTHETIC_IBAN },
  },
  TDB: {
    bank: 'TDB',
    parser: new TdbStatementParser(),
    withTime: true,
    titleLines: ['Худалдаа хөгжлийн банк', 'TDB - Дансны хуулга'],
    layout: { columns: ['date', 'time', 'description', 'income', 'expense', 'balance'], emptyAmount: '', dropEmptyCells: true },
  },
  XAC: {
    bank: 'XAC',
    parser: new XacStatementParser(),
    withTime: false,
    titleLines: ['XacBank', 'Хас банк - Дансны хуулга'],
    layout: { columns: ['seq', 'date', 'description', 'expense', 'income', 'balance'], dateFormat: 'dmy-slash', emptyAmount: '-' },
  },
  CAPITRON: {
    bank: 'CAPITRON',
    parser: new CapitronStatementParser(),
    withTime: false,
    titleLines: ['Капитрон банк', 'Capitron Bank - Statement'],
    layout: { columns: ['date', 'description', 'amount', 'balance'], dateFormat: 'dmy-dot', plusSign: true },
    header: { placement: 'nextCell' },
  },
  STATE: {
    bank: 'STATE',
    parser: new StateStatementParser(),
    withTime: true,
    titleLines: ['Төрийн банк', 'State Bank of Mongolia - Дансны хуулга'],
    layout: { columns: ['date', 'time', 'description', 'amount', 'type', 'balance'], typeStyle: 'drcr', labelOverrides: { type: 'Дт/Кт' } },
  },
  MBANK: {
    bank: 'MBANK',
    parser: new MbankStatementParser(),
    withTime: true,
    titleLines: ['М банк', 'M Bank - Дансны хуулга'],
    layout: { columns: ['date', 'time', 'description', 'debit', 'credit', 'balance'], amountStyle: 'space' },
  },
};

export const ALL_BANKS = Object.keys(BANK_SPECS) as BankCode[];

export type SpecOverrides = Partial<Omit<SynLayout, 'header'>> & { header?: Partial<SynHeader> };

/** Банкны таамагласан формат + нэмэлт override-тай SYNTHETIC хуулга */
export function bankStatement(spec: BankSpec, txns: SynTxn[], overrides: SpecOverrides = {}, opening = SPEC_OPENING): SynResult {
  const header: SynHeader = {
    ...DEFAULT_SYN_HEADER,
    titleLines: [SYNTHETIC_BANNER, ...spec.titleLines],
    ...(spec.header ?? {}),
    ...(overrides.header ?? {}),
  };
  return renderStatement(txns, opening, { ...spec.layout, ...overrides, header });
}

/** Тухайн банкны хуулгад хэдэн гүйлгээ (seed-тэй, хронологи) */
export function specTransactions(spec: BankSpec, seed = 11, count = 16): SynTxn[] {
  return generateTransactions({ seed, count, startDate: '2026-02-26', withTime: spec.withTime, perDay: 2 }, SPEC_OPENING);
}
