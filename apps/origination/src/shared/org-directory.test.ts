import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CTX_HEADERS, DIRECTORY_TOKEN_HEADER, type OrgDirectory, type RequestContext } from '@los/contracts';
import { FixedClock } from '@los/nest-common';
import { HttpOrgDirectorySource, ORG_DIRECTORY_TTL_MS, OrgDirectoryService, directoryName, type OrgDirectorySource } from './org-directory';

// Excel/CSV экспортын нэр: салбар, ЗЭЗ нь gateway-ийн `iam` schema-д. origination өөр schema уншихгүй — gateway-ийн дотоод лавлахаас
// нэг удаа (org тутамд, TTL-тэй кэш) авна. Лавлах унасан/буруу бол экспорт унахгүй — id хэвээр, warning лог.
const ctx = (orgId = 'org-1'): RequestContext => ({ userId: 'u-admin', roles: ['ADMIN'], branchId: null, orgId, customerId: null, correlationId: 'corr-1' });
const SNAPSHOT: OrgDirectory = { branches: { b1: 'Төв салбар' }, users: { u1: 'Бат Болд' } };
const T0 = Date.parse('2026-10-28T02:00:00Z');

describe('directoryName', () => {
  it('нэр олдвол нэрийг, олдохгүй бол id-г буцаана', () => {
    expect(directoryName(SNAPSHOT.branches, 'b1')).toBe('Төв салбар');
    expect(directoryName(SNAPSHOT.branches, 'b-gone')).toBe('b-gone');
  });

  it('Object.prototype-ийн түлхүүр (constructor, __proto__, toString) нэр биш — id хэвээр', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(directoryName(SNAPSHOT.users, k)).toBe(k);
  });
});

