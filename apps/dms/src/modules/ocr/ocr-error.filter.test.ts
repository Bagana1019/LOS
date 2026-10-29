import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { OcrError, type OcrErrorCode } from '@los/ocr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateFullError } from './concurrency-gate';
import { OCR_ERROR_HTTP, OcrErrorFilter } from './ocr-error.filter';

const PII = 'ЖЮ85061512 Дорж Болд MN640005123456789012';

function run(exception: OcrError | GateFullError, headers: Record<string, unknown> = {}) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  new OcrErrorFilter().catch(exception, host);
  return { status: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] as Record<string, unknown> };
}

describe('OcrErrorFilter', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const expected: Array<[OcrErrorCode, number]> = [
    ['UNSUPPORTED_MIME', 415],
    ['INVALID_INPUT', 400],
    ['EMPTY_RESULT', 422],
    ['NO_FIXTURE', 422],
    ['ENGINE_UNAVAILABLE', 503],
    ['TIMEOUT', 504],
    ['ENGINE_FAILED', 502],
  ];

  it.each(expected)('%s -> %i', (code, status) => {
    const r = run(new OcrError(code, PII));
    expect(r.status).toBe(status);
    expect(r.body.statusCode).toBe(status);
    expect(r.body.code).toBe(code);
    expect(typeof r.body.message).toBe('string');
    expect(typeof r.body.error).toBe('string');
  });

  it('бүх OcrErrorCode-д зураглал бий', () => {
    expect(Object.keys(OCR_ERROR_HTTP).sort()).toEqual(expected.map(([c]) => c).sort());
  });

  it.each(expected)('%s: exception.message (PII) хариунд ЭСВЭЛ логт орохгүй', (code) => {
    const r = run(new OcrError(code, PII));
    expect(JSON.stringify(r.body)).not.toMatch(/ЖЮ85061512|Дорж|MN6400/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ЖЮ85061512|Дорж|MN6400/);
  });

  it('GateFullError -> 429 BUSY', () => {
    const r = run(new GateFullError());
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('BUSY');
  });

  it('үл мэдэгдэх код ирвэл 502-оор унана (шинэ код нэмэгдсэн ч хариу алдагдахгүй)', () => {
    const e = new OcrError('ENGINE_FAILED', 'x');
    (e as { code: string }).code = 'SOMETHING_NEW';
    const r = run(e);
    expect(r.status).toBe(502);
  });

  it('X-Correlation-Id зөвхөн зөв хэлбэртэй бол логт орно, хариунд орохгүй', () => {
    run(new OcrError('TIMEOUT', 'x'), { 'x-correlation-id': 'req-1' });
    expect(String(warn.mock.calls[0][0])).toContain('"correlationId":"req-1"');
    run(new OcrError('TIMEOUT', 'x'), { 'x-correlation-id': 'bad id\n{"fake":1}' });
    expect(String(warn.mock.calls[1][0])).not.toContain('fake');
    const r = run(new OcrError('TIMEOUT', 'x'), { 'x-correlation-id': 'req-2' });
    expect(JSON.stringify(r.body)).not.toContain('req-2');
  });
});
