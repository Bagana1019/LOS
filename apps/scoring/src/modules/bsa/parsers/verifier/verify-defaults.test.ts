// VERIFY_DEFAULTS / resolveVerifyOptions — анхдагч ба дарагдах утгууд (NFR-6).
import { describe, expect, it } from 'vitest';
import type { VerificationIssueCode } from '../statement.types';
import { resolveVerifyOptions, VERIFY_DEFAULTS } from './verify-defaults';

const ALL_CODES: VerificationIssueCode[] = [
  'NO_TRANSACTIONS',
  'ROW_COUNT_MISMATCH',
  'BALANCE_CHAIN_BREAK',
  'BALANCE_UNAVAILABLE',
  'OPENING_BALANCE_MISMATCH',
  'CLOSING_BALANCE_MISMATCH',
  'IBAN_INVALID',
  'NAME_MISMATCH',
  'REGISTER_MISMATCH',
  'DATE_ORDER',
  'PERIOD_MISMATCH',
  'DUPLICATE_ROWS',
  'PDF_METADATA_SUSPICIOUS',
  'PDF_MODIFIED',
  'OCR_LOW_CONFIDENCE',
  'QR_NOT_VERIFIED',
  'UNVERIFIED_PARSER',
  'IMAGE_NOT_ACCEPTED',
];

describe('VERIFY_DEFAULTS', () => {
  it('has a default severity for every issue code', () => {
    expect(Object.keys(VERIFY_DEFAULTS.severity).sort()).toEqual([...ALL_CODES].sort());
  });

  it('structural and consistency problems are errors; metadata, order and parser-trust problems are warnings', () => {
    const s = VERIFY_DEFAULTS.severity;
    for (const code of ['NO_TRANSACTIONS', 'ROW_COUNT_MISMATCH', 'BALANCE_CHAIN_BREAK', 'OPENING_BALANCE_MISMATCH', 'CLOSING_BALANCE_MISMATCH', 'IBAN_INVALID', 'NAME_MISMATCH', 'REGISTER_MISMATCH', 'IMAGE_NOT_ACCEPTED'] as const) {
      expect(s[code], code).toBe('ERROR');
    }
    for (const code of ['BALANCE_UNAVAILABLE', 'DATE_ORDER', 'PERIOD_MISMATCH', 'DUPLICATE_ROWS', 'PDF_METADATA_SUSPICIOUS', 'PDF_MODIFIED', 'OCR_LOW_CONFIDENCE', 'QR_NOT_VERIFIED', 'UNVERIFIED_PARSER'] as const) {
      expect(s[code], code).toBe('WARNING');
    }
  });

  it('the numeric defaults are sane', () => {
    expect(VERIFY_DEFAULTS.balanceTolerance).toBeGreaterThan(0);
    expect(VERIFY_DEFAULTS.maxListedBreaks).toBe(10);
    expect(VERIFY_DEFAULTS.minBalanceCoverage).toBeGreaterThan(0);
    expect(VERIFY_DEFAULTS.minBalanceCoverage).toBeLessThanOrEqual(1);
    expect(VERIFY_DEFAULTS.ocrMinConfidence).toBeGreaterThan(0);
    expect(VERIFY_DEFAULTS.ocrMinConfidence).toBeLessThanOrEqual(1);
  });
});

describe('resolveVerifyOptions', () => {
  it('no input gives the defaults (a copy of the severity map, not the shared object)', () => {
    const o = resolveVerifyOptions();
    expect(o.balanceTolerance).toBe(VERIFY_DEFAULTS.balanceTolerance);
    expect(o.severity).toEqual(VERIFY_DEFAULTS.severity);
    expect(o.severity).not.toBe(VERIFY_DEFAULTS.severity);
    o.severity.NAME_MISMATCH = 'OFF';
    expect(VERIFY_DEFAULTS.severity.NAME_MISMATCH).toBe('ERROR');
  });

  it('overrides win, undefined values do not erase defaults, severity is merged per code', () => {
    const o = resolveVerifyOptions({ balanceTolerance: 5, ocrMinConfidence: undefined, severity: { DATE_ORDER: 'ERROR' } });
    expect(o.balanceTolerance).toBe(5);
    expect(o.ocrMinConfidence).toBe(VERIFY_DEFAULTS.ocrMinConfidence);
    expect(o.severity.DATE_ORDER).toBe('ERROR');
    expect(o.severity.NAME_MISMATCH).toBe('ERROR');
  });

  it('a bank that prints non-standard IBANs lowers IBAN_INVALID to WARNING unless set explicitly', () => {
    const policy = { acceptsImages: true, printsNonStandardIban: true };
    expect(resolveVerifyOptions({ policy }).severity.IBAN_INVALID).toBe('WARNING');
    expect(resolveVerifyOptions({ policy, severity: { IBAN_INVALID: 'ERROR' } }).severity.IBAN_INVALID).toBe('ERROR');
    expect(resolveVerifyOptions({ policy: { acceptsImages: true, printsNonStandardIban: false } }).severity.IBAN_INVALID).toBe('ERROR');
  });
});
