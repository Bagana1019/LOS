import { describe, expect, it } from 'vitest';
import { OCR_HTTP_DEFAULTS, readOcrConfig } from './ocr.config';

describe('readOcrConfig', () => {
  it('env хоосон бол анхдагч утгууд', () => {
    expect(readOcrConfig({})).toEqual({
      maxFileBytes: OCR_HTTP_DEFAULTS.maxFileBytes,
      maxConcurrency: OCR_HTTP_DEFAULTS.maxConcurrency,
      maxQueue: OCR_HTTP_DEFAULTS.maxQueue,
    });
    expect(OCR_HTTP_DEFAULTS.maxFileBytes).toBe(10 * 1024 * 1024);
  });

  it('хоосон/зайтай утгыг тохируулаагүй гэж үзнэ', () => {
    expect(readOcrConfig({ OCR_MAX_FILE_BYTES: '', OCR_MAX_CONCURRENCY: '  ' }).maxFileBytes).toBe(OCR_HTTP_DEFAULTS.maxFileBytes);
  });

  it('env-ээр дарна', () => {
    expect(readOcrConfig({ OCR_MAX_FILE_BYTES: '2048', OCR_MAX_CONCURRENCY: '4', OCR_MAX_QUEUE: '0' })).toEqual({
      maxFileBytes: 2048,
      maxConcurrency: 4,
      maxQueue: 0,
    });
  });

  it.each([
    ['OCR_MAX_FILE_BYTES', '0'],
    ['OCR_MAX_FILE_BYTES', '-5'],
    ['OCR_MAX_FILE_BYTES', '1.5'],
    ['OCR_MAX_FILE_BYTES', '10MB'],
    ['OCR_MAX_FILE_BYTES', '999999999999'],
    ['OCR_MAX_CONCURRENCY', '0'],
    ['OCR_MAX_CONCURRENCY', '65'],
    ['OCR_MAX_QUEUE', '-1'],
    ['OCR_MAX_QUEUE', 'abc'],
  ])('%s=%s буруу бол тодорхой Error', (name, value) => {
    expect(() => readOcrConfig({ [name]: value })).toThrow(name);
  });
});
