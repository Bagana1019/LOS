import { describe, expect, it } from 'vitest';
import { ExternalListError, IntegrationNotConfiguredError } from '../errors';
import { RealUnScClient } from './real-un-sc.client';
import { assertUnScProductionConfig, loadUnScConfig, UN_SC_DEFAULT_URL, UN_SC_STORAGE_HOST } from './un-sc.config';

// Hermetic: бодит сүлжээ байхгүй, fetch-ийг гараар орлуулна. Бодит UN-ийн урсгал: scsanctions.un.org → 302 → богино настай SAS холбоос (blob хост).
const XML = `<?xml version="1.0" encoding="UTF-8"?><CONSOLIDATED_LIST dateGenerated="2026-11-19T00:00:03.388Z"><INDIVIDUALS><INDIVIDUAL><FIRST_NAME>FIXTURE</FIRST_NAME><UN_LIST_TYPE>Taliban</UN_LIST_TYPE><REFERENCE_NUMBER>TAi.900</REFERENCE_NUMBER><LISTED_ON>2020-01-01</LISTED_ON></INDIVIDUAL></INDIVIDUALS></CONSOLIDATED_LIST>`;
const SAS = `https://${UN_SC_STORAGE_HOST}/un/consolidated.xml?sv=2020&sig=SECRETSIG`;
const enc = new TextEncoder();

interface Call { url: string; init: RequestInit | undefined }
type Handler = (call: Call) => Response | Promise<Response>;

/** URL → handler. Тодорхойгүй URL руу дуудвал тест унана (гэнэтийн дуудлагыг илрүүлнэ). */
function harness(routes: Record<string, Handler>, opts: { env?: Record<string, string | undefined>; timeoutMs?: number; maxBytes?: number } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const handler = routes[call.url];
    if (!handler) throw new Error(`unexpected fetch ${call.url}`);
    return handler(call);
  }) as typeof fetch;
  const client = new RealUnScClient({ env: opts.env ?? {}, fetch: fetchFn, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
  return { client, calls };
}
const xml = (body = XML) => () => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const reasonOf = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('expected a rejection');
};

