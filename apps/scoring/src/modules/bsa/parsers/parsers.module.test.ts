// ParsersModule — DI холболт (explicit @Inject), multi-provider PARSERS, QR_VERIFIER солих. SYNTHETIC хуулгаар.
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { BANK_PARSERS } from './banks';
import { BANK_SPECS, bankStatement, specTransactions } from './banks/testing/bank-specs';
import { ParsersModule } from './parsers.module';
import { PARSERS, StatementParserRegistry } from './parser.registry';
import type { StatementParser } from './statement.types';
import { QR_VERIFIER, type QrVerifier, NullQrVerifier } from './verifier/qr-verifier';
import { StatementVerificationService } from './verifier/statement-verification.service';

describe('ParsersModule', () => {
  it('provides the registry, the seven parsers under PARSERS and the verification service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ParsersModule] }).compile();
    const parsers = moduleRef.get<StatementParser[]>(PARSERS);
    expect(parsers).toHaveLength(BANK_PARSERS.length);
    expect(parsers.map((p) => p.bank).sort()).toEqual(['CAPITRON', 'GOLOMT', 'KHAN', 'MBANK', 'STATE', 'TDB', 'XAC']);
    const registry = moduleRef.get(StatementParserRegistry);
    const spec = BANK_SPECS.XAC;
    const { text } = bankStatement(spec, specTransactions(spec));
    expect(registry.detect(text).parser.bank).toBe('XAC');
    expect(moduleRef.get(StatementVerificationService)).toBeInstanceOf(StatementVerificationService);
    expect(moduleRef.get(QR_VERIFIER)).toBeInstanceOf(NullQrVerifier);
    await moduleRef.close();
  });

  it('registering one more bank needs only one more provider in PARSERS', async () => {
    class ExtraParser implements StatementParser {
      readonly bank = 'KHAN' as const;
      readonly id = 'extra-v1';
      readonly verified = false;
      detect(): number {
        return 0;
      }
      parse(): never {
        throw new Error('not used');
      }
    }
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PARSERS, useFactory: (): StatementParser[] => [new ExtraParser()] },
        StatementParserRegistry,
      ],
    }).compile();
    expect(moduleRef.get(StatementParserRegistry).banks()).toEqual(['KHAN']);
    await moduleRef.close();
  });

  it('the QR verifier can be replaced (overrideProvider) and is used by the verification service', async () => {
    const calls: string[][] = [];
    const stub: QrVerifier = {
      verify: async (payloads) => {
        calls.push(payloads);
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({ imports: [ParsersModule] }).overrideProvider(QR_VERIFIER).useValue(stub).compile();
    const spec = BANK_SPECS.GOLOMT;
    const { text } = bankStatement(spec, specTransactions(spec));
    const parsed = moduleRef.get(StatementParserRegistry).parse(text);
    const result = await moduleRef.get(StatementVerificationService).verify(
      parsed,
      { ...text.meta, mimeType: 'image/png', qrPayloads: ['SYNTHETIC-QR'] },
    );
    expect(calls).toEqual([['SYNTHETIC-QR']]);
    expect(result.qrVerified).toBe(true);
    await moduleRef.close();
  });
});
