// Multipart -> UploadService оролт, `banks` талбар, бүх файл татгалзагдсан үеийн HTTP статус.
import { describe, expect, it } from 'vitest';
import type { UploadResult } from '../upload.service';
import { assertSomethingHandled, banksByIndex, toUploadInputs } from './upload-request';
import { BsaValidationException } from './zod-validation.pipe';

const rejected = (code: string, index = 0) => ({ index, status: 'REJECTED' as const, code, message: 'm' });
const result = (outcomes: UploadResult['outcomes']): UploadResult => ({
  outcomes,
  accepted: outcomes.filter((o) => o.status === 'ACCEPTED').length,
  duplicates: outcomes.filter((o) => o.status === 'DUPLICATE').length,
  rejected: outcomes.filter((o) => o.status === 'REJECTED').length,
});

describe('banksByIndex', () => {
  it('defaults to automatic detection (null) for every file', () => {
    expect(banksByIndex(undefined, 3)).toEqual([null, null, null]);
  });

  it('accepts an array (index = file order) and an index-keyed object', () => {
    expect(banksByIndex(['KHAN', null, 'TDB'], 3)).toEqual(['KHAN', null, 'TDB']);
    expect(banksByIndex({ 0: 'KHAN', 2: 'TDB' } as never, 3)).toEqual(['KHAN', null, 'TDB']);
    expect(banksByIndex(['MBANK'], 2)).toEqual(['MBANK', null]);
  });

  it('rejects a bank assigned to a file that was not sent, but tolerates trailing nulls', () => {
    expect(() => banksByIndex(['KHAN', 'TDB'], 1)).toThrowError(BsaValidationException);
    expect(() => banksByIndex({ 5: 'KHAN' } as never, 2)).toThrowError(BsaValidationException);
    expect(banksByIndex(['KHAN', null, null], 1)).toEqual(['KHAN']);
  });
});

describe('toUploadInputs', () => {
  it('maps multer parts to service inputs with the per-file bank', () => {
    const parts = [
      { buffer: Buffer.from('a'), originalname: 'a.pdf', mimetype: 'application/pdf' },
      { buffer: Buffer.from('b'), originalname: 'b.csv', mimetype: 'text/csv' },
    ];
    expect(toUploadInputs(parts, ['KHAN'])).toEqual([
      { content: parts[0].buffer, fileName: 'a.pdf', mimeType: 'application/pdf', bankCode: 'KHAN' },
      { content: parts[1].buffer, fileName: 'b.csv', mimeType: 'text/csv', bankCode: null },
    ]);
    expect(toUploadInputs([], undefined)).toEqual([]);
  });
});

describe('assertSomethingHandled', () => {
  it('passes when anything was accepted or was a duplicate, or nothing was rejected', () => {
    expect(() => assertSomethingHandled(result([{ index: 0, status: 'ACCEPTED', jobId: 'j', format: 'PDF' }]))).not.toThrow();
    expect(() => assertSomethingHandled(result([{ index: 0, status: 'DUPLICATE', existingJobId: 'j' }]))).not.toThrow();
    expect(() => assertSomethingHandled(result([rejected('FILE_UNSUPPORTED'), { index: 1, status: 'ACCEPTED', jobId: 'j', format: 'CSV' }]))).not.toThrow();
    expect(() => assertSomethingHandled(result([rejected('FILE_UNSUPPORTED'), { index: 1, status: 'DUPLICATE', existingJobId: 'j' }]))).not.toThrow();
    expect(() => assertSomethingHandled(result([]))).not.toThrow();
  });

  it.each([
    ['FILE_UNSUPPORTED', 415],
    ['XLSX_UNSUPPORTED', 415],
    ['FILE_TOO_LARGE', 413],
    ['FILE_EMPTY', 400],
    ['INVALID_BANK', 400],
    ['QUEUE_UNAVAILABLE', 503],
    ['STORAGE_FAILED', 503],
    ['INTERNAL_ERROR', 500],
  ])('turns an all-rejected upload (%s) into HTTP %i with the outcomes in details', (code, status) => {
    try {
      assertSomethingHandled(result([rejected(code), rejected('FILE_EMPTY', 1)]));
      throw new Error('should have thrown');
    } catch (e) {
      const ex = e as { getStatus(): number; bsaCode: string; details: { outcomes: unknown[]; rejected: number } };
      expect(ex.getStatus()).toBe(status);
      expect(ex.bsaCode).toBe(code);
      expect(ex.details.outcomes).toHaveLength(2);
      expect(ex.details.rejected).toBe(2);
    }
  });

  it('uses 422 for a reject code that has no mapped status', () => {
    try {
      assertSomethingHandled(result([rejected('SOMETHING_NEW')]));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { getStatus(): number }).getStatus()).toBe(422);
    }
  });
});
