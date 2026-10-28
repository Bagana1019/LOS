// Multipart хязгаар (BsaSettings-ээс) ба multer-ийн алдааг монгол errorCode-той домэйн алдаа болгох.
import { BadRequestException, ForbiddenException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BsaException } from '../import.errors';
import { UPLOAD_FIELD, UPLOAD_TECH_LIMITS, mapUploadError, uploadLimits } from './upload.interceptor';

const settings = { maxUploadBytes: 10_000_000, maxFilesPerUpload: 5 };

describe('uploadLimits', () => {
  it('derives file size and count from BsaSettings and bounds the text parts', () => {
    expect(uploadLimits(settings)).toEqual({
      fileSize: 10_000_000,
      files: 5,
      fields: UPLOAD_TECH_LIMITS.maxTextFields,
      fieldSize: UPLOAD_TECH_LIMITS.maxFieldBytes,
      fieldNameSize: UPLOAD_TECH_LIMITS.maxFieldNameBytes,
      parts: 5 + UPLOAD_TECH_LIMITS.extraParts,
    });
    expect(uploadLimits({ maxUploadBytes: 1, maxFilesPerUpload: 1 })).toMatchObject({ fileSize: 1, files: 1 });
  });

  it('uses the "files" form field', () => {
    expect(UPLOAD_FIELD).toBe('files');
  });
});

describe('mapUploadError', () => {
  const asBsa = (e: unknown): BsaException => {
    const mapped = mapUploadError(e, settings);
    expect(mapped).toBeInstanceOf(BsaException);
    return mapped as BsaException;
  };

  it('413 FILE_TOO_LARGE with the configured limit', () => {
    const e = asBsa(new PayloadTooLargeException('File too large'));
    expect([e.getStatus(), e.bsaCode, e.details]).toEqual([413, 'FILE_TOO_LARGE', { maxBytes: 10_000_000 }]);
  });

  it('400 TOO_MANY_FILES with the configured maximum', () => {
    const e = asBsa(new BadRequestException('Too many files'));
    expect([e.getStatus(), e.bsaCode, e.details]).toEqual([400, 'TOO_MANY_FILES', { max: 5 }]);
  });

  it('400 UNEXPECTED_FILE_FIELD for a file sent under another field name', () => {
    expect(asBsa(new BadRequestException('Unexpected field')).bsaCode).toBe('UNEXPECTED_FILE_FIELD');
  });

  it('400 INVALID_MULTIPART for any other malformed multipart request (no raw message passes through)', () => {
    for (const cause of [new BadRequestException('Multipart: Boundary not found'), new Error('Unexpected end of form'), 'weird', null]) {
      const e = asBsa(cause);
      expect([e.getStatus(), e.bsaCode]).toEqual([400, 'INVALID_MULTIPART']);
    }
  });

  it('keeps other HTTP exceptions as they are', () => {
    const forbidden = new ForbiddenException('x');
    expect(mapUploadError(forbidden, settings)).toBe(forbidden);
    expect(mapUploadError(new HttpException('teapot', 418), settings).getStatus()).toBe(418);
  });
});