describe('RealUnScClient — татаж parse хийх', () => {
  it('албан ёсны URL → 302 → SAS холбоос (blob хост) → XML: snapshot буцаана; redirect-ийг гараар дагана, нууц header явуулахгүй', async () => {
    const { client, calls } = harness({ [UN_SC_DEFAULT_URL]: redirect(SAS), [SAS]: xml() });
    const snap = await client.fetchSnapshot();
    expect(snap).toMatchObject({ version: '2026-11-19T00:00:03.388Z', publishedAt: '2026-11-19T00:00:03.388Z' });
    expect(snap.entries.map((e) => e.refId)).toEqual(['TAi.900']);
    expect(calls.map((c) => c.url)).toEqual([UN_SC_DEFAULT_URL, SAS]);
    for (const c of calls) {
      expect(c.init?.redirect).toBe('manual');
      expect(Object.keys((c.init?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase()).sort()).toEqual(['accept']);
    }
  });

  it('redirect-гүй шууд 200 хариу ч болно', async () => {
    const { client } = harness({ [UN_SC_DEFAULT_URL]: xml() });
    expect((await client.fetchSnapshot()).entries).toHaveLength(1);
  });

  it('харьцангуй Location (/path) одоогийн URL-тай нийлж, ижил хост тул зөвшөөрөгдөнө', async () => {
    const { client, calls } = harness({ [UN_SC_DEFAULT_URL]: redirect('/resources/xml/en/other.xml', 301), 'https://scsanctions.un.org/resources/xml/en/other.xml': xml() });
    await client.fetchSnapshot();
    expect(calls).toHaveLength(2);
  });

  it('UN_SC_URL override: тухайн хост + UN-ийн blob хост зөвшөөрөгдөнө', async () => {
    const { client } = harness({ 'https://mirror.example.test/un.xml': redirect(SAS), [SAS]: xml() }, { env: { UN_SC_URL: 'https://mirror.example.test/un.xml' } });
    expect((await client.fetchSnapshot()).entries).toHaveLength(1);
  });

  it('UN_SC_REDIRECT_HOSTS нэмэлт хостыг (том/жижиг үсэг, хоосон зайг үл хамаарч) зөвшөөрнө', async () => {
    const target = 'https://cdn.example.test/un.xml?x=1';
    const { client } = harness({ [UN_SC_DEFAULT_URL]: redirect(target), [target]: xml() }, { env: { UN_SC_REDIRECT_HOSTS: ' CDN.Example.test , ,other.example.test' } });
    expect((await client.fetchSnapshot()).entries).toHaveLength(1);
  });
});

describe('RealUnScClient — redirect хамгаалалт (SSRF / нууц холбоос)', () => {
  it('жагсаалтад байхгүй хост руу redirect → татгалзаж, тэр хост руу ДУУДАХГҮЙ; алдаа хостыг заана, query (sig) оруулахгүй', async () => {
    const evil = 'https://evil.example.test/un.xml?sig=SECRETSIG';
    const { client, calls } = harness({ [UN_SC_DEFAULT_URL]: redirect(evil) });
    const err = await reasonOf(client.fetchSnapshot());
    expect(err).toBeInstanceOf(ExternalListError);
    expect(err.message).toMatch(/redirect.*not allowed/i);
    expect(err.message).toContain('evil.example.test');
    expect(err.message).not.toContain('SECRETSIG');
    expect(calls).toHaveLength(1);
  });

  it('http:// руу redirect (HTTPS-ээс буулгах) → татгалзана', async () => {
    const { client, calls } = harness({ [UN_SC_DEFAULT_URL]: redirect(`http://${UN_SC_STORAGE_HOST}/un.xml`) });
    await expect(client.fetchSnapshot()).rejects.toThrow(/https/i);
    expect(calls).toHaveLength(1);
  });

  it('3-аас олон redirect → татгалзана', async () => {
    const hops = Array.from({ length: 5 }, (_, i) => `https://scsanctions.un.org/h${i}`);
    const routes: Record<string, Handler> = { [UN_SC_DEFAULT_URL]: redirect(hops[0]!) };
    hops.forEach((h, i) => { routes[h] = redirect(hops[i + 1] ?? SAS); });
    const { client, calls } = harness(routes);
    await expect(client.fetchSnapshot()).rejects.toThrow(/too many redirects/i);
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it('Location толгойгүй 3xx → татгалзана', async () => {
    const { client } = harness({ [UN_SC_DEFAULT_URL]: () => new Response(null, { status: 302 }) });
    await expect(client.fetchSnapshot()).rejects.toThrow(/Location/);
  });
});

describe('RealUnScClient — алдаа, хязгаар (fail closed)', () => {
  it.each([[404], [500], [503]])('HTTP %i → ExternalListError (статус заана, URL оруулахгүй)', async (status) => {
    const { client } = harness({ [UN_SC_DEFAULT_URL]: redirect(SAS), [SAS]: () => new Response('nope', { status }) });
    const err = await reasonOf(client.fetchSnapshot());
    expect(err).toBeInstanceOf(ExternalListError);
    expect(err.message).toContain(String(status));
    expect(err.message).not.toContain('SECRETSIG');
    expect(err.message).not.toContain('blob.core.windows.net');
  });

  it('Content-Length хязгаараас их → биеийг уншихгүйгээр татгалзана', async () => {
    let read = false;
    const { client } = harness({ [UN_SC_DEFAULT_URL]: () => {
      const r = new Response('x', { headers: { 'content-length': '999999999' } });
      // Цуцлах (cancel) зөвшөөрөгдөнө; унших (getReader) хориотой.
      Object.defineProperty(r, 'body', { get: () => ({ getReader: () => { read = true; throw new Error('must not read'); }, cancel: async () => undefined }) });
      return r;
    } });
    await expect(client.fetchSnapshot()).rejects.toThrow(/too large/i);
    expect(read).toBe(false);
  });

  it('Content-Length-гүй урсгал хязгаараас хэтэрвэл таслан татгалзана', async () => {
    const stream = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('a'.repeat(100))); c.enqueue(enc.encode('b'.repeat(100))); c.close(); } }));
    const { client } = harness({ [UN_SC_DEFAULT_URL]: stream }, { maxBytes: 150 });
    await expect(client.fetchSnapshot()).rejects.toThrow(/too large/i);
  });

  it.each([['хоосон бие', ''], ['XML биш', 'not xml at all'], ['өөр root', '<html/>']])('%s → parser-ийн алдаа (хоосон snapshot-ыг чимээгүй буцаахгүй)', async (_l, body) => {
    const { client } = harness({ [UN_SC_DEFAULT_URL]: xml(body) });
    const err = await reasonOf(client.fetchSnapshot());
    expect(err).toBeInstanceOf(ExternalListError);
    expect(err.message).not.toContain('scsanctions');
  });

  it('сүлжээний алдаа → "network error (<code>)"; cause-ийн бусад агуулгыг (хост, URL) оруулахгүй', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', hostname: 'scsanctions.un.org' } });
    const { client } = harness({ [UN_SC_DEFAULT_URL]: () => { throw boom; } });
    const err = await reasonOf(client.fetchSnapshot());
    expect(err).toBeInstanceOf(ExternalListError);
    expect(err.message).toMatch(/network error \(ECONNRESET\)/);
    expect(err.message).not.toContain('scsanctions');
  });

  it('дуудагчийн AbortSignal цуцлавал татаж буй хүсэлт цуцлагдаж "aborted" алдаа', async () => {
    const hang: Handler = ({ init }) => new Promise<Response>((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)); });
    const { client } = harness({ [UN_SC_DEFAULT_URL]: hang });
    const ac = new AbortController();
    const p = client.fetchSnapshot(ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('өөрийн timeout (анхдагч 15с, энд 30мс) хэтэрвэл "timed out"', async () => {
    const hang: Handler = ({ init }) => new Promise<Response>((_res, rej) => { init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)); });
    const { client } = harness({ [UN_SC_DEFAULT_URL]: hang }, { timeoutMs: 30 });
    await expect(client.fetchSnapshot()).rejects.toThrow(/timed out/i);
  });

  it('тохиргоо буруу (UN_SC_URL invalid) үед татахаас өмнө IntegrationNotConfiguredError', async () => {
    const { client, calls } = harness({}, { env: { UN_SC_URL: 'ftp://x.test/a.xml' } });
    await expect(client.fetchSnapshot()).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    expect(calls).toHaveLength(0);
  });
});

