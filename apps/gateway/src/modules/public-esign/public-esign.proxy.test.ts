import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import http, { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_KEY } from '@los/nest-common';
import { loadProxyConfig, PROXY_CONFIG, ProxyConfig } from './esign-proxy.config';
import { PublicEsignModule } from './public-esign.module';
import { PublicEsignController } from './public-esign.controller';
import { FixedWindowRateLimiter, RATE_LIMITER } from './rate-limiter';

// ---------- Хуурамч dms (ephemeral порт дээрх жинхэнэ HTTP сервер) ----------

interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
type Handler = (req: IncomingMessage, res: ServerResponse, captured: Captured) => void;

const jsonReply =
  (status: number, payload: unknown): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

class FakeDms {
  readonly calls: Captured[] = [];
  handler: Handler = jsonReply(200, { ok: true });
  url = '';
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const captured: Captured = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.alloc(0) };
    this.calls.push(captured);
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured.body = Buffer.concat(chunks);
      this.handler(req, res, captured);
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  reset(): void {
    this.calls.length = 0;
    this.handler = jsonReply(200, { ok: true });
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Хэзээ ч холбогдохгүй (хаагдсан) локал порт */
async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const binary = (t: request.Test) =>
  t.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });

function rawRequest(baseUrl: string, path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const req = http.request(new URL(path, baseUrl), { method: init.method ?? 'GET', headers: init.headers });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', reject);
  });
  return { req, response };
}

