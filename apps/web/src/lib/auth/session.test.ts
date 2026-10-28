import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { menuFor, permissionsFor, type AuthResponse } from '@los/contracts';

const authResponse = (token: string): AuthResponse => ({
  accessToken: token,
  expiresIn: 900,
  user: { id: 'u1', orgId: 'o1', branchId: 'b1', username: 'officer.a', fullName: 'Officer A', roles: ['OFFICER'] },
  permissions: permissionsFor(['OFFICER']),
  menu: menuFor(['OFFICER']),
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
async function load() {
  vi.resetModules(); // access token ба in-flight refresh нь модулийн төлөв
  return { session: await import('./session'), api: await import('../api'), http: await import('../http') };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));
const authHeader = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers.authorization;

describe('refreshSession', () => {
  it('coalesces concurrent calls into ONE request (refresh token rotates; a reused token revokes the chain)', async () => {
    const { session } = await load();
    fetchMock.mockResolvedValue(json(authResponse('t1')));
    const [a, b, c] = await Promise.all([session.refreshSession(), session.refreshSession(), session.refreshSession()]);
    expect(calls('/auth/refresh')).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(session.getAccessToken()).toBe('t1');
    // дараагийн дуудлага шинэ хүсэлт гаргана
    fetchMock.mockResolvedValue(json(authResponse('t2')));
    await session.refreshSession();
    expect(calls('/auth/refresh')).toHaveLength(2);
    expect(session.getAccessToken()).toBe('t2');
  });
  it('401 means "no session": null and the token is cleared', async () => {
    const { session } = await load();
    fetchMock.mockResolvedValueOnce(json(authResponse('t1'))).mockResolvedValueOnce(json({ code: 'INVALID_REFRESH_TOKEN' }, 401));
    await session.refreshSession();
    expect(await session.refreshSession()).toBeNull();
    expect(session.getAccessToken()).toBeNull();
  });
  it('a gateway that is down is an error, not "signed out"', async () => {
    const { session, http } = await load();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(session.refreshSession()).rejects.toMatchObject({ status: 0, code: http.NETWORK_ERROR });
  });
  it('sends the cookie and a correlation id', async () => {
    const { session } = await load();
    fetchMock.mockResolvedValue(json(authResponse('t1')));
    await session.refreshSession();
    const init = fetchMock.mock.calls[0]![1] as { credentials: string; headers: Record<string, string> };
    expect(init.credentials).toBe('include');
    expect(init.headers['x-correlation-id']).toBeTruthy();
  });
});

describe('apiFetch', () => {
  it('attaches the bearer token and validates with the schema', async () => {
    const { session, api } = await load();
    fetchMock.mockResolvedValueOnce(json(authResponse('t1')));
    await session.refreshSession();
    fetchMock.mockResolvedValueOnce(json({ n: 1 }));
    const { z } = await import('zod');
    await expect(api.apiFetch('/x', { schema: z.object({ n: z.number() }) })).resolves.toEqual({ n: 1 });
    expect(authHeader(calls('/x')[0]!)).toBe('Bearer t1');
  });
  it('on 401 refreshes once and retries with the NEW token', async () => {
    const { session, api } = await load();
    fetchMock.mockResolvedValueOnce(json(authResponse('old')));
    await session.refreshSession();
    fetchMock
      .mockResolvedValueOnce(json({ code: 'SESSION_ENDED' }, 401)) // /x
      .mockResolvedValueOnce(json(authResponse('new'))) // /auth/refresh
      .mockResolvedValueOnce(json({ ok: true })); // /x retry
    await expect(api.apiFetch('/x')).resolves.toEqual({ ok: true });
    expect(authHeader(calls('/x')[0]!)).toBe('Bearer old');
    expect(authHeader(calls('/x')[1]!)).toBe('Bearer new');
  });
  it('ends the session when refresh fails, and surfaces the original 401', async () => {
    const { session, api } = await load();
    const ended = vi.fn();
    session.onSessionEnded(ended);
    fetchMock.mockResolvedValueOnce(json({ code: 'SESSION_ENDED', message: 'Нэвтрэх хугацаа дууссан' }, 401)).mockResolvedValueOnce(json({ code: 'INVALID_REFRESH_TOKEN' }, 401));
    await expect(api.apiFetch('/x')).rejects.toMatchObject({ status: 401, code: 'SESSION_ENDED' });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(session.getAccessToken()).toBeNull();
  });
  it('is bounded: after two refresh rounds that still end in 401 the session ends', async () => {
    const { session, api } = await load();
    const ended = vi.fn();
    session.onSessionEnded(ended);
    fetchMock
      .mockResolvedValueOnce(json({}, 401)) // /x
      .mockResolvedValueOnce(json(authResponse('n1'))) // refresh 1
      .mockResolvedValueOnce(json({}, 401)) // /x retry (another tab rotated meanwhile)
      .mockResolvedValueOnce(json(authResponse('n2'))) // refresh 2
      .mockResolvedValueOnce(json({}, 401)); // /x second retry
    await expect(api.apiFetch('/x')).rejects.toMatchObject({ status: 401 });
    expect(calls('/auth/refresh')).toHaveLength(2);
    expect(calls('/x')).toHaveLength(3);
    expect(ended).toHaveBeenCalledTimes(1);
  });
  it('a retry that races another rotation recovers with a second refresh instead of logging out', async () => {
    const { session, api } = await load();
    const ended = vi.fn();
    session.onSessionEnded(ended);
    fetchMock
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(authResponse('n1')))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(authResponse('n2')))
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(api.apiFetch('/x')).resolves.toEqual({ ok: true });
    expect(authHeader(calls('/x')[2]!)).toBe('Bearer n2');
    expect(ended).not.toHaveBeenCalled();
  });
  it('a token that another request already renewed is reused: no extra rotation', async () => {
    const { session, api } = await load();
    fetchMock.mockResolvedValueOnce(json(authResponse('old')));
    await session.refreshSession();
    let first = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/auth/refresh')) return json(authResponse('new'));
      if (first) {
        first = false;
        await session.refreshSession(); // өөр хүсэлт (эсвэл таб) token-ийг хооронд нь шинэчилсэн
        return json({}, 401);
      }
      return json({ ok: true });
    });
    await expect(api.apiFetch('/x')).resolves.toEqual({ ok: true });
    expect(calls('/auth/refresh')).toHaveLength(2); // ачаалалт + хооронд нь шинэчилсэн нэг; apiFetch өөрөө нэмэхгүй
    expect(authHeader(calls('/x')[1]!)).toBe('Bearer new');
  });
  it('maps non-2xx to ApiError with code and message; 204 resolves undefined', async () => {
    const { api } = await load();
    fetchMock.mockResolvedValueOnce(json({ code: 'LTV_EXCEEDED', message: 'LTV хэтэрсэн' }, 422));
    await expect(api.apiFetch('/x')).rejects.toMatchObject({ status: 422, code: 'LTV_EXCEEDED', message: 'LTV хэтэрсэн' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.apiFetch('/y')).resolves.toBeUndefined();
  });
});

