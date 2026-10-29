import { createHmac } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErpEventPayload } from '@los/contracts';
import { ErpPostError } from './erp.interface';
import { RealErpClient, parseRetryAfter, type RealErpClientOptions } from './real.client';

// ---------------------------------------------------------------- fixtures
const NOW = new Date('2026-10-28T03:00:00.000Z');
const NOW_SECONDS = String(Math.floor(NOW.getTime() / 1000));
const SECRET = 'whsec_0123456789abcdef-0123456789';
const TOKEN = 'tok_live_Zk39sdf8723hsd9fHJ';
const CTX = { correlationId: 'corr-xyz', attemptNo: 3 };

function payload(over: Partial<ErpEventPayload> = {}): ErpEventPayload {
  return {
    schemaVersion: 1,
    eventId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'DISBURSEMENT:req-1',
    eventType: 'DISBURSEMENT',
    orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'C-2026-0001', coreLoanId: null, customerId: 'cus-1',
    businessDate: '2026-10-28', currency: 'MNT',
    data: { amount: '10000000.00' },
    correlationId: 'corr-xyz', createdAt: '2026-10-28T01:00:00.000Z',
    ...over,
  };
}

function client(url: string, over: Partial<RealErpClientOptions> = {}): RealErpClient {
  // requireAck: false — most tests only care about the request/classification; the acknowledgement rules have their own describe block
  return new RealErpClient({ url, webhookSecret: SECRET, timeoutMs: 5_000, now: () => NOW, requireAck: false, ...over });
}

const sign = (secret: string, timestamp: string, rawBody: string) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

async function failureOf(p: Promise<unknown>): Promise<ErpPostError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ErpPostError); return e as ErpPostError; }
  throw new Error('expected the call to reject');
}

// ---------------------------------------------------------------- test HTTP server (real sockets on 127.0.0.1)
interface Captured { method: string; url: string; headers: IncomingHttpHeaders; rawBody: string; }
type Handler = (req: IncomingMessage, res: ServerResponse, rawBody: string) => void;
interface TestServer { server: Server; port: number; url: string; requests: Captured[]; }

