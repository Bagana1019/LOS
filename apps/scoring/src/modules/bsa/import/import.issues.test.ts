// Хадгалагдах issue-н хэлбэр: тогтмол монгол мессеж, код тутамд нэг мөр, PII-гүй.
import { describe, expect, it } from 'vitest';
import { StatementExtractionError } from '../parsers/text-extraction';
import {
  ambiguousBankIssue, extractionIssue, parseWarningIssues, pipelineIssue, PIPELINE_MESSAGES, tooManyRowsIssue, UPLOAD_REJECT_MESSAGES,
  VERIFICATION_MESSAGES, verificationIssues,
} from './import.issues';

describe('verificationIssues', () => {
  it('replaces the verifier English message with the fixed Mongolian one and keeps the location', () => {
    const out = verificationIssues(
      [{ code: 'BALANCE_CHAIN_BREAK', severity: 'ERROR', message: 'row 7 balance 1,234,567.00 of Bat-Erdene does not match', seq: 7, page: 2, line: 5 }],
      { declared: null, read: 20 },
    );
    expect(out).toEqual([{ code: 'BALANCE_CHAIN_BREAK', message: VERIFICATION_MESSAGES.BALANCE_CHAIN_BREAK, severity: 'ERROR', seq: 7, page: 2, line: 5 }]);
    expect(JSON.stringify(out)).not.toMatch(/Bat-Erdene|1,234/);
  });

  it('adds the declared and read counts to a row-count mismatch', () => {
    const [issue] = verificationIssues([{ code: 'ROW_COUNT_MISMATCH', severity: 'ERROR', message: 'x' }], { declared: 99, read: 9 });
    expect(issue.message).toContain('99');
    expect(issue.message).toContain('9');
  });

  it('has a message for every verifier code', () => {
    const codes = Object.keys(VERIFICATION_MESSAGES);
    expect(codes).toEqual(expect.arrayContaining(['NO_TRANSACTIONS', 'BALANCE_CHAIN_BREAK', 'NAME_MISMATCH', 'REGISTER_MISMATCH', 'UNVERIFIED_PARSER']));
    for (const code of codes) expect(VERIFICATION_MESSAGES[code as keyof typeof VERIFICATION_MESSAGES].length).toBeGreaterThan(5);
  });
});

describe('parseWarningIssues', () => {
  it('collapses the warnings to one entry per code with the count and the first location', () => {
    const out = parseWarningIssues([
      { code: 'ROW_FALLBACK_LAYOUT', message: 'Bat-Erdene row', page: 1, line: 10 },
      { code: 'ROW_FALLBACK_LAYOUT', message: 'another', page: 2, line: 3 },
      { code: 'REVERSED_ORDER', message: 'x' },
      { code: 'SOMETHING_NEW', message: 'English text with 5011223344' },
    ]);
    expect(out.map((o) => o.code)).toEqual(['ROW_FALLBACK_LAYOUT', 'REVERSED_ORDER', 'SOMETHING_NEW']);
    expect(out[0]).toMatchObject({ severity: 'WARNING', page: 1, line: 10 });
    expect(out[0].message).toContain('2 удаа');
    expect(out[1].message).not.toContain('удаа');
    expect(JSON.stringify(out)).not.toMatch(/Bat-Erdene|5011223344|another/);
  });
});

describe('other issue builders', () => {
  it('extractionIssue keeps the safe user message', () => {
    const err = new StatementExtractionError('PDF_ENCRYPTED', { detail: 'internal detail with 5011223344' });
    const out = extractionIssue(err);
    expect(out).toMatchObject({ code: 'PDF_ENCRYPTED', severity: 'ERROR' });
    expect(out.message).not.toContain('5011223344');
  });

  it('ambiguous bank lists only bank codes', () => {
    const out = ambiguousBankIssue([{ bank: 'KHAN', parserId: 'khan', score: 0.9 }, { bank: 'TDB', parserId: 'tdb', score: 0.9 }]);
    expect(out.message).toContain('KHAN, TDB');
  });

  it('tooManyRowsIssue states the limit, pipelineIssue defaults to the fixed text', () => {
    expect(tooManyRowsIssue(500).message).toContain('500');
    expect(pipelineIssue('INTERNAL_ERROR')).toEqual({ code: 'INTERNAL_ERROR', message: PIPELINE_MESSAGES.INTERNAL_ERROR, severity: 'ERROR' });
    expect(pipelineIssue('ROWS_SKIPPED_DUPLICATE', 'WARNING').severity).toBe('WARNING');
  });

  it('every upload rejection code has a user message', () => {
    for (const [code, message] of Object.entries(UPLOAD_REJECT_MESSAGES)) expect(message.length, code).toBeGreaterThan(5);
  });
});
