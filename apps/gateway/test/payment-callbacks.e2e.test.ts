// H9 — QPay/SocialPay callbacks reach origination through the gateway without a staff JWT; nothing else opens.
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, createGateway } from './app';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }

describe.skipIf(!HAS_DB)('payment provider callbacks through the gateway (H9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let upstream: Server;
  let seen: Seen[] = [];
  const savedUrl = process.env.ORIGINATION_URL;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('set-cookie', 'leak=1');
        res.end('SUCCESS');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    process.env.ORIGINATION_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    process.env.RATE_LIMIT_KEY_PREFIX = `test:${randomUUID()}:`;
    ({ app, prisma } = await createGateway());
  });
  afterAll(async () => {
    await app.close();
    await new Promise((r) => upstream.close(r));
    process.env.ORIGINATION_URL = savedUrl;
  });
  beforeEach(async () => { seen = []; await prisma.auditLog.deleteMany({ where: { entity: 'PAYMENT_CALLBACK' } }); });

  it('QPay GET callback without JWT is forwarded to origination with its query string', async () => {
    const res = await api().get('/api/origination/payments/callbacks/qpay?invoice=INV-123');
    expect(res.status).toBe(200);
    expect(res.text).toBe('SUCCESS');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/payments/callbacks/qpay?invoice=INV-123' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('QPay and SocialPay POST callbacks forward the body byte-for-byte', async () => {
    const q = await api().post('/api/origination/payments/callbacks/qpay').set('content-type', 'application/json').send('{"sender_invoice_no":"INV-1"}');
    const s = await api().post('/api/origination/payments/callbacks/socialpay?invoice=INV-2').type('form').send('invoice=INV-2');
    expect([q.status, s.status]).toEqual([200, 200]);
    expect(seen.map((x) => [x.method, x.url, x.body])).toEqual([
      ['POST', '/api/payments/callbacks/qpay', '{"sender_invoice_no":"INV-1"}'],
      ['POST', '/api/payments/callbacks/socialpay?invoice=INV-2', 'invoice=INV-2'],
    ]);
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });

  it('never forwards credentials or identity headers, even when the caller sends them', async () => {
    await api().get('/api/origination/payments/callbacks/qpay?invoice=X')
      .set('authorization', 'Bearer forged').set('cookie', 'los_rt=abc')
      .set('x-user-id', 'u-evil').set('x-roles', 'ADMIN').set('x-branch-id', 'b').set('x-org-id', 'o').set('x-internal-token', 'guess');
    const h = seen[0]!.headers;
    for (const name of ['authorization', 'cookie', 'x-user-id', 'x-roles', 'x-branch-id', 'x-org-id', 'x-internal-token', 'x-customer-id']) expect(h[name]).toBeUndefined();
    expect(h['x-correlation-id']).toBeTruthy();
  });

  it.each([
    ['GET', '/api/origination/payments/callbacks/socialpay'],
    ['PUT', '/api/origination/payments/callbacks/qpay'],
    ['DELETE', '/api/origination/payments/callbacks/qpay'],
    ['GET', '/api/origination/payments/callbacks/qpay/extra'],
    ['POST', '/api/origination/payments/callbacks/other'],
    ['GET', '/api/origination/payments/callbacks'],
    ['GET', '/api/origination/payments/invoices'],
    ['POST', '/api/origination/payments/dev/simulate'],
    ['GET', '/api/kyc/payments/callbacks/qpay'],
  ])('%s %s still needs a staff JWT (401) and is not proxied', async (method, path) => {
    const res = await (api() as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()]!(path);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('origination down → 502 so the provider retries later', async () => {
    const saved = process.env.ORIGINATION_URL;
    process.env.ORIGINATION_URL = 'http://127.0.0.1:1';
    const other = await createGateway();
    try {
      expect((await request(other.app.getHttpServer()).get('/api/origination/payments/callbacks/qpay?invoice=X')).status).toBe(502);
    } finally { process.env.ORIGINATION_URL = saved; await other.app.close(); }
  });

  it('rejects oversized bodies with 413 without contacting origination', async () => {
    const res = await api().post('/api/origination/payments/callbacks/qpay').set('content-type', 'application/json').send(JSON.stringify({ pad: 'x'.repeat(64 * 1024) }));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('audits every callback (GET and POST) without the query or body', async () => {
    const corr = [`audit-${randomUUID()}`, `audit-${randomUUID()}`];
    await api().get('/api/origination/payments/callbacks/qpay?invoice=SECRET-INV').set('x-correlation-id', corr[0]!);
    await api().post('/api/origination/payments/callbacks/socialpay').set('x-correlation-id', corr[1]!).send({ invoice: 'SECRET-INV-2' });
    await new Promise((r) => setTimeout(r, 200));
    const rows = await prisma.auditLog.findMany({ where: { entity: 'PAYMENT_CALLBACK', correlationId: { in: corr } }, orderBy: { at: 'asc' } });
    expect(rows.map((r) => [r.entityId, r.action, r.actorId])).toEqual([
      ['QPAY', 'PAYMENT_CALLBACK_GET', null],
      ['SOCIALPAY', 'PAYMENT_CALLBACK_POST', null],
    ]);
    expect(rows[0]!.afterJson).toMatchObject({ status: 200 });
    expect(JSON.stringify(rows)).not.toContain('SECRET-INV');
  });

  describe('rate limit: shared bucket per provider across pods + per-IP abuse ceiling', () => {
    const keys = ['PAYMENT_CALLBACK_RATE_LIMIT', 'PAYMENT_CALLBACK_IP_RATE_LIMIT', 'TRUST_PROXY', 'PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT', 'PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT',
      'PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY', 'PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY'] as const;
    /** Documentation ranges act as the providers' published source ranges; 100.64.0.0/10 is "anyone else". */
    const TRUSTED = '203.0.113.0/24, 198.51.100.0/24, 192.0.2.0/24, 2001:db8::/32';
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const extra: INestApplication[] = [];
    afterEach(async () => {
      await Promise.all(extra.splice(0).map((a) => a.close()));
      for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
    /** Two pods behind one trusted proxy, so X-Forwarded-For is the client IP. */
    async function pods(provider: number, perIp: number, env: Partial<Record<(typeof keys)[number], string | undefined>> = {}) {
      process.env.PAYMENT_CALLBACK_RATE_LIMIT = String(provider);
      process.env.PAYMENT_CALLBACK_IP_RATE_LIMIT = String(perIp);
      process.env.TRUST_PROXY = '1';
      process.env.PAYMENT_CALLBACK_TRUSTED_CIDRS_QPAY = TRUSTED;
      process.env.PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY = TRUSTED;
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      process.env.RATE_LIMIT_KEY_PREFIX = `test:${randomUUID()}:`;
      const a = (await createGateway()).app; extra.push(a);
      const b = (await createGateway()).app; extra.push(b);
      return [a, b] as const;
    }
    const qpayGet = (p: INestApplication, ip: string) => request(p.getHttpServer()).get('/api/origination/payments/callbacks/qpay?invoice=X').set('x-forwarded-for', ip);
    const qpayPost = (p: INestApplication, ip: string) => request(p.getHttpServer()).post('/api/origination/payments/callbacks/qpay').set('x-forwarded-for', ip).set('content-type', 'application/json').send('{}');
    const social = (p: INestApplication, ip: string) => request(p.getHttpServer()).post('/api/origination/payments/callbacks/socialpay').set('x-forwarded-for', ip).set('content-type', 'application/json').send('{}');

    it('PAYMENT_CALLBACK_RATE_LIMIT is one bucket per provider across pods and IPs (QPay GET+POST share it); other provider unaffected', async () => {
      const [a, b] = await pods(3, 100);
      const statuses = [
        (await qpayGet(a, '203.0.113.1')).status, (await qpayPost(b, '203.0.113.2')).status,
        (await qpayGet(a, '203.0.113.3')).status, (await qpayPost(b, '203.0.113.4')).status,
      ];
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect((await social(a, '203.0.113.4')).status).toBe(200);
      expect(seen).toHaveLength(4);
    });

    it('a single provider IP is NOT limited by a small per-client rule: it may use the whole provider bucket when the IP ceiling allows', async () => {
      const [a, b] = await pods(5, 5);
      const statuses = [];
      for (const p of [a, b, a, b, a, b]) statuses.push((await qpayGet(p, '198.51.100.7')).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    });

    it('per-IP ceiling (PAYMENT_CALLBACK_IP_RATE_LIMIT) stops one abusive IP without draining the provider bucket', async () => {
      const [a, b] = await pods(3, 1);
      const abuser = [];
      for (const p of [a, b, a, b, a]) abuser.push((await qpayGet(p, '192.0.2.66')).status);
      expect(abuser).toEqual([200, 429, 429, 429, 429]);
      const res = await qpayGet(b, '192.0.2.67');
      expect(res.status).toBe(200);
      expect((await qpayGet(a, '192.0.2.68')).status).toBe(200);
      expect((await qpayGet(a, '192.0.2.69')).status).toBe(429);
      expect(seen).toHaveLength(3);
    });

    it('429 carries Retry-After and a RATE_LIMITED code; rejected calls are not forwarded', async () => {
      const [a] = await pods(1, 100);
      await qpayGet(a, '203.0.113.9').expect(200);
      const res = await qpayGet(a, '203.0.113.10');
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(seen).toHaveLength(1);
    });

    it('a flood from many untrusted IPs (each under its own limit) never drains the trusted provider bucket', async () => {
      const [a, b] = await pods(3, 100, { PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '1000', PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT: '1000' });
      const flood = await Promise.all(Array.from({ length: 20 }, (_, i) => qpayGet(i % 2 ? a : b, `100.64.0.${i + 1}`))).then((rs) => rs.map((r) => r.status));
      expect(flood.every((s) => s === 200)).toBe(true);
      const real = [(await qpayGet(a, '203.0.113.1')).status, (await qpayPost(b, '203.0.113.2')).status, (await qpayGet(a, '203.0.113.3')).status, (await qpayGet(b, '203.0.113.4')).status];
      expect(real).toEqual([200, 200, 200, 429]); // the whole bucket (3) is still there for the real provider
    });

    it('untrusted traffic shares its own small bucket: once it is exhausted, untrusted callers get 429 but trusted callbacks still pass', async () => {
      const [a, b] = await pods(1000, 1000, { PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '1000', PAYMENT_CALLBACK_UNTRUSTED_RATE_LIMIT: '5' });
      const flood = [];
      for (let i = 0; i < 8; i++) flood.push((await qpayGet(i % 2 ? a : b, `100.64.1.${i + 1}`)).status);
      expect(flood).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
      expect((await qpayGet(a, '203.0.113.20')).status).toBe(200);
      expect((await social(b, '198.51.100.20')).status).toBe(200);
    });

    it('untrusted per-IP limit (PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT) is small and shared across pods; trusted IPs are not bound by it', async () => {
      const [a, b] = await pods(1000, 1000, { PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '2' });
      const one = [];
      for (const p of [a, b, a]) one.push(await qpayGet(p, '100.64.2.1'));
      expect(one.map((r) => r.status)).toEqual([200, 200, 429]);
      expect(Number(one[2]!.headers['retry-after'])).toBeGreaterThan(0);
      expect(one[2]!.body.code).toBe('RATE_LIMITED');
      expect((await qpayGet(b, '100.64.2.2')).status).toBe(200);
      const trusted = [];
      for (let i = 0; i < 5; i++) trusted.push((await qpayGet(i % 2 ? a : b, '203.0.113.30')).status);
      expect(trusted).toEqual([200, 200, 200, 200, 200]);
    });

    it('IPv6 trusted range: a provider calling from 2001:db8::/32 uses the provider bucket', async () => {
      const [a] = await pods(1000, 1000, { PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '1' });
      const s = [];
      for (let i = 0; i < 3; i++) s.push((await qpayGet(a, '2001:db8::10')).status);
      expect(s).toEqual([200, 200, 200]);
    });

    it('without TRUST_PROXY a spoofed X-Forwarded-For from a trusted range does not grant trusted status', async () => {
      const [a] = await pods(1000, 1000, { PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '2', TRUST_PROXY: undefined });
      const s = [];
      for (let i = 0; i < 3; i++) s.push((await qpayGet(a, '203.0.113.5')).status);
      expect(s).toEqual([200, 200, 429]);
    });

    it('with TRUST_PROXY=1 a trusted address prepended by the client to X-Forwarded-For does not grant trusted status', async () => {
      const [a] = await pods(1000, 1000, { PAYMENT_CALLBACK_UNTRUSTED_IP_RATE_LIMIT: '2' });
      const s = [];
      for (let i = 0; i < 3; i++) s.push((await qpayGet(a, '203.0.113.5, 100.64.3.3')).status);
      expect(s).toEqual([200, 200, 429]);
    });

    it('a malformed trusted CIDR fails gateway startup', async () => {
      process.env.PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY = '203.0.113.0/24,10.0.0.0/33';
      await expect(createGateway()).rejects.toThrow(/PAYMENT_CALLBACK_TRUSTED_CIDRS_SOCIALPAY/);
    });
  });
});