const openServers: Server[] = [];

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawBody });
      handler(req, res, rawBody);
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}`, requests };
}

afterEach(async () => {
  const servers = openServers.splice(0);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
  vi.restoreAllMocks();
});

const reply = (status: number, body: string | undefined, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, headers);
  if (body === undefined) res.end(); else res.end(body);
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  reply(status, JSON.stringify(body), { 'content-type': 'application/json', ...headers });

// A port that was free a moment ago and has nothing listening now (connection refused).
async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

// Streams `status` + an endless body until the client hangs up; `closed` resolves once the connection is gone.
function endlessBody(status: number, headers: Record<string, string> = {}) {
  const state = { bytes: 0, endedByServer: false };
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const handler: Handler = (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain', ...headers });
    const chunk = Buffer.alloc(16 * 1024, 'x');
    const LIMIT = 256 * 1024 * 1024; // safety net so a client that reads everything fails an assertion instead of hanging
    res.on('close', () => { state.endedByServer = res.writableFinished; markClosed(); });
    const pump = () => {
      while (!res.destroyed && !res.writableEnded) {
        if (state.bytes >= LIMIT) { res.end(); return; }
        state.bytes += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
    };
    pump();
  };
  return { handler, state, closed };
}

// ================================================================ tests
describe('RealErpClient constructor', () => {
  const base = { webhookSecret: SECRET, timeoutMs: 1_000 };

  it('identifies itself as the webhook gateway', () => {
    expect(new RealErpClient({ ...base, url: 'https://erp.example.com/hook' }).name).toBe('webhook');
  });

  it.each([
    'https://erp.example.com/hook', 'https://erp.example.com:8443/api/v1/journals?x=1',
    'http://localhost:4010/hook', 'http://127.0.0.1:4010/hook', 'http://[::1]:4010/hook', 'http://LOCALHOST/hook',
  ])('accepts %s without allowInsecure', (url) => {
    expect(() => new RealErpClient({ ...base, url })).not.toThrow();
  });

  it.each([
    'http://erp.example.com/hook', 'http://10.0.0.5/hook', 'http://localhost.evil.com/hook', 'http://127.0.0.1.evil.com/hook', 'http://evil-localhost/hook',
  ])('rejects plain-http %s unless allowInsecure is set', (url) => {
    expect(() => new RealErpClient({ ...base, url })).toThrow(/must be https/);
    expect(() => new RealErpClient({ ...base, url, allowInsecure: false })).toThrow(/must be https/);
  });

  it('accepts plain http for any host when allowInsecure is true', () => {
    expect(() => new RealErpClient({ ...base, url: 'http://erp.internal:8080/hook', allowInsecure: true })).not.toThrow();
  });

  it('rejects a non-URL string', () => {
    expect(() => new RealErpClient({ ...base, url: 'not a url' })).toThrow();
  });

  it('requires a non-empty webhook secret', () => {
    expect(() => new RealErpClient({ ...base, url: 'https://erp.example.com/hook', webhookSecret: '' })).toThrow(/ERP_WEBHOOK_SECRET is required/);
  });

  it('does not echo the secret or the token in constructor errors', () => {
    for (const make of [
      () => new RealErpClient({ url: 'http://erp.example.com/hook', webhookSecret: SECRET, token: TOKEN, timeoutMs: 1_000 }),
      () => new RealErpClient({ url: 'nonsense', webhookSecret: SECRET, token: TOKEN, timeoutMs: 1_000 }),
    ]) {
      try { make(); throw new Error('expected a throw'); } catch (e) {
        expect((e as Error).message).not.toContain(SECRET);
        expect((e as Error).message).not.toContain(TOKEN);
      }
    }
  });
});

describe('RealErpClient request', () => {
  it('POSTs the payload JSON to the configured path and query string', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    await client(`${srv.url}/api/v1/journals?tenant=a%20b`).post(payload(), CTX);
    expect(srv.requests).toHaveLength(1);
    const [req] = srv.requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/journals?tenant=a%20b');
    expect(req.rawBody).toBe(JSON.stringify(payload()));
    expect(JSON.parse(req.rawBody)).toEqual(payload());
    expect(Number(req.headers['content-length'])).toBe(Buffer.byteLength(req.rawBody));
  });

  it('sends the documented headers', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    const p = payload();
    await client(srv.url).post(p, CTX);
    const h = srv.requests[0].headers;
    expect(h['content-type']).toBe('application/json');
    expect(h.accept).toBe('application/json');
    expect(h['idempotency-key']).toBe('DISBURSEMENT:req-1');
    expect(h['x-los-event-id']).toBe(p.eventId);
    expect(h['x-los-event-type']).toBe('DISBURSEMENT');
    expect(h['x-los-timestamp']).toBe(NOW_SECONDS);
    expect(h['x-correlation-id']).toBe('corr-xyz');
    expect(h['x-los-attempt']).toBe('3');
  });

  it('signs `${timestamp}.${rawBody}` with HMAC-SHA256 so the receiver can recompute it', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    await client(srv.url).post(payload({ eventType: 'FEE_DEDUCTION', data: { fees: [{ kind: 'OTHER', amount: '10000000.00', memo: 'Зээл олголт' }], totalAmount: '10000000.00' } }), CTX);
    const { headers, rawBody } = srv.requests[0];
    const signature = String(headers['x-los-signature']);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signature).toBe(sign(SECRET, String(headers['x-los-timestamp']), rawBody));
    // body (with Cyrillic text) is signed over the exact UTF-8 bytes that were sent
    expect(rawBody).toContain('Зээл олголт');
    // not valid for another secret, another timestamp or a tampered body
    expect(signature).not.toBe(sign('another-secret-value-123456', NOW_SECONDS, rawBody));
    expect(signature).not.toBe(sign(SECRET, String(Number(NOW_SECONDS) + 1), rawBody));
    expect(signature).not.toBe(sign(SECRET, NOW_SECONDS, rawBody.replace('10000000.00', '10000000.01')));
  });

  it('uses a fresh timestamp and attempt number on each delivery attempt but keeps key and body stable', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    let t = NOW.getTime();
    const c = client(srv.url, { now: () => new Date(t) });
    await c.post(payload(), { correlationId: 'corr-xyz', attemptNo: 1 });
    t += 61_000;
    await c.post(payload(), { correlationId: 'corr-xyz', attemptNo: 2 });
    const [a, b] = srv.requests;
    expect(a.headers['idempotency-key']).toBe(b.headers['idempotency-key']);
    expect(a.rawBody).toBe(b.rawBody);
    expect([a.headers['x-los-attempt'], b.headers['x-los-attempt']]).toEqual(['1', '2']);
    expect(Number(b.headers['x-los-timestamp']) - Number(a.headers['x-los-timestamp'])).toBe(61);
    expect(a.headers['x-los-signature']).not.toBe(b.headers['x-los-signature']);
    expect(b.headers['x-los-signature']).toBe(sign(SECRET, String(b.headers['x-los-timestamp']), b.rawBody));
  });

  it('uses the real clock for the timestamp when no clock is injected', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    const before = Math.floor(Date.now() / 1000);
    await new RealErpClient({ url: srv.url, webhookSecret: SECRET, timeoutMs: 5_000 }).post(payload(), CTX);
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(srv.requests[0].headers['x-los-timestamp']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('sends a bearer token only when one is configured', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    await client(srv.url).post(payload(), CTX);
    await client(srv.url, { token: '' }).post(payload(), CTX);
    await client(srv.url, { token: TOKEN }).post(payload(), CTX);
    expect(srv.requests.map((r) => r.headers.authorization)).toEqual([undefined, undefined, `Bearer ${TOKEN}`]);
  });

  it('never transmits the webhook secret itself', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    await client(srv.url, { token: TOKEN }).post(payload(), CTX);
    const { headers, rawBody } = srv.requests[0];
    expect(rawBody).not.toContain(SECRET);
    for (const v of Object.values(headers)) expect(String(v)).not.toContain(SECRET);
  });

  it('passes redirect: manual, a timeout signal and the raw JSON string body to fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await client('https://erp.example.com/hook', { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1234 }).post(payload(), CTX);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(input)).toBe('https://erp.example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBe(JSON.stringify(payload()));
  });
});

describe('RealErpClient success responses', () => {
  it.each([[200], [201]])('treats HTTP %i with a JSON body as success', async (status) => {
    const srv = await startServer(json(status, { reference: 'GL-100' }));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: 'GL-100', duplicate: false });
  });

  it('treats HTTP 204 with no body as success without an externalRef', async () => {
    const srv = await startServer(reply(204, undefined));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: null, duplicate: false });
  });

  it('treats an empty 200 body as success without an externalRef', async () => {
    const srv = await startServer(reply(200, ''));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: null, duplicate: false });
  });

  it.each(['reference', 'externalRef', 'documentId', 'journalId', 'id'])('picks the external reference from the "%s" field', async (field) => {
    const srv = await startServer(json(200, { [field]: 'REF-7', status: 'ok' }));
    expect((await client(srv.url).post(payload(), CTX)).externalRef).toBe('REF-7');
  });

  it('prefers reference > externalRef > documentId > journalId > id', async () => {
    const all = { id: 'i', journalId: 'j', documentId: 'd', externalRef: 'e', reference: 'r' };
    const order: Array<[string, string]> = [['reference', 'r'], ['externalRef', 'e'], ['documentId', 'd'], ['journalId', 'j'], ['id', 'i']];
    const remaining: Record<string, string> = { ...all };
    for (const [field, expected] of order) {
      const srv = await startServer(json(200, remaining));
      expect((await client(srv.url).post(payload(), CTX)).externalRef).toBe(expected);
      delete remaining[field];
    }
  });

  it.each([[4711, '4711'], [0, '0'], [12.5, '12.5']])('stringifies the numeric reference %s', async (value, expected) => {
    const srv = await startServer(json(201, { id: value }));
    expect((await client(srv.url).post(payload(), CTX)).externalRef).toBe(expected);
  });

  it('skips an empty-string reference and falls through to the next field', async () => {
    const srv = await startServer(json(200, { reference: '', id: 'fallback' }));
    expect((await client(srv.url).post(payload(), CTX)).externalRef).toBe('fallback');
  });

  it.each([
    ['an object without a known field', JSON.stringify({ status: 'ok' })],
    ['a non-JSON text body', 'OK'],
    ['a JSON array', JSON.stringify([{ id: 1 }])],
    ['a JSON string', JSON.stringify('R-1')],
    ['a boolean id', JSON.stringify({ id: true })],
    ['a null reference', JSON.stringify({ reference: null })],
  ])('returns externalRef=null for %s', async (_label, body) => {
    const srv = await startServer(reply(200, body, { 'content-type': 'application/json' }));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: null, duplicate: false });
  });

  it('still extracts the reference from a truncated JSON body', async () => {
    const srv = await startServer(reply(200, '{"reference": "R-1"', { 'content-type': 'application/json' }));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: 'R-1', duplicate: false });
  });

  it('strips control characters from the reference and caps its length', async () => {
    const srv = await startServer(json(200, { reference: `GL\u0000-\n7${'z'.repeat(300)}` }));
    const ref = (await client(srv.url).post(payload(), CTX)).externalRef as string;
    expect(ref.startsWith('GL - 7z')).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(128);
    // eslint-disable-next-line no-control-regex
    expect(ref).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('RealErpClient acknowledgement (requireAck)', () => {
  const strict = (url: string) => client(url, { requireAck: true });

  it('is on by default: a 2xx without a reference is retryable NO_ACK, not a success', async () => {
    const srv = await startServer(json(200, { status: 'ok' }));
    const err = await failureOf(new RealErpClient({ url: srv.url, webhookSecret: SECRET, timeoutMs: 5_000, now: () => NOW }).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'NO_ACK', 200]);
  });

  it.each([[200, undefined], [204, undefined], [200, '<html>login</html>']])('treats HTTP %i with body %j as NO_ACK', async (status, body) => {
    const srv = await startServer(reply(status, body));
    expect((await failureOf(strict(srv.url).post(payload(), CTX))).code).toBe('NO_ACK');
  });

  it('accepts a 2xx that carries a reference', async () => {
    const srv = await startServer(json(201, { id: 'GL-5' }));
    expect(await strict(srv.url).post(payload(), CTX)).toEqual({ externalRef: 'GL-5', duplicate: false });
  });

  it('accepts a replay acknowledgement without a reference', async () => {
    const srv = await startServer(reply(200, '', { 'Idempotent-Replayed': 'true' }));
    expect(await strict(srv.url).post(payload(), CTX)).toEqual({ externalRef: null, duplicate: true });
  });

  it('refuses an HTML page (a wrong URL or a captive portal) even when it contains a reference-looking field', async () => {
    const srv = await startServer(reply(200, '<html>"id": "12345"</html>', { 'content-type': 'text/html; charset=utf-8' }));
    const err = await failureOf(strict(srv.url).post(payload(), CTX));
    expect([err.kind, err.code]).toEqual(['RETRYABLE', 'UNEXPECTED_CONTENT']);
  });
});

describe('RealErpClient duplicate detection', () => {
  it.each([[200], [201], [204]])('reports duplicate=true for HTTP %i with Idempotent-Replayed: true', async (status) => {
    const srv = await startServer(status === 204 ? reply(204, undefined, { 'Idempotent-Replayed': 'true' }) : json(status, { reference: 'GL-1' }, { 'Idempotent-Replayed': 'true' }));
    const res = await client(srv.url).post(payload(), CTX);
    expect(res.duplicate).toBe(true);
    expect(res.externalRef).toBe(status === 204 ? null : 'GL-1');
  });

  it('reports duplicate=true for a {"duplicate": true} body', async () => {
    const srv = await startServer(json(200, { duplicate: true, reference: 'GL-2' }));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: 'GL-2', duplicate: true });
  });

  it('does not report a duplicate for Idempotent-Replayed: false or {"duplicate": false}', async () => {
    const a = await startServer(json(200, { reference: 'GL-3' }, { 'Idempotent-Replayed': 'false' }));
    const b = await startServer(json(200, { reference: 'GL-3', duplicate: false }));
    expect((await client(a.url).post(payload(), CTX)).duplicate).toBe(false);
    expect((await client(b.url).post(payload(), CTX)).duplicate).toBe(false);
  });

  it('treats 409 with Idempotent-Replayed: true as an already-posted duplicate success', async () => {
    const srv = await startServer(json(409, { error: 'already exists', reference: 'GL-9' }, { 'Idempotent-Replayed': 'true' }));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: 'GL-9', duplicate: true });
  });

  it('treats 409 with {"duplicate": true} as an already-posted duplicate success, with or without a reference', async () => {
    const withRef = await startServer(json(409, { duplicate: true, id: 90210 }));
    const without = await startServer(json(409, { duplicate: true }));
    expect(await client(withRef.url).post(payload(), CTX)).toEqual({ externalRef: '90210', duplicate: true });
    expect(await client(without.url).post(payload(), CTX)).toEqual({ externalRef: null, duplicate: true });
  });

  // A 409 for a closed period or a rule violation also carries ids (trace id, error id); reading it as "already posted" would silently lose the event
  it.each(['reference', 'externalRef', 'documentId', 'journalId', 'id'])('does NOT treat a 409 that merely carries "%s" as a duplicate', async (field) => {
    const srv = await startServer(json(409, { error: 'period closed', [field]: 'TRACE-9' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['PERMANENT', 'REJECTED', 409]);
  });

  it.each([
    ['a JSON error without a reference', JSON.stringify({ error: 'period closed' })],
    ['an empty body', ''],
    ['a plain-text body', 'Conflict'],
  ])('treats 409 with %s as a PERMANENT rejection', async (_label, body) => {
    const srv = await startServer(reply(409, body, { 'content-type': 'application/json' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['PERMANENT', 'REJECTED', 409]);
  });
});

describe('RealErpClient error classification', () => {
  it.each([[400], [413], [422]])('classifies HTTP %i as PERMANENT REJECTED', async (status) => {
    const srv = await startServer(json(status, { error: 'invalid event', field: 'data.amount' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['PERMANENT', 'REJECTED', status]);
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.message).toContain(`ERP responded ${status}`);
    expect(err.message).toContain('invalid event');
  });

  // Буруу зам/proxy-ийн хариу: журнал өөрөө буруу биш тул DEAD болгохгүй, backoff-оор дахин оролдож тохиргоо засагдахыг хүлээнэ
  it.each([[404], [405], [406], [410], [415], [421]])('classifies HTTP %i as RETRYABLE ROUTE_ERROR (a wrong URL must not dead-letter every event)', async (status) => {
    const srv = await startServer(json(status, { error: 'no such route' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'ROUTE_ERROR', status]);
  });

  it.each([[401], [403]])('classifies HTTP %i as RETRYABLE AUTH_REJECTED', async (status) => {
    const srv = await startServer(json(status, { error: 'unauthorized' }));
    const err = await failureOf(client(srv.url, { token: TOKEN }).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'AUTH_REJECTED', status]);
  });

  it.each([[408], [425], [429]])('classifies HTTP %i as RETRYABLE THROTTLED', async (status) => {
    const srv = await startServer(json(status, { error: 'slow down' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'THROTTLED', status]);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it.each([[500], [502], [503], [504]])('classifies HTTP %i as RETRYABLE SERVER_ERROR', async (status) => {
    const srv = await startServer(reply(status, '<html>upstream failure</html>', { 'content-type': 'text/html' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'SERVER_ERROR', status]);
    expect(err.retryAfterMs).toBeUndefined();
  });

  describe('Retry-After', () => {
    it.each([[408], [425], [429], [503]])('parses delta-seconds on HTTP %i', async (status) => {
      const srv = await startServer(reply(status, '', { 'Retry-After': '7' }));
      expect((await failureOf(client(srv.url).post(payload(), CTX))).retryAfterMs).toBe(7_000);
    });

    it.each([[429, 'THROTTLED'], [503, 'SERVER_ERROR']])('parses an HTTP-date relative to the injected clock on HTTP %i', async (status, code) => {
      const at = new Date(NOW.getTime() + 90_000).toUTCString();
      const srv = await startServer(reply(status, '', { 'Retry-After': at }));
      const err = await failureOf(client(srv.url).post(payload(), CTX));
      expect(err.code).toBe(code);
      expect(err.retryAfterMs).toBe(90_000);
    });

    it('clamps an excessive delay to 24 hours and a past date to zero', async () => {
      const long = await startServer(reply(429, '', { 'Retry-After': '999999' }));
      const past = await startServer(reply(429, '', { 'Retry-After': new Date(NOW.getTime() - 3_600_000).toUTCString() }));
      const far = await startServer(reply(503, '', { 'Retry-After': new Date(NOW.getTime() + 30 * 86_400_000).toUTCString() }));
      expect((await failureOf(client(long.url).post(payload(), CTX))).retryAfterMs).toBe(86_400_000);
      expect((await failureOf(client(past.url).post(payload(), CTX))).retryAfterMs).toBe(0);
      expect((await failureOf(client(far.url).post(payload(), CTX))).retryAfterMs).toBe(86_400_000);
    });

    it('ignores an unparseable Retry-After', async () => {
      const srv = await startServer(reply(429, '', { 'Retry-After': 'soon-ish' }));
      expect((await failureOf(client(srv.url).post(payload(), CTX))).retryAfterMs).toBeUndefined();
    });
  });
});

describe('parseRetryAfter', () => {
  it.each([[null], [''], ['soon'], ['NaN'], ['Infinity'], ['not a date at all']])('returns undefined for %j', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeUndefined();
  });

  it.each([
    ['0', 0], ['1', 1_000], ['120', 120_000], ['1.5', 1_500], ['86400', 86_400_000],
    ['86401', 86_400_000], ['999999999', 86_400_000], ['-5', 0],
  ])('converts delta-seconds %j to %i ms (clamped to [0, 24h])', (header, expected) => {
    expect(parseRetryAfter(header, NOW)).toBe(expected);
  });

  it('converts an HTTP-date to milliseconds from now', () => {
    expect(parseRetryAfter(new Date(NOW.getTime() + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfter('Wed, 28 Oct 2026 03:00:30 GMT', NOW)).toBe(30_000);
  });

  it('clamps HTTP-dates in the past to 0 and far in the future to 24 hours', () => {
    expect(parseRetryAfter(new Date(NOW.getTime() - 1).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW.getTime() - 10 * 86_400_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW.getTime() + 86_400_000).toUTCString(), NOW)).toBe(86_400_000);
    expect(parseRetryAfter(new Date(NOW.getTime() + 10 * 86_400_000).toUTCString(), NOW)).toBe(86_400_000);
  });
});

describe('RealErpClient redirects', () => {
  it.each([[301], [302], [303], [307], [308]])('does not follow HTTP %i and classifies it as RETRYABLE REDIRECT', async (status) => {
    const target = await startServer(json(200, { reference: 'SHOULD-NEVER-BE-REACHED' }));
    const origin = await startServer(reply(status, '', { Location: `${target.url}/stolen` }));
    const err = await failureOf(client(origin.url, { token: TOKEN }).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'REDIRECT', status]);
    expect(origin.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });

  it('never forwards the bearer token, signature or body to the redirect target', async () => {
    const target = await startServer(json(200, {}));
    const origin = await startServer(reply(307, '', { Location: `${target.url}/stolen` }));
    await failureOf(client(origin.url, { token: TOKEN }).post(payload(), CTX));
    expect(target.requests).toHaveLength(0);
    expect(JSON.stringify(target.requests)).not.toContain(TOKEN);
  });

  it('does not treat a redirect to a body with a reference as success', async () => {
    const origin = await startServer(reply(302, JSON.stringify({ reference: 'R-1' }), { Location: 'http://127.0.0.1:1/elsewhere', 'content-type': 'application/json' }));
    const err = await failureOf(client(origin.url).post(payload(), CTX));
    expect(err.code).toBe('REDIRECT');
  });
});

describe('RealErpClient timeouts and network failures', () => {
  it('maps a request that is never answered to RETRYABLE TIMEOUT', async () => {
    const srv = await startServer(() => undefined);
    const err = await failureOf(client(srv.url, { timeoutMs: 30 }).post(payload(), CTX));
    expect([err.kind, err.code]).toEqual(['RETRYABLE', 'TIMEOUT']);
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toContain('30ms');
  });

  it.each([
    ['TimeoutError', 'TimeoutError'],
    ['AbortError', 'AbortError'],
  ])('maps a %s thrown by fetch to RETRYABLE TIMEOUT', async (_label, name) => {
    const fetchImpl = (async () => { throw new DOMException('aborted by test', name); }) as unknown as typeof fetch;
    const err = await failureOf(client('https://erp.example.com/hook', { fetchImpl, timeoutMs: 1500 }).post(payload(), CTX));
    expect([err.kind, err.code]).toEqual(['RETRYABLE', 'TIMEOUT']);
    expect(err.message).toContain('1500ms');
  });

  it('maps connection refused to RETRYABLE NETWORK', async () => {
    const port = await closedPort();
    const err = await failureOf(client(`http://127.0.0.1:${port}/hook`, { token: TOKEN }).post(payload(), CTX));
    expect([err.kind, err.code]).toEqual(['RETRYABLE', 'NETWORK']);
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toMatch(/^ERP request failed: /);
  });

  it('maps a connection that is dropped mid-request to RETRYABLE NETWORK', async () => {
    const srv = await startServer((req) => { req.socket.destroy(); });
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code]).toEqual(['RETRYABLE', 'NETWORK']);
  });

  it('maps any other fetch failure to RETRYABLE NETWORK and truncates its message', async () => {
    const fetchImpl = (async () => { throw new TypeError('x'.repeat(2_000)); }) as unknown as typeof fetch;
    const err = await failureOf(client('https://erp.example.com/hook', { fetchImpl }).post(payload(), CTX));
    expect([err.kind, err.code]).toEqual(['RETRYABLE', 'NETWORK']);
    expect(err.message.length).toBeLessThanOrEqual('ERP request failed: '.length + 121);
    expect(err.message.endsWith('…')).toBe(true);
  });

  it('stays retryable and bounded in time when the body stalls after the response headers', async () => {
    const srv = await startServer((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.write('{"error":'); });
    const err = await failureOf(client(srv.url, { timeoutMs: 40 }).post(payload(), CTX));
    expect(err.kind).toBe('RETRYABLE');
    expect(['SERVER_ERROR', 'TIMEOUT']).toContain(err.code);
  });

  it('settles (success or retryable failure) when a 2xx body stalls after the response headers', async () => {
    const srv = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"reference":'); });
    let outcome: unknown;
    try { outcome = await client(srv.url, { timeoutMs: 40 }).post(payload(), CTX); } catch (e) { outcome = e; }
    if (outcome instanceof ErpPostError) expect(outcome.kind).toBe('RETRYABLE');
    else expect(outcome).toMatchObject({ duplicate: false });
  });
});

