import { describe, expect, it } from 'vitest';
import { MakerCheckerErrorCode } from '@los/contracts';
import { mn } from '@los/ui';
import { ApiError, buildApiError, errorText, isApiError, isConflict, isForbidden } from './errors';

describe('buildApiError', () => {
  it('uses the server message and code of a structured error', () => {
    const e = buildApiError(409, { statusCode: 409, code: 'ALREADY_DECIDED', message: 'Хүсэлт шийдвэрлэгдсэн', details: { id: 1 } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'ALREADY_DECIDED', message: 'Хүсэлт шийдвэрлэгдсэн', details: { id: 1 } });
  });
  it('joins an array of messages', () => {
    expect(buildApiError(400, { code: 'VALIDATION_FAILED', message: ['a', 'b', 3] }).message).toBe('a; b');
  });
  it('falls back to the mn.json text for the code when the message is empty', () => {
    expect(buildApiError(409, { code: 'EXPIRED', message: '  ' }).message).toBe(mn['maker_checker.error.EXPIRED']);
    expect(buildApiError(403, { code: 'SELF_APPROVAL_FORBIDDEN' }).message).toBe(mn['maker_checker.error.SELF_APPROVAL_FORBIDDEN']);
  });
  it('uses the generic text for an unknown code without a message', () => {
    expect(buildApiError(500, { code: 'SOMETHING_NEW' }).message).toBe(mn['maker_checker.error.generic']);
  });
  it('does not trust the message of an unstructured error (proxy / framework text)', () => {
    const e = buildApiError(502, { statusCode: 502, message: 'Bad Gateway' });
    expect(e.code).toBe('HTTP_502');
    expect(e.message).toBe(mn['maker_checker.error.generic']);
  });
  it('survives empty, non-JSON and non-object bodies', () => {
    for (const body of [undefined, null, 'oops', 42]) {
      expect(buildApiError(500, body)).toMatchObject({ status: 500, code: 'HTTP_500', message: mn['maker_checker.error.generic'] });
    }
  });
});

describe('every backend error code has a Mongolian text', () => {
  const codes = MakerCheckerErrorCode; // @los/contracts — backend-ийн бүх код (шинэ код нэмбэл текстгүй бол тест унана)
  it.each(codes)('%s', (code) => {
    const e = buildApiError(400, { code });
    expect(e.message).toBe(mn[`maker_checker.error.${code}` as keyof typeof mn]);
    expect(e.message).not.toBe(mn['maker_checker.error.generic']);
  });
});

describe('errorText / predicates', () => {
  it('shows the message of an ApiError and the generic text for anything else', () => {
    expect(errorText(new ApiError(409, 'EXPIRED', 'Дууссан'))).toBe('Дууссан');
    expect(errorText(new Error('boom'))).toBe(mn['maker_checker.error.generic']);
    expect(errorText('x')).toBe(mn['maker_checker.error.generic']);
  });
  it('detects status codes only on ApiError', () => {
    expect(isForbidden(new ApiError(403, 'FORBIDDEN', 'm'))).toBe(true);
    expect(isForbidden(new ApiError(409, 'EXPIRED', 'm'))).toBe(false);
    expect(isConflict(new ApiError(409, 'EXPIRED', 'm'))).toBe(true);
    expect(isConflict({ status: 409 })).toBe(false);
    expect(isApiError(new ApiError(404, 'NOT_FOUND', 'm'), 404)).toBe(true);
    expect(isApiError(null, 404)).toBe(false);
  });
});
