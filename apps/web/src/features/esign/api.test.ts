import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../../lib/api';
import {
  declineSigning,
  documentUrl,
  EsignApiError,
  fetchSession,
  fetchStatus,
  fetchVerification,
  isValidSigningToken,
  normalizeVerificationCode,
  signedDocumentUrl,
  startSigning,
  type EsignErrorKind,
} from './api';
import { CODE, jsonResponse, sessionFixture, TOKEN, verificationFixture, waitingSession } from './testing/fixtures';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function rejection(promise: Promise<unknown>): Promise<EsignApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(EsignApiError);
    return err as EsignApiError;
  }
  throw new Error('EsignApiError хүлээсэн боловч амжилттай болсон');
}

describe('токен / код шалгалт', () => {
  it('токен: яг 43 base64url тэмдэгт', () => {
    expect(isValidSigningToken(TOKEN)).toBe(true);
    for (const bad of ['', TOKEN.slice(1), `${TOKEN}A`, `${TOKEN.slice(1)}/`, `${TOKEN.slice(1)}.`, `${TOKEN.slice(1)} `, '../'.repeat(15)]) {
      expect(isValidSigningToken(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('баталгаажуулах код: зураас/жижиг үсгийг зөвшөөрч, I L O U-г хүлээж авахгүй', () => {
    expect(normalizeVerificationCode(CODE)).toBe(CODE);
    expect(normalizeVerificationCode('7k3m-9qz4-t8vx')).toBe(CODE);
    expect(normalizeVerificationCode('  7K3M-9QZ4-T8VX ')).toBe(CODE);
    for (const bad of ['', '7K3M9QZ4T8V', '7K3M9QZ4T8VXX', '7K3M9QZ4T8VI', '7K3M9QZ4T8VL', '7K3M9QZ4T8VO', '7K3M9QZ4T8VU', '7K3M/9QZ4T8V', '../../etc/pas']) {
      expect(normalizeVerificationCode(bad), bad).toBeNull();
    }
  });

  it('document / signed-document URL', () => {
    expect(documentUrl(TOKEN)).toBe(`${API}/public/esign/${TOKEN}/document`);
    expect(signedDocumentUrl(TOKEN)).toBe(`${API}/public/esign/${TOKEN}/signed-document`);
    expect(() => documentUrl('bad')).toThrow(EsignApiError);
    expect(() => signedDocumentUrl('../x')).toThrow(EsignApiError);
  });
});

describe('fetchSession / fetchStatus', () => {
  it('GET {API}/public/esign/{token}: cookie-гүй, кэшгүй, referrer-гүй, redirect дагахгүй', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sessionFixture()));
    const session = await fetchSession(TOKEN);
    expect(session).toEqual(sessionFixture());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/public/esign/${TOKEN}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    expect(init.body).toBeUndefined();
  });

  it('polling нь GET …/status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(waitingSession()));
    await fetchStatus(TOKEN);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/public/esign/${TOKEN}/status`);
  });

  it('AbortSignal-ийг fetch-д дамжуулна', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sessionFixture()));
    const controller = new AbortController();
    await fetchSession(TOKEN, controller.signal);
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('буруу хэлбэрийн токентой бол сүлжээнд хүсэлт гаргахгүй (NOT_FOUND)', async () => {
    const err = await rejection(fetchSession('short'));
    expect(err.kind).toBe('NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('хариу PublicSigningSession-д нийцэхгүй / JSON биш бол INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...sessionFixture(), status: 'WEIRD' }));
    expect((await rejection(fetchSession(TOKEN))).kind).toBe('INVALID_RESPONSE');
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'PENDING' }));
    expect((await rejection(fetchSession(TOKEN))).kind).toBe('INVALID_RESPONSE');
    fetchMock.mockResolvedValueOnce(jsonResponse('<html>gateway</html>'));
    expect((await rejection(fetchSession(TOKEN))).kind).toBe('INVALID_RESPONSE');
  });

  it.each<[number, EsignErrorKind]>([
    [400, 'INVALID_REQUEST'],
    [401, 'INVALID_REQUEST'],
    [403, 'INVALID_REQUEST'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [410, 'GONE'],
    [413, 'INVALID_REQUEST'],
    [422, 'INVALID_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [503, 'SERVER'],
  ])('HTTP %i → %s', async (status, kind) => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'X', message: 'dotood medeelel' }, { status }));
    const err = await rejection(fetchSession(TOKEN));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('429: Retry-After секундийг мс болгож, хэт их утгыг 60 с-ээр хязгаарлана; уншигдахгүй бол null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '7' } }));
    expect((await rejection(fetchSession(TOKEN))).retryAfterMs).toBe(7_000);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '99999' } }));
    expect((await rejection(fetchSession(TOKEN))).retryAfterMs).toBe(60_000);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }));
    expect((await rejection(fetchSession(TOKEN))).retryAfterMs).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 429 }));
    expect((await rejection(fetchSession(TOKEN))).retryAfterMs).toBeNull();
  });

  it('сүлжээний алдаа → NETWORK; цуцлагдсан хүсэлт (AbortError) хэвээр дамжина', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await rejection(fetchSession(TOKEN))).kind).toBe('NETWORK');
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    await expect(fetchSession(TOKEN)).rejects.toBe(abort);
  });

  it('алдааны мессеж/мэдээлэлд токен (URL) орохгүй', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`Failed to fetch ${API}/public/esign/${TOKEN}`));
    const network = await rejection(fetchSession(TOKEN));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: TOKEN }, { status: 500 }));
    const server = await rejection(fetchSession(TOKEN));
    for (const err of [network, server]) {
      expect(err.message).not.toContain(TOKEN);
      expect(err.stack ?? '').not.toContain(TOKEN);
      expect(JSON.stringify({ ...err })).not.toContain(TOKEN);
    }
  });
});

describe('startSigning / declineSigning', () => {
  it('POST …/start {provider, consent:true, consentVersion} JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(waitingSession()));
    const session = await startSigning(TOKEN, { provider: 'TRIDUM', consent: true, consentVersion: 'v1' });
    expect(session.status).toBe('IN_PROGRESS');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/public/esign/${TOKEN}/start`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'TRIDUM', consent: true, consentVersion: 'v1' });
  });

  it('зөвшөөрөлгүй (consent !== true) хүсэлт сүлжээнд гарахгүй', async () => {
    await expect(startSigning(TOKEN, { provider: 'TRIDUM', consent: false as unknown as true, consentVersion: 'v1' })).rejects.toThrow();
    await expect(startSigning(TOKEN, { provider: 'NOPE' as unknown as 'TRIDUM', consent: true, consentVersion: 'v1' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('start: 409 CONFLICT, 429 RATE_LIMITED, 5xx SERVER', async () => {
    for (const [status, kind] of [[409, 'CONFLICT'], [429, 'RATE_LIMITED'], [502, 'SERVER']] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { status }));
      expect((await rejection(startSigning(TOKEN, { provider: 'MONPASS', consent: true, consentVersion: 'v1' }))).kind).toBe(kind);
    }
  });

  it('POST …/decline: бие, Content-Type-гүй', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sessionFixture({ status: 'DECLINED', documentViewed: true })));
    const session = await declineSigning(TOKEN);
    expect(session.status).toBe('DECLINED');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/public/esign/${TOKEN}/decline`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Accept: 'application/json' });
  });
});

describe('fetchVerification', () => {
  it('GET …/verify/{ЗУРААСГҮЙ ТОМ ҮСЭГТЭЙ КОД}', async () => {
    fetchMock.mockResolvedValue(jsonResponse(verificationFixture()));
    const result = await fetchVerification('7k3m-9qz4-t8vx');
    expect(result).toEqual(verificationFixture());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/public/esign/verify/${CODE}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
  });

  it('буруу код сүлжээнд гарахгүй, NOT_FOUND', async () => {
    expect((await rejection(fetchVerification('../../x'))).kind).toBe('NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404 → NOT_FOUND; DTO-д нийцэхгүй хариу → INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'NOT_FOUND' }, { status: 404 }));
    expect((await rejection(fetchVerification(CODE))).kind).toBe('NOT_FOUND');
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true }));
    expect((await rejection(fetchVerification(CODE))).kind).toBe('INVALID_RESPONSE');
  });
});