describe('RealErpClient response size cap', () => {
  it.each([
    [200, 'ok'], [500, 'SERVER_ERROR'], [400, 'REJECTED'],
  ])('stops reading an endless HTTP %i body and still classifies it', async (status, expected) => {
    const stream = endlessBody(status);
    const srv = await startServer(stream.handler);
    const pending = client(srv.url).post(payload(), CTX);
    if (expected === 'ok') {
      expect(await pending).toEqual({ externalRef: null, duplicate: false });
    } else {
      const err = await failureOf(pending);
      expect(err.code).toBe(expected);
      expect(err.httpStatus).toBe(status);
      expect(err.message.length).toBeLessThanOrEqual(`ERP responded ${status}: `.length + 301);
    }
    await stream.closed; // the client hung up instead of draining the stream
    expect(stream.state.endedByServer).toBe(false);
  });

  it('keeps the Idempotent-Replayed header semantics for a 2xx response with a huge body', async () => {
    const huge = JSON.stringify({ reference: 'GL-1', pad: 'x'.repeat(2 * 1024 * 1024) });
    const srv = await startServer(reply(200, huge, { 'content-type': 'application/json', 'Idempotent-Replayed': 'true' }));
    const res = await client(srv.url).post(payload(), CTX);
    expect(res.duplicate).toBe(true);
  });

  it('classifies a >1 MiB 5xx body as retryable with a short error message', async () => {
    const srv = await startServer(reply(502, 'e'.repeat(1_500_000), { 'content-type': 'text/plain' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect([err.kind, err.code, err.httpStatus]).toEqual(['RETRYABLE', 'SERVER_ERROR', 502]);
    expect(err.message.length).toBeLessThanOrEqual('ERP responded 502: '.length + 301);
  });
});

describe('RealErpClient error messages', () => {
  it('truncates the response detail to 300 characters and appends an ellipsis', async () => {
    const srv = await startServer(reply(400, 'a'.repeat(5_000), { 'content-type': 'text/plain' }));
    const err = await failureOf(client(srv.url).post(payload(), CTX));
    expect(err.message).toBe(`ERP responded 400: ${'a'.repeat(300)}…`);
  });

  it('does not add an ellipsis to a short response detail', async () => {
    const srv = await startServer(reply(422, 'bad amount', { 'content-type': 'text/plain' }));
    expect((await failureOf(client(srv.url).post(payload(), CTX))).message).toBe('ERP responded 422: bad amount');
  });

  it('collapses whitespace and line breaks in the response detail', async () => {
    const srv = await startServer(reply(400, '  line one\n\n\tline   two \r\n', { 'content-type': 'text/plain' }));
    expect((await failureOf(client(srv.url).post(payload(), CTX))).message).toBe('ERP responded 400: line one line two');
  });

  it('omits the detail separator when the response body is empty', async () => {
    const srv = await startServer(reply(404, '', {}));
    expect((await failureOf(client(srv.url).post(payload(), CTX))).message).toBe('ERP responded 404');
  });

  it.each([[400], [401], [403], [404], [409], [422], [429], [500], [503], [302]])(
    'does not contain the bearer token or webhook secret in the error message for HTTP %i',
    async (status) => {
      const srv = await startServer(json(status, { error: 'rejected', requestId: 'req-123' }));
      const err = await failureOf(client(srv.url, { token: TOKEN }).post(payload(), CTX));
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain(SECRET);
    },
  );

  it('does not contain the bearer token or webhook secret in timeout and network errors', async () => {
    const hang = await startServer(() => undefined);
    const timeout = await failureOf(client(hang.url, { token: TOKEN, timeoutMs: 30 }).post(payload(), CTX));
    const network = await failureOf(client(`http://127.0.0.1:${await closedPort()}`, { token: TOKEN }).post(payload(), CTX));
    for (const err of [timeout, network]) {
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('truncates a thrown fetch error that mentions the credentials and keeps secrets out of unrelated failures', async () => {
    // a failing fetch whose message is long: only the first 120 characters survive
    const fetchImpl = (async () => { throw new TypeError(`${'y'.repeat(130)} ${TOKEN} ${SECRET}`); }) as unknown as typeof fetch;
    const err = await failureOf(client('https://erp.example.com/hook', { fetchImpl, token: TOKEN }).post(payload(), CTX));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(SECRET);
  });
});

// The scenarios below describe behaviour the client should have but currently does not (see the reported source defects).
describe('RealErpClient credential hygiene (hardening)', () => {
  it('does not echo credentials the server reflects back in an error body', async () => {
    const srv = await startServer(json(401, { error: 'invalid bearer token', token: TOKEN, signingSecret: SECRET }));
    const err = await failureOf(client(srv.url, { token: TOKEN }).post(payload(), CTX));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(SECRET);
  });

  it('does not leak credentials embedded in the configured URL into errors', async () => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    let outcome: string;
    try {
      await client(`http://svc-user:pw-S3CRET-value@127.0.0.1:${srv.port}/journals`).post(payload(), CTX);
      outcome = 'ok';
    } catch (e) { outcome = (e as Error).message; }
    expect(outcome).not.toContain('pw-S3CRET-value');
  });
});

describe('RealErpClient oversized and unsendable values (hardening)', () => {
  it('still treats a replay-flagged 409 as a duplicate when its body exceeds the read cap', async () => {
    const srv = await startServer(json(409, { duplicate: true, reference: 'GL-42', detail: 'x'.repeat(100_000) }));
    expect(await client(srv.url).post(payload(), CTX)).toEqual({ externalRef: 'GL-42', duplicate: true });
  });

  const unsendable: Array<[string, { key?: string; corr?: string }]> = [
    ['a non-Latin-1 idempotency key', { key: 'DISBURSEMENT:гэрээ-1' }],
    ['an idempotency key with a line break', { key: 'DISBURSEMENT:a\r\nX-Evil: 1' }],
    ['a non-Latin-1 correlation id', { corr: 'хүсэлт-1' }],
    ['a correlation id with a line break', { corr: 'c\r\nX-Evil: 1' }],
  ];
  it.each(unsendable)('does not classify %s as retryable (it can never be sent as an HTTP header) and never injects headers', async (_label, v) => {
    const srv = await startServer(json(200, { reference: 'R-1' }));
    const p = payload(v.key ? { idempotencyKey: v.key } : {});
    let outcome: unknown;
    try { outcome = await client(srv.url).post(p, { correlationId: v.corr ?? 'corr-xyz', attemptNo: 1 }); } catch (e) { outcome = e; }
    expect(outcome).toBeInstanceOf(ErpPostError);
    expect([(outcome as ErpPostError).kind, (outcome as ErpPostError).code]).toEqual(['PERMANENT', 'INVALID_REQUEST']);
    expect(srv.requests).toHaveLength(0);
    for (const r of srv.requests) expect(r.headers['x-evil']).toBeUndefined();
  });
});
