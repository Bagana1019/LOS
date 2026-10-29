import { describe, expect, it } from 'vitest';
import { isStatementExtractionError, STATEMENT_EXTRACTION_MESSAGES, StatementExtractionError, type StatementExtractionErrorCode } from './errors';

const CODES = Object.keys(STATEMENT_EXTRACTION_MESSAGES) as StatementExtractionErrorCode[];

describe('StatementExtractionError', () => {
  it('7 код бүрт монгол (кирилл) аюулгүй мессеж; message = userMessage', () => {
    expect(CODES.sort()).toEqual(['EMPTY', 'OCR_FAILED', 'PDF_CORRUPT', 'PDF_ENCRYPTED', 'PDF_NO_TEXT_LAYER', 'TOO_LARGE', 'UNSUPPORTED_FILE']);
    for (const code of CODES) {
      const e = new StatementExtractionError(code);
      expect(e.code).toBe(code);
      expect(e.message).toMatch(/[А-Яа-яӨөҮү]/);
      expect(e.userMessage).toBe(e.message);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('StatementExtractionError');
    }
  });

  it('detail: ASCII шошго болгон цэвэрлэж 64-д таслана (агуулга логт гарахгүй)', () => {
    expect(new StatementExtractionError('PDF_CORRUPT', { detail: 'Өлзий 2026-03-01 / x' }).detail).toBe('______2026-03-01___x');
    expect(new StatementExtractionError('PDF_CORRUPT', { detail: 'a'.repeat(200) }).detail).toHaveLength(64);
    expect(new StatementExtractionError('PDF_CORRUPT').detail).toBeUndefined();
  });

  it('message-ийг дарж болно (тоо агуулсан хувилбар)', () => {
    expect(new StatementExtractionError('TOO_LARGE', { message: 'өөр' }).message).toBe('өөр');
  });

  it('isStatementExtractionError', () => {
    expect(isStatementExtractionError(new StatementExtractionError('EMPTY'))).toBe(true);
    expect(isStatementExtractionError(new Error('x'))).toBe(false);
    expect(isStatementExtractionError(null)).toBe(false);
  });
});
