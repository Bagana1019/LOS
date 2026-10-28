// Нэгдсэн алдааны хөрвүүлэлт: Nest / multer / body-parser-ийн англи мессеж, ирсэн утга, PII хариунд ХЭЗЭЭ Ч гарахгүй.
import { BadRequestException, ForbiddenException, HttpStatus, Logger, NotFoundException, UnauthorizedException, type ArgumentsHost } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportQueueError } from '../../common/import-queue';
import { BsaNotFoundError, BsaRepositoryError } from '../../common/persistence';
import { BSA_ERROR_MESSAGES, BsaException, conflict } from '../import.errors';
import { BsaExceptionFilter, STATUS_DEFAULTS, toErrorBody } from './bsa-exception.filter';
import { BsaValidationException } from './zod-validation.pipe';

const CYRILLIC = /[Ѐ-ӿ]/;

describe('toErrorBody', () => {
  it('maps a validation failure to 400 VALIDATION_FAILED with issues', () => {
    const body = toErrorBody(new BsaValidationException([{ path: 'a.0', code: 'invalid_type' }]));
    expect(body).toEqual({ statusCode: 400, errorCode: 'VALIDATION_FAILED', message: BSA_ERROR_MESSAGES.VALIDATION_FAILED, issues: [{ path: 'a.0', code: 'invalid_type' }] });
  });

  it('keeps the status, code, Mongolian message and details of domain errors', () => {
    const body = toErrorBody(conflict('JOBS_IN_PROGRESS', { pending: 2, processing: 0 }));
    expect(body).toEqual({ statusCode: 409, errorCode: 'JOBS_IN_PROGRESS', message: BSA_ERROR_MESSAGES.JOBS_IN_PROGRESS, details: { pending: 2, processing: 0 } });
    expect(toErrorBody(new BsaException(HttpStatus.UNPROCESSABLE_ENTITY, 'NO_TRANSACTIONS'))).not.toHaveProperty('details');
  });

  it('replaces framework (English) messages with the status default but keeps our own Mongolian message', () => {
    expect(toErrorBody(new NotFoundException('Cannot GET /api/zxq-secret'))).toEqual({ statusCode: 404, ...STATUS_DEFAULTS[404] });
    expect(toErrorBody(new BadRequestException('Unexpected token z in JSON at position 3'))).toMatchObject({ statusCode: 400, errorCode: 'BAD_REQUEST' });
    expect(toErrorBody(new UnauthorizedException('missing'))).toMatchObject({ statusCode: 401, errorCode: 'UNAUTHENTICATED' });
    expect(toErrorBody(new ForbiddenException('Энэ шинжилгээнд хандах эрхгүй байна.'))).toEqual({
      statusCode: 403, errorCode: 'FORBIDDEN', message: 'Энэ шинжилгээнд хандах эрхгүй байна.',
    });
    expect(toErrorBody(new BadRequestException({ message: ['a must be a string', 'b'] })).message).toBe(STATUS_DEFAULTS[400].message);
  });

  it('maps queue and repository failures to safe responses', () => {
    expect(toErrorBody(new ImportQueueError('REDIS_UNAVAILABLE', 'redis://user:secret@host'))).toEqual({
      statusCode: 503, errorCode: 'QUEUE_UNAVAILABLE', message: BSA_ERROR_MESSAGES.QUEUE_UNAVAILABLE,
    });
    expect(toErrorBody(new BsaNotFoundError('analysis', 'x'))).toMatchObject({ statusCode: 404, errorCode: 'NOT_FOUND' });
    expect(toErrorBody(new BsaRepositoryError('DUPLICATE', 'zxq-secret'))).toMatchObject({ statusCode: 409, errorCode: 'CONFLICT' });
    expect(toErrorBody(new BsaRepositoryError('INVALID', 'zxq-secret'))).toMatchObject({ statusCode: 400, errorCode: 'BAD_REQUEST' });
  });

  it('maps body-parser / http-errors objects by status without their message', () => {
    expect(toErrorBody({ status: 413, type: 'entity.too.large', message: 'request entity too large' })).toEqual({ statusCode: 413, ...STATUS_DEFAULTS[413] });
    expect(toErrorBody({ statusCode: 400, type: 'entity.parse.failed', message: 'Unexpected token z zxq-secret' })).toEqual({ statusCode: 400, ...STATUS_DEFAULTS[400] });
    expect(toErrorBody({ status: 418, message: 'teapot' })).toMatchObject({ statusCode: 418, errorCode: 'BAD_REQUEST' }); // статус хадгална, код нь нийтлэг
  });

  it('turns anything else into 500 INTERNAL_ERROR without leaking the cause', () => {
    for (const cause of [new Error('zxq-secret УБ90010203 boom'), 'string', null, undefined, { status: 200 }, { status: 99999 }]) {
      const body = toErrorBody(cause);
      expect(body).toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR' });
      expect(JSON.stringify(body)).not.toMatch(/zxq|boom|УБ9/);
    }
  });

  it('every status default is a Mongolian message', () => {
    for (const [status, d] of Object.entries(STATUS_DEFAULTS)) {
      expect(d.message, status).toMatch(CYRILLIC);
      expect(d.errorCode, status).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('BsaExceptionFilter.catch', () => {
  let error: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  function fakeHost(overrides: { type?: string; headersSent?: boolean; headers?: Record<string, string> } = {}) {
    const res = {
      headersSent: overrides.headersSent ?? false,
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: undefined as unknown,
      ended: false,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(b: unknown) {
        this.body = b;
      },
      end() {
        this.ended = true;
      },
    };
    const req = { method: 'GET', route: { path: '/bsa/analyses/:id' }, headers: overrides.headers ?? { 'x-user-id': 'u1', 'x-roles': 'ADMIN' } };
    const host = { getType: () => overrides.type ?? 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ArgumentsHost;
    return { host, res, req };
  }

  it('writes the envelope with the correlation id from the request and mirrors it in the header', () => {
    const { host, res } = fakeHost({ headers: { 'x-user-id': 'u1', 'x-roles': 'ADMIN', 'x-correlation-id': 'corr-1' } });
    new BsaExceptionFilter().catch(new NotFoundException('x'), host);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, errorCode: 'NOT_FOUND', correlationId: 'corr-1' });
    expect(res.headers['X-Correlation-Id']).toBe('corr-1');
  });

  it('generates a correlation id when the identity headers are unusable (401/403 before the context exists)', () => {
    const { host, res } = fakeHost({ headers: {} });
    new BsaExceptionFilter().catch(new UnauthorizedException(), host);
    const body = res.body as { correlationId: string };
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['X-Correlation-Id']).toBe(body.correlationId);
  });

  it('logs only method, route template, status and code - never the message or the exception text', () => {
    const { host } = fakeHost();
    const filter = new BsaExceptionFilter();
    filter.catch(new Error('zxq-secret УБ90010203'), host);
    filter.catch(new ForbiddenException('Энэ үйлдлийг хийх эрх байхгүй байна.'), host);
    filter.catch(new NotFoundException(), host);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = [...error.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).toContain('GET /bsa/analyses/:id -> 500 INTERNAL_ERROR');
    expect(logged).toContain('-> 403 FORBIDDEN');
    expect(logged).not.toMatch(/zxq|УБ9|эрх байхгүй/);
  });

  it('does not touch a response that was already sent and rethrows for non-http hosts', () => {
    const { host, res } = fakeHost({ headersSent: true });
    new BsaExceptionFilter().catch(new Error('late'), host);
    expect(res.ended).toBe(true);
    expect(res.body).toBeUndefined();
    const rpc = fakeHost({ type: 'rpc' });
    expect(() => new BsaExceptionFilter().catch(new Error('x'), rpc.host)).toThrowError('x');
  });
});
