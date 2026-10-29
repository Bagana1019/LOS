// Банкны parser-уудын НЭГ бүртгэл (NFR-5). Шинэ банк нэмэх = шинэ <bank>.parser.ts + энэ жагсаалтад нэг мөр.
import type { Type } from '@nestjs/common';
import type { StatementParser } from '../statement.types';
import { CapitronStatementParser } from './capitron.parser';
import { GolomtStatementParser } from './golomt.parser';
import { KhanStatementParser } from './khan.parser';
import { MbankStatementParser } from './mbank.parser';
import { StateStatementParser } from './state.parser';
import { TdbStatementParser } from './tdb.parser';
import { XacStatementParser } from './xac.parser';

export const BANK_PARSERS: ReadonlyArray<Type<StatementParser>> = [
  KhanStatementParser,
  GolomtStatementParser,
  TdbStatementParser,
  XacStatementParser,
  CapitronStatementParser,
  StateStatementParser,
  MbankStatementParser,
];

export { KHAN_PROFILE, KhanStatementParser } from './khan.parser';
export { GOLOMT_PROFILE, GolomtStatementParser } from './golomt.parser';
export { TDB_PROFILE, TdbStatementParser } from './tdb.parser';
export { XAC_PROFILE, XacStatementParser } from './xac.parser';
export { CAPITRON_PROFILE, CapitronStatementParser } from './capitron.parser';
export { STATE_PROFILE, StateStatementParser } from './state.parser';
export { MBANK_PROFILE, MbankStatementParser } from './mbank.parser';
