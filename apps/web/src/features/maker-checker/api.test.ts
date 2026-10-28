import { afterEach, describe, expect, it, vi } from 'vitest';
import { mn } from '@los/ui';
import { API } from '../../lib/api';
import {
  approveRequest,
  buildQuery,
  cancelRequest,
  getRequest,
  getSummary,
  listPolicies,
  listRequests,
  rejectRequest,
  updatePolicy,
} from './api';
import { ApiError } from './errors';

const BASE = `${API}/origination/maker-checker`;
const ID = '0b9a6d5e-3c1f-4c0e-9a4e-7a1f2f1c9d11';
const ISO = '2026-10-28T06:00:00.000Z';

const dto = (over: Record<string, unknown> = {}) => ({
  id: ID, orgId: 'org', branchId: null, targetType: 'BLACKLIST_ENTRY', targetId: 'REG1', action: 'UPDATE', applicationId: null,
  mode: 'FOUR_EYES', status: 'PENDING', payload: { a: 1 }, before: { a: 0 }, baseVersion: null, reason: 'Шалтгаан',
  makerId: 'u1', makerRoles: ['OFFICER'], requiredCheckerRoles: ['APPROVER'], checkerId: null, checkerRoles: [], checkerComment: null,
  failureReason: null, expiresAt: ISO, decidedAt: null, createdAt: ISO, updatedAt: ISO, canDecide: true, canCancel: false, ...over,
});
const policy = {
  targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', enabled: true, checkerRoles: ['APPROVER'], expiresInHours: 48,
  configured: false, locked: false, makerRoles: ['OFFICER'], updatedAt: null, updatedBy: null,
};

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}
const lastCall = (fn: ReturnType<typeof stubFetch>) => {
  const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
};

afterEach(() => vi.unstubAllGlobals());

describe('buildQuery', () => {
  it('skips empty values and encodes the rest', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: '', e: 'x y' })).toBe('?a=1&e=x+y');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ page: 0 })).toBe('?page=0');
  });
});

describe('requests', () => {
  it('lists with scope, status and paging, sending credentials', async () => {
    const f = stubFetch(200, { items: [dto()], total: 1, page: 2, pageSize: 50 });
    const page = await listRequests({ scope: 'mine', status: 'PENDING', page: 2, pageSize: 50 });
    const { url, init } = lastCall(f);
    expect(url).toBe(`${BASE}/requests?scope=mine&status=PENDING&page=2&pageSize=50`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
    expect(init.body).toBeUndefined();
    expect(page.items[0]?.id).toBe(ID);
    expect(page.total).toBe(1);
  });

  it('loads summary and one request (id is URL-encoded)', async () => {
    stubFetch(200, { inbox: 3, mine: 1 });
    expect(await getSummary()).toEqual({ inbox: 3, mine: 1 });
    const f = stubFetch(200, dto({ history: [] }));
    await getRequest('a/b');
    expect(lastCall(f).url).toBe(`${BASE}/requests/a%2Fb`);
  });

  it('approve / reject / cancel POST a trimmed comment', async () => {
    let f = stubFetch(200, dto({ status: 'APPLIED' }));
    await approveRequest(ID, '  ok  ');
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/requests/${ID}/approve`, body: { comment: 'ok' } });
    expect(lastCall(f).init).toMatchObject({ method: 'POST', credentials: 'include' });

    f = stubFetch(200, dto({ status: 'REJECTED' }));
    await rejectRequest(ID, '  Буруу  ');
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/requests/${ID}/reject`, body: { comment: 'Буруу' } });

    f = stubFetch(200, dto({ status: 'CANCELLED' }));
    await cancelRequest(ID);
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/requests/${ID}/cancel`, body: {} });
  });
});

describe('policies', () => {
  it('lists policies', async () => {
    const f = stubFetch(200, [policy]);
    const list = await listPolicies();
    expect(lastCall(f).url).toBe(`${BASE}/policies`);
    expect(list[0]).toMatchObject({ targetType: 'BLACKLIST_ENTRY', locked: false });
  });

  it('PUTs the new policy with the reason and accepts 202 PENDING', async () => {
    const f = stubFetch(202, { outcome: 'PENDING', request: dto({ targetType: 'MAKER_CHECKER_POLICY', action: 'UPDATE' }) });
    const res = await updatePolicy('BLACKLIST_ENTRY', 'UPDATE', { enabled: false, checkerRoles: ['ADMIN'], expiresInHours: 24, reason: '  Шалтгаан  ' });
    expect(lastCall(f)).toMatchObject({
      url: `${BASE}/policies/BLACKLIST_ENTRY/UPDATE`,
      body: { enabled: false, checkerRoles: ['ADMIN'], expiresInHours: 24, reason: 'Шалтгаан' },
    });
    expect(lastCall(f).init).toMatchObject({ method: 'PUT' });
    expect(res.outcome).toBe('PENDING');
  });
});

describe('failures', () => {
  it('throws ApiError with status, code and the Mongolian server message', async () => {
    stubFetch(409, { statusCode: 409, code: 'ALREADY_DECIDED', message: 'Хүсэлт аль хэдийн шийдвэрлэгдсэн' });
    const e = await approveRequest(ID).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'ALREADY_DECIDED', message: 'Хүсэлт аль хэдийн шийдвэрлэгдсэн' });
  });

  it('keeps 403 distinguishable (policies for a non-admin)', async () => {
    stubFetch(403, { statusCode: 403, code: 'FORBIDDEN', message: 'Эрх хүрэлцэхгүй' });
    await expect(listPolicies()).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('handles a non-JSON error body', async () => {
    stubFetch(502, '<html>Bad Gateway</html>');
    await expect(getSummary()).rejects.toMatchObject({ status: 502, code: 'HTTP_502', message: mn['maker_checker.error.generic'] });
  });

  it('turns a network failure into a Mongolian ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(getSummary()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: mn['maker_checker.error.network'] });
  });

  it('rethrows an abort untouched so TanStack Query can cancel quietly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    await expect(getSummary()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a response that does not match the contract', async () => {
    stubFetch(200, { inbox: 'many' });
    await expect(getSummary()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: mn['maker_checker.error.invalid_response'] });
    stubFetch(200, '');
    await expect(getSummary()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