async function readBody(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- Тестийн орчин ----------

const TOKEN = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');
const CODE = 'ABCDEFGHJKMN';
const BASE = '/api/public/esign';
const TOKEN_ROUTES = [
  { method: 'get', suffix: '' },
  { method: 'get', suffix: '/document' },
  { method: 'post', suffix: '/start' },
  { method: 'get', suffix: '/status' },
  { method: 'post', suffix: '/decline' },
  { method: 'get', suffix: '/signed-document' },
] as const;

interface AppOptions {
  config?: (base: ProxyConfig) => ProxyConfig;
  trustProxy?: string | number | boolean;
  dmsUrl?: string;
}

describe('public e-sign proxy (gateway → dms)', () => {
  const dms = new FakeDms();
  let app: NestExpressApplication | undefined;
  let url = '';
  let nowMs = 0;

  async function boot(options: AppOptions = {}): Promise<void> {
    const base = loadProxyConfig({ DMS_URL: options.dmsUrl ?? dms.url });
    const config = options.config ? options.config(base) : base;
    const limiter = new FixedWindowRateLimiter({ windowMs: config.rateWindowMs, maxKeys: config.rateMaxKeys, now: () => nowMs });
    const moduleRef = await Test.createTestingModule({ imports: [PublicEsignModule] })
      .overrideProvider(PROXY_CONFIG)
      .useValue(config)
      .overrideProvider(RATE_LIMITER)
      .useValue(limiter)
      .compile();
    // main.ts-тэй ижил: body parser унтраалттай (бие stream хэвээр), global prefix, x-powered-by унтраалттай
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    app.setGlobalPrefix('api');
    app.disable('x-powered-by');
    if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }

  beforeAll(() => dms.start());
  afterAll(() => dms.stop());
  beforeEach(() => {
    dms.reset();
    nowMs = 0;
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  describe('route mapping', () => {
    beforeEach(() => boot());

    it.each([
      ['GET', `/verify/${CODE}`, `verify/${CODE}`],
      ['GET', '/verify/ABCD-EFGH-JKMN', `verify/${CODE}`],
      ['POST', '/callback/tridum', 'callback/tridum'],
      ['POST', '/callback/monpass', 'callback/monpass'],
      ['GET', `/${TOKEN}`, TOKEN],
      ['GET', `/${TOKEN}/document`, `${TOKEN}/document`],
      ['POST', `/${TOKEN}/start`, `${TOKEN}/start`],
      ['GET', `/${TOKEN}/status`, `${TOKEN}/status`],
      ['POST', `/${TOKEN}/decline`, `${TOKEN}/decline`],
      ['GET', `/${TOKEN}/signed-document`, `${TOKEN}/signed-document`],
    ])('%s %s → dms /api/public/esign/%s', async (method, path, upstreamPath) => {
      const call = method === 'GET' ? request(url).get(`${BASE}${path}`) : request(url).post(`${BASE}${path}`).set('Content-Type', 'application/json').send('{"a":1}');
      const res = await call;
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(dms.calls).toHaveLength(1);
      expect(dms.calls[0].method).toBe(method);
      expect(dms.calls[0].url).toBe(`/api/public/esign/${upstreamPath}`);
    });

    it('query string-ийг dms руу дамжуулахгүй', async () => {
      await request(url).get(`${BASE}/${TOKEN}/status?debug=1&x=${CODE}`);
      expect(dms.calls[0].url).toBe(`/api/public/esign/${TOKEN}/status`);
    });

    it.each([
      [404, { code: 'NOT_FOUND', message: 'x' }],
      [409, { code: 'ALREADY_SIGNED', message: 'y' }],
      [410, { code: 'LINK_EXPIRED', message: 'z' }],
      [500, { statusCode: 500, message: 'Internal server error' }],
    ])('dms-ийн %i статус ба JSON биеийг өөрчлөхгүй дамжуулна', async (status, payload) => {
      dms.handler = jsonReply(status, payload);
      const res = await request(url).get(`${BASE}/${TOKEN}/status`);
      expect(res.status).toBe(status);
      expect(res.body).toEqual(payload);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('bие байхгүй 204 хариуг дамжуулна', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(204);
        res.end();
      };
      const res = await request(url).post(`${BASE}/${TOKEN}/decline`);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('verify/callback нь :token route-оос өмнө таарна', async () => {
      // `/verify/document` нь `:token/document` (token="verify") биш, verify/:code → буруу код → 404
      expect((await request(url).get(`${BASE}/verify/document`)).status).toBe(404);
      // `/callback/start` нь `:token/start` биш, callback/:provider → буруу provider → 404
      expect((await request(url).post(`${BASE}/callback/start`)).status).toBe(404);
      expect(dms.calls).toHaveLength(0);
    });

    it.each([
      ['DELETE', `/${TOKEN}`],
      ['POST', `/${TOKEN}`],
      ['GET', `/${TOKEN}/start`],
      ['GET', '/callback/tridum'],
      ['POST', `/verify/${CODE}`],
      ['GET', `/${TOKEN}/unknown`],
    ])('тодорхойлоогүй %s %s → dms руу очихгүй', async (method, path) => {
      const agent = request(url);
      const res = method === 'DELETE' ? await agent.delete(`${BASE}${path}`) : method === 'POST' ? await agent.post(`${BASE}${path}`) : await agent.get(`${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(dms.calls).toHaveLength(0);
    });

    it('controller нь @Public() — глобал JWT guard алгасна', () => {
      expect(Reflect.getMetadata(PUBLIC_KEY, PublicEsignController)).toBe(true);
    });
  });

  describe('параметрийн шалгалт (dms руу очихгүй 404)', () => {
    beforeEach(() => boot());

    const badTokens = [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(41)}.x`,
      `${'A'.repeat(42)}%20`,
      '..%2f..%2fhealth',
      `${TOKEN}%0d%0aX-Evil:1`,
      'verify',
      'callback',
    ];

    for (const route of TOKEN_ROUTES) {
      it(`${route.method.toUpperCase()} :token${route.suffix} — буруу токен бүр 404`, async () => {
        for (const bad of badTokens) {
          const agent = request(url);
          const res = route.method === 'get' ? await agent.get(`${BASE}/${bad}${route.suffix}`) : await agent.post(`${BASE}/${bad}${route.suffix}`);
          expect(res.status, bad).toBe(404);
          expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        }
        expect(dms.calls).toHaveLength(0);
      });
    }

    it.each(['abcdefghjkmn', 'ABCDEFGHJKM', 'ABCDEFGHJKMNP', 'ABCDEFGHJKMI', 'ABCDEFGHJKML', 'ABCDEFGHJKMO', 'ABCDEFGHJKMU', 'ABCDE-FGHJ-KMNP', 'ABCD-EFGH-JKMN-'])(
      'verify: буруу код %s → 404',
      async (code) => {
        const res = await request(url).get(`${BASE}/verify/${code}`);
        expect(res.status).toBe(404);
        expect(dms.calls).toHaveLength(0);
      },
    );

    it.each(['TRIDUM', 'mock', 'tridum%2f..%2fx', 'tridum%00', 'tridum.', 'unknown'])('callback: буруу provider %s → 404', async (provider) => {
      const res = await request(url).post(`${BASE}/callback/${provider}`).send('{}');
      expect(res.status).toBe(404);
      expect(dms.calls).toHaveLength(0);
    });
  });

  describe('толгойн бодлого (хүсэлт)', () => {
    beforeEach(() => boot());

    const ALLOWED_UPSTREAM = new Set([
      // бидний тавьсан
      'content-type',
      'x-correlation-id',
      'x-forwarded-for',
      // fetch (undici) өөрөө тавьдаг
      'host',
      'connection',
      'content-length',
      'accept',
      'accept-language',
      'sec-fetch-mode',
      'user-agent',
      'accept-encoding',
    ]);

    it('cookie/authorization/x-user-id/x-roles/origin зэргийг дамжуулахгүй; x-forwarded-for-ийг жинхэнэ IP-ээр дарна', async () => {
      const res = await request(url)
        .post(`${BASE}/${TOKEN}/start`)
        .set('Content-Type', 'application/json')
        .set('Cookie', 'sid=secret')
        .set('Authorization', 'Bearer top-secret')
        .set('X-User-Id', 'u-1')
        .set('X-Roles', 'ADMIN')
        .set('X-Branch-Id', 'b-1')
        .set('X-Forwarded-For', '6.6.6.6')
        .set('X-Forwarded-Host', 'evil.example')
        .set('X-Real-IP', '6.6.6.6')
        .set('Origin', 'https://evil.example')
        .set('X-Correlation-Id', 'req-123')
        .send({ provider: 'tridum', consent: true });
      expect(res.status).toBe(200);
      const headers = dms.calls[0].headers;
      for (const name of Object.keys(headers)) expect(ALLOWED_UPSTREAM.has(name), `unexpected upstream header ${name}`).toBe(true);
      expect(headers['x-forwarded-for']).toBe('127.0.0.1');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-correlation-id']).toBe('req-123');
      expect(JSON.parse(dms.calls[0].body.toString())).toEqual({ provider: 'tridum', consent: true });
    });

    it('x-correlation-id: хүчинтэйг хадгалж хариунд буцаана; байхгүй/хор хөнөөлтэй бол шинэ UUID', async () => {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      const kept = await request(url).get(`${BASE}/${TOKEN}/status`).set('X-Correlation-Id', 'abc.DEF-123');
      expect(dms.calls[0].headers['x-correlation-id']).toBe('abc.DEF-123');
      expect(kept.headers['x-correlation-id']).toBe('abc.DEF-123');

      const generated = await request(url).get(`${BASE}/${TOKEN}/status`);
      expect(dms.calls[1].headers['x-correlation-id']).toMatch(uuid);
      expect(generated.headers['x-correlation-id']).toBe(dms.calls[1].headers['x-correlation-id']);

      await request(url).get(`${BASE}/${TOKEN}/status`).set('X-Correlation-Id', '<script>alert(1)</script>');
      expect(dms.calls[2].headers['x-correlation-id']).toMatch(uuid);
    });

    it('bие байхгүй POST (decline) → dms бие, content-type хүлээж авахгүй', async () => {
      await request(url).post(`${BASE}/${TOKEN}/decline`);
      expect(dms.calls[0].body).toHaveLength(0);
      expect(dms.calls[0].headers['content-type']).toBeUndefined();
    });

    it('GET-д илгээсэн биеийг дамжуулахгүй', async () => {
      await request(url).get(`${BASE}/${TOKEN}/status`).set('Content-Type', 'application/json').send('{"x":1}');
      expect(dms.calls[0].body).toHaveLength(0);
      expect(dms.calls[0].headers['content-type']).toBeUndefined();
    });
  });

  describe('TRUST_PROXY', () => {
    it('тохируулаагүй бол спуф хийсэн X-Forwarded-For-д итгэхгүй (dms-д сокетын хаяг)', async () => {
      await boot();
      await request(url).get(`${BASE}/${TOKEN}/status`).set('X-Forwarded-For', '203.0.113.9');
      expect(dms.calls[0].headers['x-forwarded-for']).toBe('127.0.0.1');
    });

    it('тохируулсан үед итгэмжлэгдсэн proxy-ийн хойно байгаа клиентийн IP-г дамжуулна (зүүн талын спуфийг үгүйсгэнэ)', async () => {
      await boot({ trustProxy: 'loopback' });
      await request(url).get(`${BASE}/${TOKEN}/status`).set('X-Forwarded-For', '6.6.6.6, 203.0.113.9');
      expect(dms.calls[0].headers['x-forwarded-for']).toBe('203.0.113.9');
    });

    it('X-Forwarded-For IP биш текст бол сокетын хаягт буцна', async () => {
      await boot({ trustProxy: 'loopback' });
      await request(url).get(`${BASE}/${TOKEN}/status`).set('X-Forwarded-For', 'not-an-ip');
      expect(dms.calls[0].headers['x-forwarded-for']).toBe('127.0.0.1');
    });
  });

  describe('webhook (POST callback/:provider)', () => {
    beforeEach(() => boot());

    const post = (provider = 'tridum') => request(url).post(`${BASE}/callback/${provider}`);

    it('JSON биеийг байт-байтаар (хоосон зай, түлхүүрийн дараалал, unicode escape-тэй) дамжуулна', async () => {
      // superagent нь Buffer-ийг JSON content-type-тай үед дахин serialize хийдэг тул string-ээр илгээнэ (ASCII тул байт нь тодорхой)
      const raw = '{ "z" : 1,\n  "a":"\\u00e9\\u0442",  "sig":"A+/=" ,"n":1.50 }\n';
      const res = await post().set('Content-Type', 'application/json').send(raw);
      expect(res.status).toBe(200);
      expect(dms.calls[0].url).toBe('/api/public/esign/callback/tridum');
      expect(dms.calls[0].body.toString('latin1')).toBe(raw);
      expect(dms.calls[0].headers['content-type']).toBe('application/json');
    });

    it('x-www-form-urlencoded биеийг байт-байтаар дамжуулна', async () => {
      const raw = 'sessionId=TRD-1&status=SIGNED&note=%D0%A2%D0%B5%D1%81%D1%82+x%20y&z=&a=1';
      await post('monpass').set('Content-Type', 'application/x-www-form-urlencoded').send(raw);
      expect(dms.calls[0].url).toBe('/api/public/esign/callback/monpass');
      expect(dms.calls[0].body.toString('latin1')).toBe(raw);
    });

    it('parser-т уншигдахгүй төрлийн (octet-stream, xml) бинар биеийг ч байт-байтаар дамжуулна', async () => {
      const binary = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f, 0xfe, 0x00, 0x01]);
      await post().set('Content-Type', 'application/octet-stream').send(binary);
      expect(dms.calls[0].body.equals(binary)).toBe(true);
      const xml = Buffer.from('<?xml version="1.0"?><e  a = "1"/>\r\n');
      await post().set('Content-Type', 'text/xml').send(xml);
      expect(dms.calls[1].body.equals(xml)).toBe(true);
      expect(dms.calls[1].headers['content-type']).toBe('text/xml');
    });

    it('бие байхгүй webhook-ийг дамжуулна', async () => {
      const res = await post();
      expect(res.status).toBe(200);
      expect(dms.calls[0].body).toHaveLength(0);
    });

    it('provider-ийн толгойг (гарын үсэг, authorization, өөрийн толгой) дамжуулж, cookie/hop-by-hop/дотоод итгэмжлэлийг хасна', async () => {
      await post()
        .set('Content-Type', 'application/json')
        .set('X-Signature', 'sha256=abc123')
        .set('X-Tridum-Event', 'session.signed')
        .set('Authorization', 'Bearer provider-callback-secret')
        .set('User-Agent', 'TridumHook/2.1')
        .set('Cookie', 'sid=secret')
        .set('X-User-Id', 'u-1')
        .set('X-Roles', 'ADMIN')
        .set('X-Branch-Id', 'b-1')
        .set('X-Forwarded-For', '6.6.6.6')
        .set('X-Real-IP', '6.6.6.6')
        .set('X-Correlation-Id', 'bad id with spaces')
        .set('Connection', 'keep-alive, X-Hop')
        .set('X-Hop', 'should-not-pass')
        .send('{"ok":true}');
      const h = dms.calls[0].headers;
      expect(h['x-signature']).toBe('sha256=abc123');
      expect(h['x-tridum-event']).toBe('session.signed');
      expect(h['authorization']).toBe('Bearer provider-callback-secret');
      expect(h['user-agent']).toBe('TridumHook/2.1');
      expect(h['content-length']).toBe(String(Buffer.byteLength('{"ok":true}')));
      expect(h['x-forwarded-for']).toBe('127.0.0.1');
      expect(h['x-correlation-id']).not.toBe('bad id with spaces');
      for (const name of ['cookie', 'x-user-id', 'x-roles', 'x-branch-id', 'x-real-ip', 'x-hop']) expect(h[name], name).toBeUndefined();
      // host нь dms-ийнх (gateway-ийн public host биш)
      expect(h.host).toBe(new URL(dms.url).host);
    });

    it('dms-ийн хариуг (статус, биеийг) дамжуулна — гарын үсэг буруу бол 401', async () => {
      dms.handler = jsonReply(401, { code: 'INVALID_SIGNATURE', message: 'x' });
      const res = await post().set('Content-Type', 'application/json').send('{}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'INVALID_SIGNATURE', message: 'x' });
    });

    it('шахсан (content-encoding) бие → 415, dms руу очихгүй', async () => {
      const gz = gzipSync(Buffer.from('{"a":1}'));
      for (const contentType of ['application/json', 'application/octet-stream']) {
        const { req, response } = rawRequest(url, `${BASE}/callback/tridum`, { method: 'POST', headers: { 'content-type': contentType, 'content-encoding': 'gzip' } });
        req.end(gz);
        const res = await response;
        const body = await readBody(res);
        expect(res.statusCode, contentType).toBe(415);
        expect(JSON.parse(body)).toEqual({ code: 'UNSUPPORTED_MEDIA_TYPE', message: expect.any(String) });
      }
      expect(dms.calls).toHaveLength(0);
    });
  });

  describe('биеийн хэмжээний хязгаар', () => {
    beforeEach(() => boot());

    const jsonOfSize = (bytes: number) => {
      const base = JSON.stringify({ provider: 'tridum', consent: true, pad: '' }).length;
      return JSON.stringify({ provider: 'tridum', consent: true, pad: 'x'.repeat(bytes - base) });
    };

    it('start/decline: 8 KB хүртэл зөвшөөрч, түүнээс дээш бол 413 (dms руу очихгүй)', async () => {
      const ok = jsonOfSize(8192);
      expect(Buffer.byteLength(ok)).toBe(8192);
      expect((await request(url).post(`${BASE}/${TOKEN}/start`).set('Content-Type', 'application/json').send(ok)).status).toBe(200);
      expect(dms.calls[0].body.toString()).toBe(ok);

      for (const suffix of ['start', 'decline']) {
        const res = await request(url).post(`${BASE}/${TOKEN}/${suffix}`).set('Content-Type', 'application/json').send(jsonOfSize(8193));
        expect(res.status).toBe(413);
        expect(res.body).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) });
      }
      expect(dms.calls).toHaveLength(1);
    });

    it('webhook: 64 KB хүртэл зөвшөөрч, түүнээс дээш бол 413 (JSON ба бинар)', async () => {
      const ok = Buffer.alloc(65536, 0xab);
      expect((await request(url).post(`${BASE}/callback/tridum`).set('Content-Type', 'application/octet-stream').send(ok)).status).toBe(200);
      expect(dms.calls[0].body.equals(ok)).toBe(true);

      const tooBigBinary = await request(url).post(`${BASE}/callback/tridum`).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(65537, 1));
      expect(tooBigBinary.status).toBe(413);
      expect(tooBigBinary.body).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) });

      const tooBigJson = await request(url).post(`${BASE}/callback/monpass`).set('Content-Type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(70_000) }));
      expect(tooBigJson.status).toBe(413);
      expect(dms.calls).toHaveLength(1);
    });

    it('body-parser-ийн хязгаараас (100 KB) том JSON ч 413, dms руу очихгүй', async () => {
      const res = await request(url).post(`${BASE}/callback/tridum`).set('Content-Type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(150_000) }));
      expect(res.status).toBe(413);
      expect(dms.calls).toHaveLength(0);
    });

    it('Content-Length заагаагүй (chunked) том бие → 413', async () => {
      const { req, response } = rawRequest(url, `${BASE}/callback/tridum`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      });
      req.write(Buffer.alloc(40_000, 1));
      req.end(Buffer.alloc(30_000, 2));
      const res = await response;
      expect(res.statusCode).toBe(413);
      res.resume();
      expect(dms.calls).toHaveLength(0);
    });

    it('chunked бие хязгаарт багтвал дамжина', async () => {
      const { req, response } = rawRequest(url, `${BASE}/callback/tridum`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      });
      req.write(Buffer.from('abc'));
      req.end(Buffer.from('def'));
      const res = await response;
      expect(res.statusCode).toBe(200);
      res.resume();
      expect(dms.calls[0].body.toString()).toBe('abcdef');
    });
  });

  describe('хариуны бодлого', () => {
    beforeEach(() => boot());

    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(20_000), Buffer.from([0x00, 0xff]), Buffer.from('\n%%EOF')]);

    it('PDF: байт-байтаар, content-type/disposition/length-тэй; set-cookie ба upstream-ийн кэш/серверийн толгойг хасна; no-store + nosniff', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="contract.pdf"',
          'content-length': String(pdf.length),
          'set-cookie': ['sid=leak; Path=/; HttpOnly', 'other=1'],
          'cache-control': 'public, max-age=86400',
          etag: '"abc"',
          server: 'dms-internal/1.0',
          'x-powered-by': 'Express',
          location: 'http://dms.internal:4005/secret',
          'access-control-allow-origin': '*',
        });
        res.end(pdf);
      };
      const res = await binary(request(url).get(`${BASE}/${TOKEN}/document`));
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(pdf)).toBe(true);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe('attachment; filename="contract.pdf"');
      expect(res.headers['content-length']).toBe(String(pdf.length));
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      for (const leaked of ['set-cookie', 'etag', 'server', 'x-powered-by', 'location', 'access-control-allow-origin']) {
        expect(res.headers[leaked], leaked).toBeUndefined();
      }
    });

    it('гарын үсэгтэй PDF (signed-document) мөн адил', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="signed.pdf"' });
        res.end(pdf);
      };
      const res = await binary(request(url).get(`${BASE}/${TOKEN}/signed-document`));
      expect((res.body as Buffer).equals(pdf)).toBe(true);
      expect(res.headers['content-disposition']).toBe('attachment; filename="signed.pdf"');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('JSON хариуд ч no-store + nosniff; upstream-ийн Cache-Control-ыг дарна', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=600', 'set-cookie': 'a=b' });
        res.end('{"ok":true}');
      };
      const res = await request(url).get(`${BASE}/${TOKEN}/status`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('алдааны хариу (404, 429, 502) бүр no-store + nosniff', async () => {
      const notFound = await request(url).get(`${BASE}/short`);
      expect(notFound.status).toBe(404);
      expect(notFound.headers['cache-control']).toBe('no-store');
      expect(notFound.headers['x-content-type-options']).toBe('nosniff');
    });

    it('PDF-ийг buffer-лэхгүй stream-ээр дамжуулна: эхний chunk нь dms дуусахаас өмнө клиентэд хүрнэ', async () => {
      const release = deferred();
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.write('%PDF-first-chunk');
        void release.promise.then(() => res.end('-second-chunk'));
      };
      const { req, response } = rawRequest(url, `${BASE}/${TOKEN}/document`);
      req.end();
      const res = await response;
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      const first = await new Promise<Buffer>((resolve) => res.once('data', resolve));
      expect(first.toString()).toBe('%PDF-first-chunk');
      release.resolve();
      const rest: Buffer[] = [];
      for await (const chunk of res) rest.push(chunk as Buffer);
      expect(Buffer.concat(rest).toString()).toBe('-second-chunk');
    });

    it('upstream шахсан хариуг fetch тайлж, content-encoding/уртыг клиентэд хуучин утгаар нь дамжуулахгүй', async () => {
      const payload = { hello: 'world', mn: 'Сайн байна уу' };
      const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
        res.end(gz);
      };
      const res = await request(url).get(`${BASE}/${TOKEN}/status`);
      expect(res.body).toEqual(payload);
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it('dms redirect (3xx) илгээвэл Location гаргахгүй 502', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(302, { location: 'http://dms.internal:4005/elsewhere' });
        res.end();
      };
      const res = await request(url).get(`${BASE}/${TOKEN}/status`);
      expect(res.status).toBe(502);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).not.toContain('dms.internal');
    });
  });

  describe('rate limit', () => {
    const cfg = (limits: Partial<ProxyConfig['rateLimits']>) => (base: ProxyConfig) => ({ ...base, rateLimits: { ...base.rateLimits, ...limits } });

    it('default: 60/мин/IP — 61 дэх хүсэлт 429 + Retry-After + no-store, dms руу очихгүй', async () => {
      await boot();
      for (let i = 0; i < 60; i++) expect((await request(url).get(`${BASE}/${TOKEN}`)).status).toBe(200);
      const res = await request(url).get(`${BASE}/${TOKEN}`);
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ code: 'RATE_LIMITED', message: expect.any(String) });
      expect(res.headers['retry-after']).toBe('60');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(dms.calls).toHaveLength(60);
    });

    it('Retry-After нь цонх дуусах хугацаатай уялдаж, цонх дуусмагц дахин зөвшөөрнө', async () => {
      await boot({ config: cfg({ read: 2 }) });
      await request(url).get(`${BASE}/${TOKEN}`);
      await request(url).get(`${BASE}/${TOKEN}`);
      nowMs += 15_000;
      const limited = await request(url).get(`${BASE}/${TOKEN}`);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBe('45');
      nowMs += 45_000;
      expect((await request(url).get(`${BASE}/${TOKEN}`)).status).toBe(200);
    });

    it('POST start нь 10/мин-ийн хатуу бүлэг; бусад бүлэг нөлөөлөхгүй, decline үүнтэй хуваалцана', async () => {
      await boot();
      for (let i = 0; i < 10; i++) expect((await request(url).post(`${BASE}/${TOKEN}/start`).send({ provider: 'tridum', consent: true })).status).toBe(200);
      const eleventh = await request(url).post(`${BASE}/${TOKEN}/start`).send({ provider: 'tridum', consent: true });
      expect(eleventh.status).toBe(429);
      expect(eleventh.headers['retry-after']).toBe('60');
      expect((await request(url).post(`${BASE}/${TOKEN}/decline`)).status).toBe(429);
      // унших, poll, verify хэвээр
      expect((await request(url).get(`${BASE}/${TOKEN}`)).status).toBe(200);
      expect((await request(url).get(`${BASE}/${TOKEN}/status`)).status).toBe(200);
      expect((await request(url).get(`${BASE}/verify/${CODE}`)).status).toBe(200);
      expect(dms.calls).toHaveLength(13);
    });

    it('status poll нь бусад унших хүсэлтээс тусдаа бүлэг', async () => {
      await boot({ config: cfg({ read: 2, poll: 3 }) });
      for (let i = 0; i < 2; i++) await request(url).get(`${BASE}/${TOKEN}/document`);
      expect((await request(url).get(`${BASE}/${TOKEN}`)).status).toBe(429);
      expect((await request(url).get(`${BASE}/verify/${CODE}`)).status).toBe(429); // verify нь read бүлэг
      for (let i = 0; i < 3; i++) expect((await request(url).get(`${BASE}/${TOKEN}/status`)).status).toBe(200);
      expect((await request(url).get(`${BASE}/${TOKEN}/status`)).status).toBe(429);
    });

    it('ESIGN_RATE_LIMIT_PER_MIN 10-аас бага бол start-ийн хязгаар түүнтэй адил (config)', async () => {
      await boot({ config: () => loadProxyConfig({ DMS_URL: dms.url, ESIGN_RATE_LIMIT_PER_MIN: '3' }) });
      for (let i = 0; i < 3; i++) expect((await request(url).post(`${BASE}/${TOKEN}/start`).send({})).status).toBe(200);
      expect((await request(url).post(`${BASE}/${TOKEN}/start`).send({})).status).toBe(429);
    });

    it('буруу параметртэй (404) хүсэлт ч тоологдоно — токен таамаглахыг хязгаарлана', async () => {
      await boot({ config: cfg({ read: 3 }) });
      for (let i = 0; i < 3; i++) expect((await request(url).get(`${BASE}/${'B'.repeat(43 - i - 1)}`)).status).toBe(404);
      expect((await request(url).get(`${BASE}/${'B'.repeat(10)}`)).status).toBe(429);
      expect(dms.calls).toHaveLength(0);
    });

    it('IP бүр тусдаа тоологдоно (trust proxy-той); IPv6 нь /64-өөр нэгдэнэ', async () => {
      await boot({ trustProxy: 'loopback', config: cfg({ read: 1 }) });
      const get = (ip: string) => request(url).get(`${BASE}/${TOKEN}`).set('X-Forwarded-For', ip);
      expect((await get('203.0.113.1')).status).toBe(200);
      expect((await get('203.0.113.1')).status).toBe(429);
      expect((await get('203.0.113.2')).status).toBe(200);
      expect((await get('2001:db8:1:2::1')).status).toBe(200);
      expect((await get('2001:db8:1:2:ffff::9')).status).toBe(429); // ижил /64
      expect((await get('2001:db8:1:3::1')).status).toBe(200); // өөр /64
    });

    it('spoof хийсэн X-Forwarded-For нь trust proxy-гүй үед хязгаараас гарах арга болохгүй', async () => {
      await boot({ config: cfg({ read: 2 }) });
      for (const ip of ['1.1.1.1', '2.2.2.2']) expect((await request(url).get(`${BASE}/${TOKEN}`).set('X-Forwarded-For', ip)).status).toBe(200);
      expect((await request(url).get(`${BASE}/${TOKEN}`).set('X-Forwarded-For', '3.3.3.3')).status).toBe(429);
    });

    it('webhook: IP тус бүрийн хязгаараас чөлөөтэй, харин нийт хязгаартай (429 + Retry-After)', async () => {
      await boot({ config: cfg({ read: 1, action: 1, webhook: 5 }) });
      for (let i = 0; i < 5; i++) expect((await request(url).post(`${BASE}/callback/tridum`).send({})).status).toBe(200);
      const limited = await request(url).post(`${BASE}/callback/monpass`).send({});
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBe('60');
      nowMs += 60_000;
      expect((await request(url).post(`${BASE}/callback/monpass`).send({})).status).toBe(200);
    });
  });

  describe('upstream алдаа', () => {
    it('dms унтарсан → 502 UPSTREAM_UNAVAILABLE; дотоод URL/порт/стек/алдааны нэр гарахгүй; лог токенгүй', async () => {
      const dead = await closedPortUrl();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await boot({ dmsUrl: dead });
      const res = await request(url).get(`${BASE}/${TOKEN}/status`).set('X-Correlation-Id', 'corr-77');
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: expect.stringMatching(/[А-Яа-яӨөҮү]/) });
      expect(res.headers['cache-control']).toBe('no-store');
      const wire = JSON.stringify([res.body, res.headers, res.text]);
      for (const secret of [new URL(dead).port, '127.0.0.1', 'localhost', 'ECONNREFUSED', 'fetch', 'TypeError', ' at ', 'node:', TOKEN, '/api/public/esign']) {
        expect(wire, secret).not.toContain(secret);
      }
      // лог: route-ийн нэр, correlationId, шалтгаан — токен, URL байхгүй
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0][0]);
      expect(JSON.parse(logged)).toEqual({ event: 'esign_proxy_upstream_failure', route: 'status', correlationId: 'corr-77', reason: 'ECONNREFUSED' });
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(new URL(dead).port);
    });

    it('PDF route ч dms унтарсан үед 502 JSON', async () => {
      await boot({ dmsUrl: await closedPortUrl() });
      const res = await request(url).get(`${BASE}/${TOKEN}/document`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
    });

    it('JSON route-ийн timeout → 502, upstream хүсэлт таслагдана', async () => {
      const aborted = deferred();
      dms.handler = (_req, res) => {
        res.on('close', () => aborted.resolve());
        // хариу өгөхгүй
      };
      await boot({ config: (base) => ({ ...base, timeouts: { headersMs: 150, jsonTotalMs: 150, pdfTotalMs: 400 } }) });
      const started = Date.now();
      const res = await request(url).get(`${BASE}/${TOKEN}/status`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(Date.now() - started).toBeLessThan(3000);
      await aborted.promise;
    });

    it('толгой ирсний дараа JSON бие гацвал jsonTotalMs дээр холболт таслагдана', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
      };
      await boot({ config: (base) => ({ ...base, timeouts: { headersMs: 1000, jsonTotalMs: 200, pdfTotalMs: 5000 } }) });
      const { req, response } = rawRequest(url, `${BASE}/${TOKEN}/status`);
      req.end();
      const res = await response;
      res.on('error', () => undefined);
      await new Promise<void>((resolve) => res.once('close', resolve));
      expect(res.complete).toBe(false);
    });

    it('PDF stream-ийн нийт хугацаа JSON-оос урт: pdfTotalMs хүртэл хүлээнэ, дараа нь таслана', async () => {
      const release = deferred();
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.write('part-1;');
        void release.promise.then(() => res.end('part-2'));
      };
      await boot({ config: (base) => ({ ...base, timeouts: { headersMs: 1000, jsonTotalMs: 100, pdfTotalMs: 1500 } }) });
      const { req, response } = rawRequest(url, `${BASE}/${TOKEN}/document`);
      req.end();
      const res = await response;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      await new Promise((r) => setTimeout(r, 400)); // jsonTotalMs (100) өнгөрсөн ч PDF таслагдаагүй
      expect(res.destroyed).toBe(false);
      release.resolve();
      await new Promise<void>((resolve) => res.once('end', resolve));
      expect(Buffer.concat(chunks).toString()).toBe('part-1;part-2');
    });

    it('PDF stream гацвал pdfTotalMs дээр таслагдана (дутуу файл complete=false)', async () => {
      dms.handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '1000' });
        res.write('%PDF-partial');
      };
      await boot({ config: (base) => ({ ...base, timeouts: { headersMs: 1000, jsonTotalMs: 100, pdfTotalMs: 300 } }) });
      const { req, response } = rawRequest(url, `${BASE}/${TOKEN}/document`);
      req.end();
      const res = await response;
      res.on('error', () => undefined);
      res.resume();
      await new Promise<void>((resolve) => res.once('close', resolve));
      expect(res.complete).toBe(false);
    });

    it('клиент таслагдвал dms-д хүрсэн хүсэлт ч таслагдана', async () => {
      const aborted = deferred();
      const arrived = deferred();
      dms.handler = (_req, res) => {
        res.on('close', () => aborted.resolve());
        arrived.resolve();
      };
      await boot();
      const { req, response } = rawRequest(url, `${BASE}/${TOKEN}/status`);
      response.catch(() => undefined);
      req.on('error', () => undefined);
      req.end();
      await arrived.promise;
      req.destroy();
      await aborted.promise;
    });

    it('клиент PDF татах үедээ таслагдвал dms-ийн stream ч таслагдана', async () => {
      const aborted = deferred();
      dms.handler = (_req, res) => {
        res.on('close', () => aborted.resolve());
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.write('chunk');
      };
      await boot();
      const { req, response } = rawRequest(url, `${BASE}/${TOKEN}/document`);
      req.end();
      const res = await response;
      res.on('error', () => undefined);
      await new Promise((resolve) => res.once('data', resolve));
      res.destroy();
      await aborted.promise;
    });
  });
});
