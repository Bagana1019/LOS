import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string; raw: Buffer }

describe.skipIf(!HAS_DB)('gateway proxy (web → gateway → service)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let upstream: Server;
  let seen: Seen[] = [];
  const api = () => request(app.getHttpServer());
  const tokens = new Map<string, string>();
  const bearer = (u: string) => ({ authorization: `Bearer ${tokens.get(u)}` });

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw.toString(), raw });
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-powered-by', 'upstream');
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    for (const s of ['ORIGINATION', 'KYC', 'SCORING', 'VALUATION', 'DMS']) process.env[`${s}_URL`] = `http://127.0.0.1:${port}`;
    ({ app, prisma } = await createGateway());
    for (const u of Object.values(SEED.users)) {
      const r = await request(app.getHttpServer()).post('/api/auth/login').send({ username: u.username, password: PASSWORD });
      tokens.set(u.username, r.body.accessToken);
    }
  });
  afterAll(async () => { await app.close(); await new Promise((r) => upstream.close(r)); });
  beforeEach(() => { seen = []; });

  it('401 without a token; nothing reaches the service', async () => {
    const res = await api().get('/api/origination/applications');
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('rewrites /api/<service>/x to <service>/api/x and keeps the query string', async () => {
    const res = await api().get('/api/origination/applications?status=DRAFT&page=2').set(bearer('officer.a'));
    expect(res.status).toBe(200);
    expect(seen[0]!.url).toBe('/api/applications?status=DRAFT&page=2');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('injects only gateway-verified identity headers', async () => {
    await api().get('/api/kyc/inquiries').set(bearer('officer.a'));
    const h = seen[0]!.headers;
    expect(h['x-user-id']).toBe(SEED.users.officerA.id);
    expect(h['x-roles']).toBe('OFFICER');
    expect(h['x-branch-id']).toBe(SEED.branches.head.id);
    expect(h['x-org-id']).toBe(SEED.org.id);
    expect(h['x-correlation-id']).toBeTruthy();
    expect(h['x-internal-token']).toBe(process.env.INTERNAL_AUTH_SECRET);
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
  });

  it('spoofed identity headers from the client never reach the service', async () => {
    await api().get('/api/origination/applications').set(bearer('officer.a')).set({
      'x-user-id': 'attacker', 'x-roles': 'ADMIN', 'x-branch-id': 'other-branch', 'x-org-id': 'other-org', 'x-customer-id': 'victim', 'x-internal-token': 'guess',
      cookie: 'los_rt=stolen',
    });
    const h = seen[0]!.headers;
    expect(h['x-user-id']).toBe(SEED.users.officerA.id);
    expect(h['x-roles']).toBe('OFFICER');
    expect(h['x-branch-id']).toBe(SEED.branches.head.id);
    expect(h['x-org-id']).toBe(SEED.org.id);
    expect(h['x-customer-id']).toBeUndefined();
    expect(h['x-internal-token']).toBe(process.env.INTERNAL_AUTH_SECRET);
    expect(h.cookie).toBeUndefined();
  });

  it('spoofed headers without a valid token are still a 401 (headers are not trusted at the edge)', async () => {
    const res = await api().get('/api/origination/applications').set({ 'x-user-id': SEED.users.admin.id, 'x-roles': 'ADMIN', 'x-org-id': SEED.org.id });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('forwards request bodies of mutating calls untouched', async () => {
    const res = await api().post('/api/origination/applications').set(bearer('officer.a')).send({ amount: 5_000_000, purpose: 'ХЭРЭГЛЭЭНИЙ' });
    expect(res.status).toBe(200);
    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body)).toEqual({ amount: 5_000_000, purpose: 'ХЭРЭГЛЭЭНИЙ' });
  });

  it('streams binary / multipart uploads through byte-for-byte (no body parser in the way)', async () => {
    const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 31) % 256));
    const res = await api().post('/api/dms/files').set(bearer('officer.a')).attach('file', bytes, { filename: 'scan.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(seen[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]!.raw.includes(bytes)).toBe(true);
  });

  it('route policy: the ERP sync API (reads and writes) is ADMIN only', async () => {
    const path = '/api/origination/erp-sync/events';
    for (const u of ['officer.a', 'manager', 'approver']) {
      expect((await api().get(path).set(bearer(u))).status, `GET ${u}`).toBe(403);
      expect((await api().post(`${path}/dispatch`).set(bearer(u)).send({})).status, `POST ${u}`).toBe(403);
    }
    expect(seen).toHaveLength(0);
    expect((await api().get(path).set(bearer('admin'))).status).toBe(200);
  });

  it('route policy: settings/blacklist writes need the permission; reads stay open', async () => {
    const put = (u: string, path: string) => api().put(path).set(bearer(u)).send({ value: 1 });
    expect((await put('officer.a', '/api/origination/settings/x')).status).toBe(403);
    expect((await put('approver', '/api/origination/settings/x')).status).toBe(403);
    expect(seen).toHaveLength(0);
    expect((await put('admin', '/api/origination/settings/x')).status).toBe(200);
    expect((await api().get('/api/origination/settings/x').set(bearer('officer.a'))).status).toBe(200);
    expect((await api().post('/api/origination/blacklist').set(bearer('officer.a')).send({})).status).toBe(403);
  });

  it('unknown service prefixes are 404 and never proxied', async () => {
    const res = await api().get('/api/secret-service/x').set(bearer('admin'));
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('audits every mutating request (who/what/status) but never the body', async () => {
    await prisma.auditLog.deleteMany({ where: { entity: 'HTTP' } });
    await api().post('/api/origination/applications/00000000-0000-4000-8000-0000000000aa/submit').set(bearer('officer.a')).send({ secret: 'do-not-log-me' });
    await api().get('/api/origination/applications').set(bearer('officer.a'));
    await new Promise((r) => setTimeout(r, 200)); // finish event → recordSafe
    const rows = await prisma.auditLog.findMany({ where: { entity: 'HTTP' } });
    expect(rows).toHaveLength(1); // GET бүртгэгдэхгүй
    expect(rows[0]).toMatchObject({ action: 'HTTP_POST', actorId: SEED.users.officerA.id, orgId: SEED.org.id });
    expect(rows[0]!.entityId).toBe('POST /api/origination/applications/:id/submit');
    expect(JSON.stringify(rows)).not.toContain('do-not-log-me');
  });

  it('502 JSON error (with correlation id) when the service is down', async () => {
    const saved = process.env.SCORING_URL;
    // Шинэ gateway instance: proxy handler-ууд target-ийг эхний дуудлагад cache хийдэг
    process.env.SCORING_URL = 'http://127.0.0.1:1';
    const other = await createGateway();
    try {
      const login = await request(other.app.getHttpServer()).post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
      const res = await request(other.app.getHttpServer()).get('/api/scoring/anything').set('authorization', `Bearer ${login.body.accessToken}`).set('x-correlation-id', 'corr-502');
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'UPSTREAM_ERROR', correlationId: 'corr-502' });
    } finally { process.env.SCORING_URL = saved; await other.app.close(); }
  });
});
