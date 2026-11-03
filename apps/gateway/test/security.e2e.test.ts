import { type INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB, PASSWORD, createGateway } from './app';

// M14 · OWASP Top-10 суурь шалгалт (A01 хандалт, A02 крипто, A03 injection, A05 тохиргоо, A07 нэвтрэлт) — gateway-н ирмэгт.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe.skipIf(!HAS_DB)('gateway security baseline (OWASP)', () => {
  let app: INestApplication;
  let upstream: Server;
  let hits = 0;
  const api = () => request(app.getHttpServer());
  let token = '';

  beforeAll(async () => {
    upstream = createServer((_req, res) => { hits++; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    for (const s of ['ORIGINATION', 'KYC', 'SCORING', 'VALUATION', 'DMS']) process.env[`${s}_URL`] = `http://127.0.0.1:${port}`;
    ({ app } = await createGateway());
    token = (await api().post('/api/auth/login').send({ username: 'officer.a', password: PASSWORD })).body.accessToken;
  });
  afterAll(async () => { await app.close(); await new Promise((r) => upstream.close(r)); });

  it('A05: security headers; no X-Powered-By', async () => {
    const res = await api().get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('A05: CORS answers only the configured web origin', async () => {
    const bad = await api().options('/api/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('A07: forged / tampered / unsigned JWTs never reach a service', async () => {
    hits = 0;
    const [h, p] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, roles: ['ADMIN'] })}.`;
    const tampered = `${h}.${b64({ ...payload, roles: ['ADMIN'] })}.${token.split('.')[2]}`;
    const sig = (k: string) => createHmac('sha256', k).update(`${h}.${b64({ ...payload, roles: ['ADMIN'] })}`).digest('base64url');
    const wrongKey = `${h}.${b64({ ...payload, roles: ['ADMIN'] })}.${sig('guess-secret')}`;
    const expired = `${h}.${b64({ ...payload, exp: 1 })}.${token.split('.')[2]}`;
    for (const t of [none, tampered, wrongKey, expired, 'garbage', '']) {
      const res = await api().get('/api/origination/applications').set('authorization', `Bearer ${t}`);
      expect(res.status, t.slice(0, 20)).toBe(401);
    }
    expect(hits).toBe(0);
  });

  it('A01: OFFICER cannot escalate by spoofing role headers or hitting admin routes', async () => {
    const spoof = await api().put('/api/origination/settings/x').set('authorization', `Bearer ${token}`).set('x-roles', 'ADMIN').set('x-user-id', 'admin');
    expect(spoof.status).toBe(403);
    const audit = await api().get('/api/origination/audit-logs').set('authorization', `Bearer ${token}`);
    expect(audit.status).toBe(403);
    const adm = await api().get('/api/admin/users').set('authorization', `Bearer ${token}`);
    expect([403, 404]).toContain(adm.status);
  });

  it('A01/A03: traversal and ambiguous paths never reach a service', async () => {
    hits = 0;
    for (const p of ['/api/origination/../kyc/x', '/api/origination/%2e%2e/admin', '/api/origination/a%5cb', '/api/dms/esign/x', '/api/scoring/underwrite%2fx']) {
      const res = await api().get(p).set('authorization', `Bearer ${token}`);
      expect([400, 404], p).toContain(res.status);
    }
    expect(hits).toBe(0);
  });

  it('A03: injection-shaped login payloads fail closed (400/401), never 500', async () => {
    for (const body of [{ username: "admin' OR '1'='1", password: 'x' }, { username: { $ne: null }, password: { $ne: null } }, { username: 'admin', password: ['a'] }]) {
      const res = await api().post('/api/auth/login').send(body);
      expect([400, 401, 429]).toContain(res.status);
    }
  });

  it('A04/DoS: oversized auth body is rejected (413) and errors carry no stack trace', async () => {
    const big = await api().post('/api/auth/login').send({ username: 'a'.repeat(20_000), password: 'x' });
    expect(big.status).toBe(413);
    expect(JSON.stringify(big.body)).not.toMatch(/\bat \S+ \(|node_modules/);
  });
});
