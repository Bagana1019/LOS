import { describe, expect, it } from 'vitest';
import { hasMessage } from '../../../lib/i18n';
import { ApiError } from '../../../lib/http';
import { describeApiError, errorKey, GENERIC_ERROR_CODES, isMongolianText, isStaleStateError, retryTransient, type ErrorScope } from './api-error';

const SCOPES: ErrorScope[] = ['collateral', 'document'];
const api = (status: number, code: string | null, message: string, issues?: Array<{ path: string; message: string }>) => new ApiError(status, code, message, issues);

describe('isMongolianText', () => {
  it('монгол мессеж', () => {
    expect(isMongolianText('Хүсэлт олдсонгүй')).toBe(true);
    expect(isMongolianText('Төлөв DRAFT биш')).toBe(true);
  });
  it('англи, кирилл жишээтэй англи, хоосон', () => {
    expect(isMongolianText('Not Found')).toBe(false);
    expect(isMongolianText('Plate number must be 4 digits, e.g. УЕН5246')).toBe(false);
    expect(isMongolianText('')).toBe(false);
    expect(isMongolianText('404')).toBe(false);
  });
});

describe('ерөнхий алдааны орчуулга хоёр scope-д байна', () => {
  it.each(SCOPES.flatMap((s) => GENERIC_ERROR_CODES.map((c) => [s, c] as const)))('%s.error.%s', (scope, code) => {
    expect(hasMessage(errorKey(scope, code))).toBe(true);
  });
  it('retry товчны текст', () => {
    for (const s of SCOPES) expect(hasMessage(`${s}.action.retry`)).toBe(true);
  });
});

describe('describeApiError', () => {
  it('сервер монгол мессеж өгвөл тэр хэвээр (нөхцөлтэй мессеж)', () => {
    const d = describeApiError(api(409, 'COLLATERAL_ALREADY_PLEDGED', 'Энэ хөрөнгө APP-2026-0007 хүсэлтэд барьцаалагдсан'), 'collateral');
    expect(d).toMatchObject({ code: 'COLLATERAL_ALREADY_PLEDGED', status: 409, message: 'Энэ хөрөнгө APP-2026-0007 хүсэлтэд барьцаалагдсан', issues: [] });
  });
  it('англи мессеж + мэдэгдэх код → кодын орчуулга', () => {
    expect(describeApiError(api(409, 'APPLICATION_NOT_EDITABLE', 'Conflict'), 'document').message).toBe('Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө.');
    expect(describeApiError(api(409, 'COLLATERAL_ALREADY_PLEDGED', 'Conflict'), 'collateral').message).toContain('өөр идэвхтэй хүсэлтэд');
  });
  it('мэдэгдэхгүй код: статусаар', () => {
    expect(describeApiError(api(404, 'WHATEVER', 'Not Found'), 'collateral').message).toBe('Олдсонгүй. Хуудсыг шинэчилнэ үү.');
    expect(describeApiError(api(413, null, 'Payload Too Large'), 'document').message).toBe('Файл хэт том байна.');
    expect(describeApiError(api(415, null, 'Unsupported'), 'document').message).toContain('зөвшөөрөгдөөгүй');
    expect(describeApiError(api(502, null, 'Bad Gateway'), 'collateral').message).toContain('Серверийн алдаа');
    expect(describeApiError(api(400, null, 'Bad'), 'collateral').message).toBe('Үйлдэл амжилтгүй боллоо.');
  });
  it('401 / 403 / сүлжээ', () => {
    expect(describeApiError(api(401, 'SESSION_ENDED', 'Нэвтрэх хугацаа дууссан'), 'collateral').message).toContain('Нэвтрэх хугацаа');
    expect(describeApiError(api(403, 'FORBIDDEN', 'Forbidden'), 'collateral').message).toBe('Энэ үйлдлийг хийх эрх байхгүй.');
    expect(describeApiError(new TypeError('Failed to fetch'), 'collateral').message).toContain('Сүлжээний холболт');
    expect(describeApiError(api(0, 'NETWORK_ERROR', 'x'), 'document').message).toContain('Сүлжээний холболт');
  });
  it('VALIDATION_FAILED: монгол мессеж эсвэл «талбар буруу»', () => {
    const d = describeApiError(api(422, 'VALIDATION_FAILED', 'x', [{ path: 'marketValue', message: 'Number must be greater than 0' }, { path: 'note', message: 'Тэмдэглэл хэт урт' }, { path: '', message: 'oops' }]), 'collateral');
    expect(d.message).toContain('Оруулсан мэдээлэл буруу');
    expect(d.issues).toEqual(['marketValue талбар буруу байна', 'Тэмдэглэл хэт урт']);
  });
  it('үл мэдэгдэх утга', () => {
    expect(describeApiError(null, 'collateral').message).toBe('Үйлдэл амжилтгүй боллоо.');
    expect(describeApiError('x', 'document').code).toBeNull();
  });
});

describe('isStaleStateError / retryTransient', () => {
  it('404, 409 нь төлөв зөрсөн', () => {
    expect(isStaleStateError(api(404, null, ''))).toBe(true);
    expect(isStaleStateError(api(409, null, ''))).toBe(true);
    expect(isStaleStateError(api(422, null, ''))).toBe(false);
    expect(isStaleStateError(null)).toBe(false);
  });
  it('4xx дахин оролдохгүй; сүлжээ/сервер нэг удаа', () => {
    expect(retryTransient(0, api(409, null, ''))).toBe(false);
    expect(retryTransient(0, api(422, null, ''))).toBe(false);
    expect(retryTransient(0, api(503, null, ''))).toBe(true);
    expect(retryTransient(1, api(503, null, ''))).toBe(false);
    expect(retryTransient(0, new TypeError('fetch'))).toBe(true);
  });
});
