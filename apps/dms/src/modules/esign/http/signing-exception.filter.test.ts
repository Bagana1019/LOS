import { BadRequestException, ForbiddenException, HttpException, InternalServerErrorException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreateSigningRequest } from '@los/contracts';
import {
  SigningConflictError, SigningFinalizationError, SigningGoneError, SigningNotFoundError, SigningProviderUnavailableError, SigningTooManyAttemptsError,
  SigningValidationError, SigningWebhookRejectedError, type SigningConflictReason, type SigningError, type SigningGoneReason, type SigningValidationReason,
} from '../errors';
import { captureLogs, type CapturedLogs } from '../signing.test-harness';
import { SigningExceptionFilter } from './signing-exception.filter';

const CYRILLIC = /[Ѐ-ӿ]/;

interface FakeResponse {
  headersSent: boolean;
  headers: Record<string, string>;
  statusCode: number | null;
  payload: unknown;
  destroyed: boolean;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => FakeResponse;
  json: (payload: unknown) => void;
  destroy: () => void;
}

function respond(exception: unknown, options: { headersSent?: boolean; headers?: Record<string, string>; route?: string } = {}): FakeResponse {
  const res: FakeResponse = {
    headersSent: options.headersSent ?? false,
    headers: {},
    statusCode: null,
    payload: undefined,
    destroyed: false,
    setHeader: (name, value) => {
      res.headers[name] = value;
    },
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (payload) => {
      res.payload = payload;
    },
    destroy: () => {
      res.destroyed = true;
    },
  };
  const req = { method: 'POST', headers: options.headers ?? {}, route: options.route === undefined ? undefined : { path: options.route } };
  const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ArgumentsHost;
  new SigningExceptionFilter().catch(exception, host);
  return res;
}

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe('domain алдаа → HTTP', () => {
  const conflict: Record<SigningConflictReason, true> = { ACTIVE_EXISTS: true, INVALID_STATE: true };
  const gone: Record<SigningGoneReason, true> = { EXPIRED: true, TERMINAL: true };
  const validation: Record<SigningValidationReason, true> = {
    DOCUMENT_NOT_VIEWED: true, CONSENT_REQUIRED: true, CONSENT_VERSION_MISMATCH: true, NOT_A_PDF: true, SOURCE_FILE_NOT_FOUND: true, SOURCE_FILE_HASH_MISMATCH: true,
    SIGNED_FILE_HASH_MISMATCH: true, PROVIDER_NOT_AVAILABLE: true, PROVIDER_NOT_ALLOWED: true, INVALID_SIGNER: true,
  };

  const cases: Array<[string, SigningError, number, string, string | undefined]> = [
    ['not found', new SigningNotFoundError(), 404, 'SIGNING_NOT_FOUND', undefined],
    ...(Object.keys(conflict) as SigningConflictReason[]).map((reason): [string, SigningError, number, string, string] => [`conflict ${reason}`, new SigningConflictError(reason, 'req-1'), 409, 'SIGNING_CONFLICT', reason]),
    ...(Object.keys(gone) as SigningGoneReason[]).map((reason): [string, SigningError, number, string, string] => [`gone ${reason}`, new SigningGoneError(reason, 'EXPIRED'), 410, 'SIGNING_GONE', reason]),
    ...(Object.keys(validation) as SigningValidationReason[]).map((reason): [string, SigningError, number, string, string] => [`validation ${reason}`, new SigningValidationError(reason), 400, 'SIGNING_VALIDATION', reason]),
    ['too many attempts', new SigningTooManyAttemptsError(3), 429, 'SIGNING_TOO_MANY_ATTEMPTS', undefined],
    ['provider unavailable (түр)', new SigningProviderUnavailableError(true), 502, 'SIGNING_PROVIDER_UNAVAILABLE', undefined],
    ['provider unavailable (байнгын)', new SigningProviderUnavailableError(false), 502, 'SIGNING_PROVIDER_UNAVAILABLE', undefined],
    ['finalization', new SigningFinalizationError(), 503, 'SIGNING_FINALIZATION_FAILED', undefined],
    ['webhook rejected', new SigningWebhookRejectedError(), 401, 'SIGNING_WEBHOOK_REJECTED', undefined],
  ];

  it.each(cases)('%s', (_name, error, status, code, reason) => {
    const res = respond(error);
    expect(res.statusCode).toBe(status);
    expect(res.payload).toEqual({ code, message: expect.stringMatching(CYRILLIC), ...(reason === undefined ? {} : { reason }) });
    // Алдааны анхны (англи, дотоод) мессеж хэзээ ч гарахгүй
    expect((res.payload as { message: string }).message).not.toBe(error.message);
    expect(JSON.stringify(res.payload)).not.toContain('req-1');
    expect(logs.lines).toEqual([]);
  });

  it('хариу бүр кэшлэгдэхгүй', () => {
    const res = respond(new SigningNotFoundError());
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });

  it('503 нь Retry-After тавина; бусад нь тавихгүй', () => {
    expect(respond(new SigningFinalizationError()).headers['Retry-After']).toBe('5');
    expect(respond(new SigningProviderUnavailableError(true)).headers['Retry-After']).toBeUndefined();
  });

  it('conflict-ийн activeRequestId, gone-ийн status зэрэг дотоод талбар гарахгүй', () => {
    const res = respond(new SigningConflictError('ACTIVE_EXISTS', '3f2c5c3e-aaaa-bbbb-cccc-000000000001'));
    expect(Object.keys(res.payload as object).sort()).toEqual(['code', 'message', 'reason']);
  });
});

