// BankProfile-аар удирддэг StatementParser. Банк бүрийн parser ийм классыг өргөтгөж зөвхөн profile-ээ дамжуулна (NFR-5).
import type { BankCode } from '@los/contracts';
import type { BankPolicy, ParsedStatement, StatementParser, StatementText } from '../statement.types';
import type { BankProfile } from './bank-profile';
import type { EngineOptions } from './defaults';
import { scoreTableStatement } from './detect';
import { parseTableStatement } from './table-engine';

export class TableStatementParser implements StatementParser {
  readonly bank: BankCode;
  readonly id: string;
  readonly verified: boolean;
  readonly policy: BankPolicy;

  constructor(
    readonly profile: BankProfile,
    private readonly options: EngineOptions = {},
  ) {
    this.bank = profile.bank;
    this.id = profile.parserId;
    this.verified = profile.verified;
    this.policy = { acceptsImages: profile.acceptsImages, printsNonStandardIban: profile.printsNonStandardIban === true };
  }

  detect(text: StatementText): number {
    return scoreTableStatement(text, this.profile, this.options);
  }

  parse(text: StatementText): ParsedStatement {
    return parseTableStatement(text, this.profile, this.options);
  }
}
