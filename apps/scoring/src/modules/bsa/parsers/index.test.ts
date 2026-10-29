// Нийтийн гадаргуу (parsers/index.ts): бусад BSA дэд модуль зөвхөн эндээс импортлоно.
import { describe, expect, it } from 'vitest';
import * as api from './index';

describe('parsers public API', () => {
  it('exports the registry, module, verifier, coverage and text-dump helpers', () => {
    for (const name of [
      'ParsersModule',
      'StatementParserRegistry',
      'PARSERS',
      'AmbiguousBankError',
      'UnsupportedBankError',
      'verifyStatement',
      'requiresQr',
      'resolveVerifyOptions',
      'VERIFY_DEFAULTS',
      'checkAuthenticity',
      'StatementVerificationService',
      'QR_VERIFIER',
      'NullQrVerifier',
      'analyzeCoverage',
      'dedupeKey',
      'dedupeAcrossStatements',
      'BANK_PARSERS',
      'statementTextFromDump',
      'DEFAULT_BANK_POLICY',
    ] as const) {
      expect((api as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});
