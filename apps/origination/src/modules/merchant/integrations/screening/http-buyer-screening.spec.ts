import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapturingLogger } from '../../testing/capturing-logger';
import { DomainError } from '../../domain/errors';
import { HttpBuyerScreening, SCREENING_TIMEOUT_MS } from './http-buyer-screening';
import { mockScreeningFor } from './mock-buyer-screening';

const req = { leaseId: 'lease-1', registerNo: 'УЕ90051500', phone: '99112212', consentVerifiedAt: '2026-10-28T04:00:00.000Z' };
const good = mockScreeningFor(req.registerNo, new Date('2026-10-28T04:00:00.000Z'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function expectUnavailable(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe('SCREENING_UNAVAILABLE');
  expect((err as DomainError).status).toBe(503);
  expect(JSON.stringify(err) + (err as Error).message).not.toMatch(/УЕ90051500|99112212/); // алдаанд PII орохгүй
}

describe('HttpBuyerScreening', () => {
  it('POSTs to KYC_BASE_URL/api/inquiry/pos-screening with the correlation id and parses the response', async () => {
    const fetchImpl = vi.fn(async () => json(good));
    const s = new HttpBuyerScreening({ baseUrl: 'http://kyc.local:4002/', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(s.screen(req, 'corr-42')).resolves.toEqual(good);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // retry үгүй
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://kyc.local:4002/api/inquiry/pos-screening');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-correlation-id']).toBe('corr-42');
    expect(JSON.parse(init.body as string)).toEqual(req);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('maps 5xx, 4xx and network errors to SCREENING_UNAVAILABLE without retrying', async () => {
    for (const status of [500, 502, 503, 400, 404]) {
      const fetchImpl = vi.fn(async () => json({ message: 'УЕ90051500 99112212' }, status));
      await expectUnavailable(new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: fetchImpl as unknown as typeof fetch }).screen(req, 'c'));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const down = vi.fn(async () => { throw new TypeError('fetch failed: ECONNREFUSED УЕ90051500'); });
    await expectUnavailable(new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: down as unknown as typeof fetch }).screen(req, 'c'));
  });
  it('maps schema-invalid or non-JSON bodies to SCREENING_UNAVAILABLE', async () => {
    await expectUnavailable(new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: (async () => json({ identity: {} })) as unknown as typeof fetch }).screen(req, 'c'));
    await expectUnavailable(new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch }).screen(req, 'c'));
  });
  it('aborts after the timeout (15 s by default)', async () => {
    expect(SCREENING_TIMEOUT_MS).toBe(15_000);
    const hang = (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    await expectUnavailable(new HttpBuyerScreening({ baseUrl: 'http://k', timeoutMs: 40, fetchImpl: hang }).screen(req, 'c'));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  describe('tenant context, redirects and diagnostics', () => {
    afterEach(() => Logger.overrideLogger(false));
    const headersOf = (fetchImpl: ReturnType<typeof vi.fn>) => (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;

    it('sends x-org-id and x-correlation-id (and nothing personal) when a tenant context is given', async () => {
      const fetchImpl = vi.fn(async () => json(good));
      await new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: fetchImpl as unknown as typeof fetch }).screen(req, 'corr-7', { orgId: 'org-77' });
      const headers = headersOf(fetchImpl);
      expect(headers['x-org-id']).toBe('org-77');
      expect(headers['x-correlation-id']).toBe('corr-7');
      expect(Object.keys(headers).sort()).toEqual(['accept', 'content-type', 'x-correlation-id', 'x-org-id']); // x-roles / x-user-id / PII-гүй
      expect(JSON.stringify(headers)).not.toMatch(/УЕ90051500|99112212/);
    });

    it('stays backward compatible: no context, no x-org-id', async () => {
      const fetchImpl = vi.fn(async () => json(good));
      await new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: fetchImpl as unknown as typeof fetch }).screen(req, 'corr-7');
      expect(headersOf(fetchImpl)['x-org-id']).toBeUndefined();
    });

    it("never follows redirects: fetch is called with redirect: 'error'", async () => {
      const fetchImpl = vi.fn(async () => json(good));
      await new HttpBuyerScreening({ baseUrl: 'http://k', fetchImpl: fetchImpl as unknown as typeof fetch }).screen(req, 'c');
      expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');
    });

    describe('against real HTTP servers', () => {
      const servers: Server[] = [];
      afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); }))); });
      const listen = (handler: Parameters<typeof createServer>[1]) => new Promise<{ server: Server; base: string }>((resolve) => {
        const server = createServer(handler!);
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
      });

      it('a 307/308 from the kyc URL is NOT replayed to the Location target (registerNo/phone body stays put)', async () => {
        for (const code of [307, 308]) {
          const received: string[] = [];
          const target = await listen((r, res) => { r.on('data', (c: Buffer) => received.push(c.toString())); r.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(good)); }); });
          const front = await listen((_r, res) => { res.statusCode = code; res.setHeader('location', `${target.base}/api/inquiry/pos-screening`); res.end(); });
          const logger = new CapturingLogger();
          Logger.overrideLogger(logger);
          await expectUnavailable(new HttpBuyerScreening({ baseUrl: front.base }).screen(req, 'corr-redir', { orgId: 'org-1' }));
          expect(received, `HTTP ${code}`).toEqual([]);
          expect(logger.text).toContain('[corr-redir] pos-screening failed: redirect');
        }
      });

      it('sends the tenant header over the wire and parses a good response end to end', async () => {
        let seen: Record<string, unknown> = {};
        const kyc = await listen((r, res) => { seen = { ...r.headers }; r.resume(); r.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(good)); }); });
        await expect(new HttpBuyerScreening({ baseUrl: kyc.base }).screen(req, 'corr-wire', { orgId: 'org-wire' })).resolves.toEqual(good);
        expect(seen).toMatchObject({ 'x-org-id': 'org-wire', 'x-correlation-id': 'corr-wire', 'content-type': 'application/json' });
      });
    });

    it('logs the failure class at warn level (timeout / network / http status / invalid body), never the body, URL or PII', async () => {
      const logger = new CapturingLogger();
      Logger.overrideLogger(logger);
      const run = (fetchImpl: unknown, timeoutMs?: number) => new HttpBuyerScreening({ baseUrl: 'http://secret-kyc-host:4002', timeoutMs, fetchImpl: fetchImpl as typeof fetch }).screen(req, 'corr-log');
      await expectUnavailable(run(async () => json({ message: 'УЕ90051500 99112212' }, 503)));
      await expectUnavailable(run(async () => { throw Object.assign(new TypeError('fetch failed УЕ90051500'), { cause: { code: 'ECONNREFUSED', message: 'connect 99112212' } }); }));
      await expectUnavailable(run(async () => { throw new TypeError('fetch failed'); }));
      await expectUnavailable(run(async () => new Response('<html>УЕ90051500', { status: 200 })));
      await expectUnavailable(run(async () => json({ identity: {} })));
      await expectUnavailable(run((async (_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))); })) as unknown, 30));
      const lines = logger.lines;
      expect(lines.every((l) => l.startsWith('warn '))).toBe(true);
      expect(lines.map((l) => l.replace(/^warn \[corr-log\] pos-screening failed: /, '').replace(/ HttpBuyerScreening$/, ''))).toEqual(['http_503', 'network:ECONNREFUSED', 'network', 'invalid_json', 'invalid_schema', 'timeout']);
      expect(logger.text).not.toMatch(/УЕ90051500|99112212|secret-kyc-host|html/);
    });
  });
});