describe('zod → 400', () => {
  it('issues: зөвхөн зам ба төрөл; оруулсан утга (PII) гарахгүй', () => {
    const parsed = CreateSigningRequest.safeParse({ signer: { registerNo: 'УА12345633', phone: 'secret-phone', fullName: 'Бат Болд', customerId: 'c' }, ttlHours: 500, preferredProvider: 'DOCUSIGN' });
    expect(parsed.success).toBe(false);
    const res = respond(parsed.success ? null : parsed.error);

    expect(res.statusCode).toBe(400);
    const payload = res.payload as { code: string; message: string; issues: Array<{ path: string; code: string }> };
    expect(payload.code).toBe('REQUEST_INVALID');
    expect(payload.message).toMatch(CYRILLIC);
    expect(payload.issues).toEqual(expect.arrayContaining([
      { path: 'signer.phone', code: 'invalid_string' }, { path: 'ttlHours', code: 'too_big' }, { path: 'preferredProvider', code: 'invalid_enum_value' }, { path: 'applicationId', code: 'invalid_type' },
    ]));
    for (const secret of ['УА12345633', 'secret-phone', 'DOCUSIGN', 'Бат Болд']) expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it('өөр zod хуулбараас (instanceof таардаггүй) ирсэн ZodError-ийг ч таньна', () => {
    const foreign = Object.assign(new Error('x'), { name: 'ZodError', issues: [{ path: ['a', 0, 'b'], code: 'custom', message: 'УА12345633' }] });
    const res = respond(foreign);
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ code: 'REQUEST_INVALID', message: expect.any(String), issues: [{ path: 'a.0.b', code: 'custom' }] });
  });

  it('issues-ийн тоо, замын урт хязгаартай; замд зөвхөн аюулгүй тэмдэгт', () => {
    const many = new z.ZodError(Array.from({ length: 50 }, (_, i) => ({ code: 'custom' as const, path: [`k${i}`], message: 'm' })));
    expect((respond(many).payload as { issues: unknown[] }).issues).toHaveLength(20);
    const weird = new z.ZodError([{ code: 'custom', path: ['<script>', 'x'.repeat(200)], message: 'm' }]);
    const [issue] = (respond(weird).payload as { issues: Array<{ path: string }> }).issues;
    expect(issue.path).toMatch(/^[\w.-]{1,100}$/);
  });
});

