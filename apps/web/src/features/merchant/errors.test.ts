import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorCode } from '../../lib/merchant-api';
import { errorMessage, fieldIssues, isNetworkError, isNoAccess, isNotFound, leaseStateMayHaveChanged, retryAfterSeconds, shouldRetry } from './errors';

const err = (status: number, code: ApiErrorCode, details?: Record<string, unknown>, message = 'server-side english message') => new ApiError(status, code, message, details);

describe('isNoAccess / isNotFound / isNetworkError', () => {
  it('401 and 403 mean "no access"', () => {
    expect(isNoAccess(err(401, 'UNAUTHENTICATED'))).toBe(true);
    expect(isNoAccess(err(403, 'FORBIDDEN'))).toBe(true);
    expect(isNoAccess(err(401, 'UNKNOWN'))).toBe(true);
  });
  it('STORE_SCOPE_VIOLATION is an action error, not a page-level no-access', () => {
    expect(isNoAccess(err(403, 'STORE_SCOPE_VIOLATION'))).toBe(false);
  });
  it('other errors and non-ApiErrors are not no-access', () => {
    expect(isNoAccess(err(422, 'VALIDATION_FAILED'))).toBe(false);
    expect(isNoAccess(new Error('x'))).toBe(false);
    expect(isNoAccess(null)).toBe(false);
  });
  it('not found and network', () => {
    expect(isNotFound(err(404, 'NOT_FOUND'))).toBe(true);
    expect(isNotFound(err(422, 'VALIDATION_FAILED'))).toBe(false);
    expect(isNetworkError(err(0, 'NETWORK_ERROR'))).toBe(true);
    expect(isNetworkError(err(500, 'INTERNAL'))).toBe(false);
  });
});

describe('errorMessage', () => {
  it('maps every code to Mongolian text and never leaks the server message', () => {
    const msg = errorMessage(err(422, 'OTP_EXPIRED', undefined, 'SQLSTATE 23505 secret detail'));
    expect(msg).toBe('Кодын хугацаа дууссан. Шинэ код авна уу.');
    expect(msg).not.toContain('SQLSTATE');
  });
  it('uses the detailed variant when numeric details are present', () => {
    expect(errorMessage(err(422, 'DOWN_PAYMENT_TOO_LOW', { minDownPayment: 300000 }))).toContain('300,000₮');
    expect(errorMessage(err(422, 'AMOUNT_OUT_OF_RANGE', { minAmount: 100000, maxAmount: 3000000 }))).toMatch(/100,000₮.*3,000,000₮/);
    expect(errorMessage(err(422, 'TICKET_LIMIT_EXCEEDED', { maxTicketAmount: 8000000 }))).toContain('8,000,000₮');
    expect(errorMessage(err(422, 'DAILY_LIMIT_EXCEEDED', { dailyLimitAmount: 20000000 }))).toContain('20,000,000₮');
    expect(errorMessage(err(422, 'TERM_NOT_ALLOWED', { allowed: [6, 12, 24] }))).toContain('6, 12, 24');
    expect(errorMessage(err(422, 'OTP_INVALID', { attemptsLeft: 2 }))).toBe('Код буруу байна. Үлдсэн оролдлого: 2.');
    expect(errorMessage(err(429, 'OTP_RESEND_TOO_SOON', { retryAfterSeconds: 45 }))).toContain('45');
  });
  it('OTP_ATTEMPTS_EXCEEDED: the send limit (MAX_SENDS) must not tell the user to request a new code', () => {
    const maxSends = errorMessage(err(429, 'OTP_ATTEMPTS_EXCEEDED', { reason: 'MAX_SENDS' }));
    expect(maxSends).toBe('Кодын илгээлтийн хязгаар хэтэрсэн тул шинэ код авах боломжгүй. Энэ лизингийг цуцлаад шинээр үүсгэнэ үү.');
    expect(maxSends).not.toContain('Шинэ код авна уу');
    // MAX_ATTEMPTS ба дутуу/буруу details → хуучин ерөнхий текст
    const generic = 'Оролдлогын эрх дууссан. Шинэ код авна уу эсвэл дараа оролдоно уу.';
    expect(errorMessage(err(429, 'OTP_ATTEMPTS_EXCEEDED', { reason: 'MAX_ATTEMPTS' }))).toBe(generic);
    expect(errorMessage(err(429, 'OTP_ATTEMPTS_EXCEEDED'))).toBe(generic);
    expect(errorMessage(err(429, 'OTP_ATTEMPTS_EXCEEDED', { reason: 5 }))).toBe(generic);
  });
  it('falls back to the generic message when details are missing or malformed', () => {
    expect(errorMessage(err(422, 'OTP_INVALID'))).toBe('Код буруу байна.');
    expect(errorMessage(err(422, 'OTP_INVALID', { attemptsLeft: 'two' }))).toBe('Код буруу байна.');
    expect(errorMessage(err(422, 'TERM_NOT_ALLOWED', { allowed: [] }))).toBe('Энэ хөтөлбөрт сонгосон хугацаа боломжгүй.');
    expect(errorMessage(err(422, 'DOWN_PAYMENT_TOO_LOW', { minDownPayment: Number.NaN }))).toBe('Урьдчилгаа хөтөлбөрийн доод хэмжээнээс бага байна.');
  });
  it('client-side codes and unknown values map to friendly text', () => {
    expect(errorMessage(err(0, 'NETWORK_ERROR'))).toContain('Сүлжээний холболт');
    expect(errorMessage(err(500, 'INTERNAL'))).toContain('Системийн алдаа');
    expect(errorMessage(err(200, 'INVALID_RESPONSE'))).toContain('Серверийн хариу');
    expect(errorMessage(err(418, 'UNKNOWN'))).toBe('Алдаа гарлаа. Дахин оролдоно уу.');
    expect(errorMessage(err(418, 'SOMETHING_NEW' as ApiErrorCode))).toBe('Алдаа гарлаа. Дахин оролдоно уу.');
    expect(errorMessage(new Error('boom'))).toBe('Алдаа гарлаа. Дахин оролдоно уу.');
    expect(errorMessage(undefined)).toBe('Алдаа гарлаа. Дахин оролдоно уу.');
  });
});

