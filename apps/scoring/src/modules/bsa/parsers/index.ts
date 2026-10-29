// BSA хуулгын parser-ийн нийтийн гадаргуу: бусад BSA дэд модуль (import, classify) зөвхөн эндээс импортлоно.
export type * from './statement.types';
export { ParsersModule } from './parsers.module';
export {
  AmbiguousBankError,
  PARSER_REGISTRY_OPTIONS,
  PARSERS,
  REGISTRY_DEFAULTS,
  StatementParserRegistry,
  UnsupportedBankError,
} from './parser.registry';
export type { BankCandidate, BankDetection, ParserRegistryOptions } from './parser.registry';
export { DEFAULT_BANK_POLICY } from './bank-policy';
export { analyzeCoverage, COVERAGE_DEFAULTS, dedupeAcrossStatements, dedupeKey } from './coverage';
export type { CoverageGap, CoverageOptions, CoverageOverlap, CoverageReport, DateRange, DedupeInput, StatementPeriod } from './coverage';
export { checkAuthenticity } from './verifier/authenticity';
export { NullQrVerifier, QR_VERIFIER } from './verifier/qr-verifier';
export type { QrVerifier } from './verifier/qr-verifier';
export { StatementVerificationService } from './verifier/statement-verification.service';
export { resolveVerifyOptions, VERIFY_DEFAULTS } from './verifier/verify-defaults';
export type { IssueSeverity, SeverityOverride, VerifyCustomer, VerifyOptions, VerifyOptionsInput } from './verifier/verify-defaults';
export { requiresQr, verifyStatement } from './verifier/verify-statement';
export { BANK_PARSERS } from './banks';
export { statementTextFromDump, statementTextToDump } from './engine/text-dump';