describe('Nest/Express-ийн өөрийн алдаа', () => {
  it.each([
    [new NotFoundException('Cannot GET /api/public/esign/SECRETTOKEN/x'), 404, 'NOT_FOUND'],
    [new BadRequestException('Unexpected token УА12345633 in JSON'), 400, 'REQUEST_INVALID'],
    [new ForbiddenException('x'), 403, 'FORBIDDEN'],
    [new HttpException('x', 418), 418, 'REQUEST_REJECTED'],
    [Object.assign(new Error('request entity too large'), { status: 413, expose: true, type: 'entity.too.large' }), 413, 'PAYLOAD_TOO_LARGE'],
    [Object.assign(new Error('unsupported'), { status: 415, expose: true }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('%o → %i %s, анхны мессеж гарахгүй', (error, status, code) => {
    const res = respond(error);
    expect(res.statusCode).toBe(status);
    expect(res.payload).toEqual({ code, message: expect.stringMatching(CYRILLIC) });
    expect(JSON.stringify(res.payload)).not.toMatch(/SECRETTOKEN|УА12345633|Cannot GET|Unexpected token|entity/);
    expect(logs.lines).toEqual([]);
  });
});

describe('танигдаагүй алдаа → 500', () => {
  it.each([
    ['Error', new Error('boom УА12345633 99112233')],
    ['5xx HttpException', new InternalServerErrorException('db УА12345633')],
    ['expose биш http-error', Object.assign(new Error('boom'), { status: 400 })],
    ['status хязгаараас гадна', Object.assign(new Error('boom'), { status: 200, expose: true })],
    ['string шидсэн', 'УА12345633'],
    ['null', null],
  ])('%s: ерөнхий хариу, лог-д PII/мессеж/стек байхгүй', (_name, error) => {
    const res = respond(error, { route: '/api/public/esign/:token', headers: { 'x-correlation-id': 'corr-9' } });
    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({ code: 'INTERNAL_ERROR', message: expect.stringMatching(CYRILLIC) });
    expect(logs.lines).toHaveLength(1);
    expect(JSON.parse(logs.lines[0])).toMatchObject({ event: 'esign.http.unhandled', method: 'POST', route: '/api/public/esign/:token', correlationId: 'corr-9' });
    expect(logs.lines.join('')).not.toMatch(/УА12345633|99112233|boom|db /);
    expect(logs.lines.join('')).not.toContain('    at ');
  });

  it('алдааны нэр, аюулгүй код; хэлбэр буруу кодыг (мөрийн утга агуулж болох) орхино', () => {
    respond(Object.assign(new Error('Failing row contains (УА12345633)'), { name: 'DbOperationError', code: 'P2002' }));
    respond(Object.assign(new Error('x'), { code: 'has spaces and УА12345633' }));
    expect(JSON.parse(logs.lines[0])).toMatchObject({ errorName: 'DbOperationError', errorCode: 'P2002' });
    expect(JSON.parse(logs.lines[1])).not.toHaveProperty('errorCode');
    expect(logs.lines.join('')).not.toContain('УА12345633');
  });

  it('correlation id буруу хэлбэртэй бол лог-д бичихгүй', () => {
    respond(new Error('x'), { headers: { 'x-correlation-id': 'bad id\twith control' } });
    expect(JSON.parse(logs.lines[0])).not.toHaveProperty('correlationId');
  });
});

describe('хариу аль хэдийн эхэлсэн', () => {
  it('PDF stream дундуур алдаа: статус солихгүй, холболтыг таслана', () => {
    const res = respond(new SigningNotFoundError(), { headersSent: true });
    expect(res.destroyed).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(res.payload).toBeUndefined();
  });

  it('танигдаагүй алдааг ч лог-д бичиж, холболтыг таслана', () => {
    const res = respond(new Error('boom'), { headersSent: true });
    expect(res.destroyed).toBe(true);
    expect(logs.lines).toHaveLength(1);
  });
});