describe('leaseStateMayHaveChanged (refetch the lease after a failed mutation)', () => {
  it('true when the server state may have moved on: 409, 503, 5xx, network loss and the matching codes', () => {
    expect(leaseStateMayHaveChanged(err(409, 'INVALID_TRANSITION'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(409, 'MERCHANT_NOT_ACTIVE'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(409, 'CONCURRENT_UPDATE'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(503, 'SCREENING_UNAVAILABLE'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(503, 'SMS_UNAVAILABLE'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(500, 'INTERNAL'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(0, 'NETWORK_ERROR'))).toBe(true);
    // код нь state-changing, status нь өөр ирсэн ч (gateway) таарна
    expect(leaseStateMayHaveChanged(err(422, 'INVALID_TRANSITION'))).toBe(true);
    expect(leaseStateMayHaveChanged(err(422, 'OFFER_EXPIRED'))).toBe(true);
  });
  it('false for plain wrong-code / validation errors: nothing changed on the server', () => {
    expect(leaseStateMayHaveChanged(err(422, 'OTP_INVALID', { attemptsLeft: 2 }))).toBe(false);
    expect(leaseStateMayHaveChanged(err(422, 'OTP_EXPIRED'))).toBe(false);
    expect(leaseStateMayHaveChanged(err(429, 'OTP_RESEND_TOO_SOON', { retryAfterSeconds: 30 }))).toBe(false);
    expect(leaseStateMayHaveChanged(err(429, 'OTP_ATTEMPTS_EXCEEDED', { reason: 'MAX_SENDS' }))).toBe(false);
    expect(leaseStateMayHaveChanged(err(422, 'VALIDATION_FAILED'))).toBe(false);
    expect(leaseStateMayHaveChanged(err(422, 'DAILY_LIMIT_EXCEEDED', { dailyLimitAmount: 1 }))).toBe(false);
    expect(leaseStateMayHaveChanged(new Error('x'))).toBe(false);
    expect(leaseStateMayHaveChanged(undefined)).toBe(false);
  });
});

describe('retryAfterSeconds', () => {
  it('reads the wait from details', () => {
    expect(retryAfterSeconds(err(429, 'OTP_RESEND_TOO_SOON', { retryAfterSeconds: 30 }))).toBe(30);
    expect(retryAfterSeconds(err(429, 'OTP_RESEND_TOO_SOON'))).toBeNull();
    expect(retryAfterSeconds(new Error('x'))).toBeNull();
  });
});

describe('fieldIssues', () => {
  it('splits dotted server paths', () => {
    const e = err(422, 'VALIDATION_FAILED', { issues: [{ path: 'buyer.registerNo', message: 'bad' }, { path: 'goods.price', message: 'bad' }] });
    expect(fieldIssues(e)).toEqual([{ path: ['buyer', 'registerNo'], message: 'bad' }, { path: ['goods', 'price'], message: 'bad' }]);
  });
  it('ignores malformed issues and other error codes', () => {
    expect(fieldIssues(err(422, 'VALIDATION_FAILED', { issues: [null, { path: 5 }, 'x', { path: 'a.b' }] }))).toEqual([{ path: ['a', 'b'], message: '' }]);
    expect(fieldIssues(err(422, 'VALIDATION_FAILED'))).toEqual([]);
    expect(fieldIssues(err(409, 'DUPLICATE_CODE', { issues: [{ path: 'code', message: 'x' }] }))).toEqual([]);
    expect(fieldIssues(new Error('x'))).toEqual([]);
  });
});

describe('shouldRetry (TanStack Query)', () => {
  it('does not retry 4xx contract errors', () => {
    expect(shouldRetry(0, err(422, 'VALIDATION_FAILED'))).toBe(false);
    expect(shouldRetry(0, err(401, 'UNAUTHENTICATED'))).toBe(false);
    expect(shouldRetry(0, err(404, 'NOT_FOUND'))).toBe(false);
  });
  it('retries network errors twice and 5xx once', () => {
    expect(shouldRetry(0, err(0, 'NETWORK_ERROR'))).toBe(true);
    expect(shouldRetry(1, err(0, 'NETWORK_ERROR'))).toBe(true);
    expect(shouldRetry(2, err(0, 'NETWORK_ERROR'))).toBe(false);
    expect(shouldRetry(0, err(500, 'INTERNAL'))).toBe(true);
    expect(shouldRetry(1, err(500, 'INTERNAL'))).toBe(false);
  });
  it('retries unknown thrown values once', () => {
    expect(shouldRetry(0, new TypeError('x'))).toBe(true);
    expect(shouldRetry(1, new TypeError('x'))).toBe(false);
  });
});
