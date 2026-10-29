import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InternalHttpClient, serviceUrl, UpstreamError } from './internal-http';
import { SettingsClient } from './settings-client';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(handler: (url: string, method: string, headers: IncomingHttpHeaders, body: string, hit: number) => { status: number; body?: unknown; delayMs?: number }) {
  let hits = 0;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = handler(req.url ?? '', req.method ?? '', req.headers, body, ++hits);
      setTimeout(() => { res.statusCode = r.status; res.setHeader('content-type', 'application/json'); res.end(r.body === undefined ? '' : JSON.stringify(r.body)); }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits: () => hits, env: { KYC_URL: url, ORIGINATION_URL: url } as NodeJS.ProcessEnv };
}
const ctx = { userId: 'u1', roles: ['OFFICER', 'ADMIN'], branchId: 'b1', orgId: 'o1', customerId: null, correlationId: 'corr-1' };

describe('InternalHttpClient', () => {
  it('forwards the trusted context headers and parses with a schema', async () => {
    let seen: IncomingHttpHeaders = {};
    const s = await start((_u, _m, h) => { seen = h; return { status: 200, body: { ok: true } }; });
    const http = new InternalHttpClient({ env: s.env });
    await expect(http.get('kyc', '/api/x', { ctx, schema: z.object({ ok: z.boolean() }) })).resolves.toEqual({ ok: true });
    expect(seen).toMatchObject({ 'x-user-id': 'u1', 'x-roles': 'OFFICER,ADMIN', 'x-branch-id': 'b1', 'x-org-id': 'o1', 'x-correlation-id': 'corr-1' });
  });
  it('adds the internal token when INTERNAL_AUTH_SECRET is configured', async () => {
    let seen: IncomingHttpHeaders = {};
    const s = await start((_u, _m, h) => { seen = h; return { status: 200, body: {} }; });
    await new InternalHttpClient({ env: { ...s.env, INTERNAL_AUTH_SECRET: 's3cret' } }).get('kyc', '/x', { ctx });
    expect(seen['x-internal-token']).toBe('s3cret');
  });
  it('retries an idempotent GET once on 5xx but never a POST', async () => {
    const s = await start((_u, _m, _h, _b, hit) => (hit === 1 ? { status: 503 } : { status: 200, body: { n: hit } }));
    const http = new InternalHttpClient({ env: s.env, sleep: async () => {} });
    await expect(http.get('kyc', '/x', { ctx })).resolves.toEqual({ n: 2 });
    expect(s.hits()).toBe(2);
    const p = await start(() => ({ status: 500 }));
    await expect(new InternalHttpClient({ env: p.env, sleep: async () => {} }).post('kyc', '/x', { a: 1 }, { ctx })).rejects.toBeInstanceOf(UpstreamError);
    expect(p.hits()).toBe(1);
  });
  it('times out with 504 and passes 4xx bodies through unchanged', async () => {
    const slow = await start(() => ({ status: 200, body: {}, delayMs: 200 }));
    await expect(new InternalHttpClient({ env: slow.env, sleep: async () => {} }).post('kyc', '/x', {}, { ctx, timeoutMs: 30 })).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', status: 504 });
    const bad = await start(() => ({ status: 422, body: { code: 'REGISTER_INVALID', message: 'Регистр буруу' } }));
    await expect(new InternalHttpClient({ env: bad.env }).get('kyc', '/x', { ctx })).rejects.toMatchObject({ code: 'REGISTER_INVALID', status: 422 });
  });
  it('resolves service urls from env with localhost defaults', () => {
    expect(serviceUrl('kyc', {})).toBe('http://localhost:4002');
    expect(serviceUrl('scoring', { SCORING_URL: 'http://scoring:4003/' })).toBe('http://scoring:4003');
  });
});

describe('SettingsClient', () => {
  it('caches for 60s, validates against the registry, and can be invalidated', async () => {
    const s = await start((url) => ({ status: 200, body: { key: decodeURIComponent(url.split('/').pop()!), value: 0.55 } }));
    let t = 1_000;
    const c = new SettingsClient(new InternalHttpClient({ env: s.env }), () => t);
    expect(await c.get('br1.dti_max', 'o1')).toBe(0.55);
    expect(await c.get('br1.dti_max', 'o1')).toBe(0.55);
    expect(s.hits()).toBe(1);
    t += 61_000;
    await c.get('br1.dti_max', 'o1');
    expect(s.hits()).toBe(2);
    c.invalidate('br1.dti_max');
    await c.get('br1.dti_max', 'o1');
    expect(s.hits()).toBe(3);
  });
  it('rejects an invalid stored value', async () => {
    const s = await start(() => ({ status: 200, body: { key: 'br1.dti_max', value: 9 } }));
    await expect(new SettingsClient(new InternalHttpClient({ env: s.env })).get('br1.dti_max', 'o1')).rejects.toThrow();
  });
});