describe('loadUnScConfig', () => {
  it('env-гүй бол албан ёсны URL, нэмэлт хостгүй', () => {
    expect(UN_SC_DEFAULT_URL).toBe('https://scsanctions.un.org/resources/xml/en/consolidated.xml');
    expect(loadUnScConfig({})).toEqual({ url: UN_SC_DEFAULT_URL, extraRedirectHosts: [] });
  });
  it('UN_SC_URL (trim), UN_SC_REDIRECT_HOSTS (жижиг үсэг, хоосныг алгасна)', () => {
    expect(loadUnScConfig({ UN_SC_URL: ' https://mirror.example.test/un.xml ', UN_SC_REDIRECT_HOSTS: 'A.example.test,, b.example.test ' })).toEqual({ url: 'https://mirror.example.test/un.xml', extraRedirectHosts: ['a.example.test', 'b.example.test'] });
  });
  it.each([
    ['URL биш', { UN_SC_URL: 'not a url' }, 'UN_SC_URL (invalid)'],
    ['http/https биш протокол', { UN_SC_URL: 'ftp://x.test/a.xml' }, 'UN_SC_URL (invalid)'],
    ['URL дотор нэвтрэх мэдээлэл', { UN_SC_URL: 'https://user:pw@x.test/a.xml' }, 'UN_SC_URL (invalid)'],
    ['хост биш (зам/порт/схем)', { UN_SC_REDIRECT_HOSTS: 'https://x.test' }, 'UN_SC_REDIRECT_HOSTS (invalid)'],
    ['хост дотор хоосон зай', { UN_SC_REDIRECT_HOSTS: 'bad host' }, 'UN_SC_REDIRECT_HOSTS (invalid)'],
  ])('%s → IntegrationNotConfiguredError, зөвхөн хувьсагчийн нэр', (_l, env, missing) => {
    let err: unknown;
    try { loadUnScConfig(env); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect((err as IntegrationNotConfiguredError).missing).toEqual([missing]);
    expect((err as Error).message).not.toContain('user:pw');
  });
});

describe('assertUnScProductionConfig', () => {
  const prod = { NODE_ENV: 'production', INTEGRATION_MODE: 'real' };
  it('production + real + анхдагч тохиргоо (env шаардлагагүй, нийтийн эх сурвалж) → OK', () => {
    expect(() => assertUnScProductionConfig(prod)).not.toThrow();
  });
  it('production + real + http UN_SC_URL → https шаардана', () => {
    expect(() => assertUnScProductionConfig({ ...prod, UN_SC_URL: 'http://mirror.example.test/un.xml' })).toThrow(/UN_SC_URL must use https/);
  });
  it('production + real + буруу UN_SC_REDIRECT_HOSTS → эхлэхгүй', () => {
    expect(() => assertUnScProductionConfig({ ...prod, UN_SC_REDIRECT_HOSTS: 'bad host' })).toThrow(IntegrationNotConfiguredError);
  });
  it('production биш эсвэл mock үед юу ч шалгахгүй', () => {
    expect(() => assertUnScProductionConfig({ INTEGRATION_MODE: 'real', UN_SC_URL: 'http://x.test/a.xml' })).not.toThrow();
    expect(() => assertUnScProductionConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock', UN_SC_URL: 'http://x.test/a.xml' })).not.toThrow();
  });
});