describe('OrgDirectoryService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  const make = (fetch: OrgDirectorySource['fetch']) => {
    const clock = new FixedClock(new Date(T0));
    const source = { fetch: vi.fn(fetch) };
    return { svc: new OrgDirectoryService(source, clock), source, clock };
  };

  it('gateway-ийн лавлахыг буцаана', async () => {
    const { svc } = make(async () => SNAPSHOT);
    expect(await svc.load(ctx())).toEqual(SNAPSHOT);
  });

  it(`TTL (${ORG_DIRECTORY_TTL_MS} мс) дотор дахин дуудахгүй, хугацаа дуусвал шинэчилнэ`, async () => {
    const { svc, source, clock } = make(async () => SNAPSHOT);
    await svc.load(ctx());
    clock.set(new Date(T0 + ORG_DIRECTORY_TTL_MS - 1));
    await svc.load(ctx());
    expect(source.fetch).toHaveBeenCalledTimes(1);
    clock.set(new Date(T0 + ORG_DIRECTORY_TTL_MS));
    await svc.load(ctx());
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('зэрэг ирсэн хүсэлтүүд нэг дуудлагыг хуваалцана (3 экспорт зэрэг → 1 дуудлага)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc, source } = make(async () => { await gate; return SNAPSHOT; });
    const all = Promise.all([svc.load(ctx()), svc.load(ctx()), svc.load(ctx())]);
    release();
    const out = await all;
    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(out.every((d) => d === out[0])).toBe(true);
  });

  it('байгууллага тус бүр тусдаа кэш: бусад org-ийн нэр огт холилдохгүй', async () => {
    const { svc, source } = make(async (c) => (c.orgId === 'org-1' ? SNAPSHOT : { branches: { x: 'Бусдын салбар' }, users: {} }));
    const a = await svc.load(ctx('org-1'));
    const b = await svc.load(ctx('org-2'));
    expect(a.branches).toEqual({ b1: 'Төв салбар' });
    expect(b.branches).toEqual({ x: 'Бусдын салбар' });
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('лавлах унасан бол хоосон лавлах буцаана (id хэвээр үлдэнэ), warning логлоно, алдаа шидэхгүй', async () => {
    const { svc } = make(async () => { throw new Error('gateway сервис руу холбогдож чадсангүй'); });
    expect(await svc.load(ctx())).toEqual({ branches: {}, users: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('corr-1');
    expect(msg).toContain('gateway сервис руу холбогдож чадсангүй');
  });

  it('алдааг кэшлэхгүй: дараагийн экспорт дахин оролдоно, сэргэвэл нэр гарна', async () => {
    let fail = true;
    const { svc, source } = make(async () => { if (fail) throw new Error('down'); return SNAPSHOT; });
    expect(await svc.load(ctx())).toEqual({ branches: {}, users: {} });
    fail = false;
    expect(await svc.load(ctx())).toEqual(SNAPSHOT);
    expect(source.fetch).toHaveBeenCalledTimes(2);
  });

  it('логт зөвхөн алдааны мессеж орно — upstream body (ажилтны нэр) орохгүй', async () => {
    const { svc } = make(async () => { throw Object.assign(new Error('timeout'), { upstreamBody: { users: { u1: 'Бат Болд' } } }); });
    await svc.load(ctx());
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Бат Болд');
  });
});

describe('HttpOrgDirectorySource', () => {
  const TOKEN = 'dir-token-0123456789abcd';
  const env = { INTERNAL_AUTH_SECRET: 's3cret-internal', GATEWAY_DIRECTORY_TOKEN: TOKEN, GATEWAY_URL: 'http://gw.test:4000' } as NodeJS.ProcessEnv;
  const source = (fetchFn: typeof fetch, e: NodeJS.ProcessEnv = env) => new HttpOrgDirectorySource({ env: e, fetchFn, sleep: async () => undefined });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  type Call = [URL, RequestInit & { headers: Record<string, string> }];

  it('gateway-ийн дотоод лавлах руу X-Directory-Token (өөрийн GATEWAY_DIRECTORY_TOKEN) + X-Org-Id-тай GET хийж OrgDirectory-г задлана', async () => {
    const fetchFn = vi.fn(async () => json(SNAPSHOT));
    const out = await source(fetchFn as unknown as typeof fetch).fetch(ctx('org-7'));
    expect(out).toEqual(SNAPSHOT);
    const [url, init] = fetchFn.mock.calls[0] as unknown as Call;
    expect(String(url)).toBe('http://gw.test:4000/api/internal/directory');
    expect(init.method).toBe('GET');
    expect(init.headers[CTX_HEADERS.orgId]).toBe('org-7');
    expect(init.headers[DIRECTORY_TOKEN_HEADER]).toBe(TOKEN);
  });

  it('INTERNAL_AUTH_SECRET-ийг gateway-ийн лавлах руу ХЭЗЭЭ Ч илгээхгүй (хоёр нууц тусдаа)', async () => {
    const fetchFn = vi.fn(async () => json(SNAPSHOT));
    await source(fetchFn as unknown as typeof fetch).fetch(ctx());
    const [, init] = fetchFn.mock.calls[0] as unknown as Call;
    expect(init.headers[CTX_HEADERS.internalToken]).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toContain('s3cret-internal');
  });

  it('redirect дагахгүй (токен өөр хост руу алдагдахгүй): 3xx → алдаа', async () => {
    const fetchFn = vi.fn(async () => json(SNAPSHOT));
    await source(fetchFn as unknown as typeof fetch).fetch(ctx());
    expect((fetchFn.mock.calls[0] as unknown as Call)[1].redirect).toBe('error');
  });

  it.each([['тохируулаагүй', undefined], ['хоосон', ''], ['хоосон зай', '   ']])('GATEWAY_DIRECTORY_TOKEN %s → сүлжээний дуудлагагүйгээр алдаа (дуудагч id-д буцна)', async (_n, value) => {
    const fetchFn = vi.fn(async () => json(SNAPSHOT));
    const e = { ...env, GATEWAY_DIRECTORY_TOKEN: value } as NodeJS.ProcessEnv;
    await expect(source(fetchFn as unknown as typeof fetch, e).fetch(ctx())).rejects.toThrow(/GATEWAY_DIRECTORY_TOKEN/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('токеныг trim хийж илгээнэ', async () => {
    const fetchFn = vi.fn(async () => json(SNAPSHOT));
    await source(fetchFn as unknown as typeof fetch, { ...env, GATEWAY_DIRECTORY_TOKEN: `  ${TOKEN}\n` } as NodeJS.ProcessEnv).fetch(ctx());
    expect((fetchFn.mock.calls[0] as unknown as Call)[1].headers[DIRECTORY_TOKEN_HEADER]).toBe(TOKEN);
  });

  it('гэрээнд нийцэхгүй хариу (strict схем) → алдаа (дуудагч id-д буцна)', async () => {
    const bad = vi.fn(async () => json({ branches: {}, users: {}, emails: { u1: 'a@b.c' } }));
    await expect(source(bad as unknown as typeof fetch).fetch(ctx())).rejects.toThrow();
  });

  it('gateway 401/503/5xx / сүлжээний алдаа → алдаа шидэнэ; алдааны мессежид токен орохгүй', async () => {
    for (const status of [401, 503]) {
      const err = await source((async () => json({ code: 'X' }, status)) as unknown as typeof fetch).fetch(ctx()).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toContain(TOKEN);
    }
    await expect(source((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch).fetch(ctx())).rejects.toThrow();
  });
});
