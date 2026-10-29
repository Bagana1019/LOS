import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../../lib/api';
import { jsonResponse, staffViewFixture } from '../esign/testing/fixtures';
import { cancelSigning, getSigning, resendSigning, SigningApiError, startSigning, type SigningApiErrorKind } from './api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function rejection(promise: Promise<unknown>): Promise<SigningApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SigningApiError);
    return err as SigningApiError;
  }
  throw new Error('SigningApiError хүлээсэн боловч амжилттай болсон');
}

describe('getSigning', () => {
  it('GET {API}/origination/contracts/{id}/esign, cookie-тэй (credentials: include)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(staffViewFixture({ status: 'IN_PROGRESS', provider: 'TRIDUM' })));
    const view = await getSigning('app-1');
    expect(view?.status).toBe('IN_PROGRESS');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/origination/contracts/app-1/esign`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
    expect(init.body).toBeUndefined();
  });

  it('хүсэлт огт үүсээгүй (404) бол null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Цахим гарын үсгийн хүсэлт олдсонгүй', statusCode: 404 }, { status: 404 }));
    await expect(getSigning('app-1')).resolves.toBeNull();
  });

  it('signingUrl хариунд ирсэн ч (буруу backend) хасагдана — зээлдэгчийн линк ажилтанд хэзээ ч хүрэхгүй', async () => {
    const leaked = { ...staffViewFixture(), signingUrl: 'https://los.example/sign/Zx7Qm2-vL_p9RkT4wYb1NcH8sDfG3jUaEoI6tXe5Wq0' };
    fetchMock.mockResolvedValue(jsonResponse(leaked));
    const view = await getSigning('app-1');
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('signingUrl');
    expect(JSON.stringify(view)).not.toContain('/sign/');
  });

  it('хариу DTO-д нийцэхгүй / JSON биш бол INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'x' }));
    expect((await rejection(getSigning('app-1'))).kind).toBe('INVALID_RESPONSE');
    fetchMock.mockResolvedValueOnce(jsonResponse('<html></html>'));
    expect((await rejection(getSigning('app-1'))).kind).toBe('INVALID_RESPONSE');
  });

  it('сүлжээний алдаа → NETWORK; AbortError хэвээр', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await rejection(getSigning('app-1'))).kind).toBe('NETWORK');
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    await expect(getSigning('app-1')).rejects.toBe(abort);
  });

  it.each(['', '../x', 'a/b', 'a b', 'a?x=1', 'x'.repeat(65), 'а1'])('applicationId %j path-д орохгүй, хүсэлт гарахгүй', async (id) => {
    expect((await rejection(getSigning(id))).kind).toBe('INVALID_REQUEST');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startSigning / resendSigning / cancelSigning', () => {
  it('start: POST, провайдергүй бол {} бие', async () => {
    fetchMock.mockResolvedValue(jsonResponse(staffViewFixture()));
    await startSigning('app-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/origination/contracts/app-1/esign`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('start: сонгосон провайдерыг preferredProvider-аар дамжуулна (бусад талбаргүй)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(staffViewFixture()));
    await startSigning('app-1', 'MONPASS');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ preferredProvider: 'MONPASS' });
  });

  it('resend / cancel: POST …/resend, …/cancel, бие/Content-Type-гүй', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(staffViewFixture()));
    await resendSigning('app-1');
    await cancelSigning('app-1');
    const [resend, cancel] = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(resend[0]).toBe(`${API}/origination/contracts/app-1/esign/resend`);
    expect(cancel[0]).toBe(`${API}/origination/contracts/app-1/esign/cancel`);
    for (const [, init] of [resend, cancel]) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({ Accept: 'application/json' });
    }
  });

  it('амжилттай хариунд signingUrl байхгүй', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ...staffViewFixture({ status: 'PENDING' }), signingUrl: 'https://los.example/sign/secret' }));
    for (const call of [() => startSigning('app-1'), () => resendSigning('app-1'), () => cancelSigning('app-1')]) {
      expect(await call()).not.toHaveProperty('signingUrl');
    }
  });
});

describe('алдааны хөрвүүлэлт', () => {
  it.each<[number, SigningApiErrorKind]>([
    [400, 'INVALID_REQUEST'],
    [401, 'FORBIDDEN'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'INVALID_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [503, 'SERVER'],
  ])('HTTP %i → %s', async (status, kind) => {
    fetchMock.mockImplementation(async () => jsonResponse({ message: 'x' }, { status }));
    const err = await rejection(resendSigning('app-1'));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('backend-ийн монгол тайлбарыг (4xx, 502/503) ажилтанд дамжуулна', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ statusCode: 409, message: 'Идэвхтэй цахим гарын үсгийн хүсэлт байхгүй байна' }, { status: 409 }));
    expect((await rejection(resendSigning('app-1'))).serverMessage).toBe('Идэвхтэй цахим гарын үсгийн хүсэлт байхгүй байна');
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Холбоос илгээж чадсангүй. «Дахин илгээх» үйлдлийг ашиглана уу' }, { status: 503 }));
    expect((await rejection(startSigning('app-1'))).serverMessage).toContain('Дахин илгээх');
  });

  it('500-ийн дотоод мессеж, массив/объект мессеж, HTML бие, хэт урт мессежийг дамжуулахгүй/таслана', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'PrismaClientKnownRequestError: ...' }, { status: 500 }));
    expect((await rejection(startSigning('app-1'))).serverMessage).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: ['a must be string', 'b required'] }, { status: 400 }));
    expect((await rejection(startSigning('app-1'))).serverMessage).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse('<html>Bad gateway</html>', { status: 502 }));
    expect((await rejection(startSigning('app-1'))).serverMessage).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'а'.repeat(1000) }, { status: 409 }));
    expect((await rejection(startSigning('app-1'))).serverMessage).toHaveLength(300);
  });
});