describe('logoutRequest', () => {
  it('clears the token on success', async () => {
    const { session } = await load();
    fetchMock.mockResolvedValueOnce(json(authResponse('t1')));
    await session.refreshSession();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await session.logoutRequest();
    expect(session.getAccessToken()).toBeNull();
  });
  it('keeps the session when the server could not end it (the cookie would log the user back in)', async () => {
    const { session } = await load();
    fetchMock.mockResolvedValueOnce(json(authResponse('t1')));
    await session.refreshSession();
    fetchMock.mockResolvedValueOnce(json({ message: 'boom' }, 500));
    await expect(session.logoutRequest()).rejects.toMatchObject({ status: 500 });
    expect(session.getAccessToken()).toBe('t1');
  });
});

describe('refresh coordination', () => {
  it('notifies listeners of every rotation (the user may have changed in another tab)', async () => {
    const { session } = await load();
    const seen: string[] = [];
    session.onSessionRefreshed((s) => seen.push(s.user.id));
    fetchMock.mockResolvedValue(json(authResponse('t1')));
    await session.refreshSession();
    expect(seen).toEqual(['u1']);
  });
  it('logout waits for an in-flight refresh so it cannot resurrect the session', async () => {
    const { session } = await load();
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => (release = res)));
    const refresh = session.refreshSession();
    const logout = session.logoutRequest();
    await Promise.resolve();
    expect(calls('/auth/logout')).toHaveLength(0);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    release(json(authResponse('t1')));
    await refresh;
    await logout;
    expect(calls('/auth/logout')).toHaveLength(1);
    expect(session.getAccessToken()).toBeNull();
  });
  it('uses Web Locks across tabs when the browser has them', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    vi.stubGlobal('navigator', { locks: { request } });
    const { session } = await load();
    fetchMock.mockResolvedValue(json(authResponse('t1')));
    await session.refreshSession();
    expect(request).toHaveBeenCalledWith('los-auth-refresh', expect.any(Function));
  });
});

describe('loginErrorKey', () => {
  it('maps to user-facing Mongolian keys', async () => {
    const { ApiError } = await import('../http');
    const { loginErrorKey } = await import('./login-error');
    expect(loginErrorKey(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))).toBe('auth.error.invalid');
    expect(loginErrorKey(new ApiError(429, null, 'ThrottlerException'))).toBe('auth.error.rate_limit');
    expect(loginErrorKey(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe('auth.error.network');
    expect(loginErrorKey(new ApiError(500, null, 'x'))).toBe('auth.error.unknown');
    expect(loginErrorKey(new Error('zod'))).toBe('auth.error.unknown');
  });
});
