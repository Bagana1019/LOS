// BSA хуулгын parser-ийн Nest модуль. BSA-FR-2, NFR-5: банк нэмэх = banks/index.ts-ийн BANK_PARSERS-д нэг мөр.
import { Module } from '@nestjs/common';
import { BANK_PARSERS } from './banks';
import { PARSERS, StatementParserRegistry } from './parser.registry';
import type { StatementParser } from './statement.types';
import { NullQrVerifier, QR_VERIFIER } from './verifier/qr-verifier';
import { StatementVerificationService } from './verifier/statement-verification.service';

@Module({
  providers: [
    ...BANK_PARSERS,
    { provide: PARSERS, useFactory: (...parsers: StatementParser[]): StatementParser[] => parsers, inject: [...BANK_PARSERS] },
    StatementParserRegistry,
    // TODO(bank API): банкны QR баталгаажуулах endpoint бэлэн болмогц энэ provider-ийг бодит хэрэгжүүлэлтээр солино
    { provide: QR_VERIFIER, useClass: NullQrVerifier },
    StatementVerificationService,
  ],
  exports: [PARSERS, StatementParserRegistry, QR_VERIFIER, StatementVerificationService],
})
export class ParsersModule {}
