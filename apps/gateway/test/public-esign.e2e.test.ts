import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HAS_DB, PASSWORD, createGateway } from './app';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders }

const TOKEN = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');

// FR-11.4: бодит gateway AppModule (глобал JWT guard + throttler) дээр public e-sign JWT-гүй, ажилтны proxy-д dms-ийн дотоод замууд хаалттай
describe.skipIf(!HAS_DB)('gateway public e-sign (FR-11.4)', () => {
  let app: INestApplication;
  let upstream: Server;
  let seen: Seen[] = [];
  let officer = '';
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers });
      req.resume();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const port = (upstream.address() as AddressInfo).port;
    for (const s of ['ORIGINATION', 'DMS']) process.env[`${s}_URL`] = `http://127.0.0.1:${port}`;
    ({ app } = await createGateway());
    const login = await api().post('/api/auth/login').send({ username: SEED.users.officerA.username, password: PASSWORD });
    officer = login.body.accessToken;
  });
  afterAll(async () => { await app.close(); await new Promise((r) => upstream.close(r)); });
  beforeEach(() => { seen = []; });

  it('зээлдэгч JWT-гүйгээр линкээ нээнэ: dms-ийн /api/public/esign/:token руу, cache-гүй, итгэмжлэгдсэн толгойгүй', async () => {
    const res = await api().get(`/api/public/esign/${TOKEN}`).set({ 'x-user-id': 'attacker', 'x-roles': 'ADMIN', 'x-org-id': 'other', authorization: 'Bearer junk', cookie: 'los_rt=x' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: `/api/public/esign/${TOKEN}` });
    for (const h of ['x-user-id', 'x-roles', 'x-org-id', 'authorization', 'cookie', 'x-internal-token']) expect(seen[0]!.headers[h]).toBeUndefined();
  });

  it('буруу токен dms-д хүрэлгүй 404', async () => {
    expect((await api().get('/api/public/esign/short')).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('public замаас бусад нь JWT шаардана', async () => {
    expect((await api().get('/api/dms/files/abc')).status).toBe(401);
    expect((await api().get('/api/origination/contracts/app-1/esign')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('ажилтны proxy нь dms-ийн дотоод e-sign / public / dev замыг гаргахгүй (origination л дуудна)', async () => {
    const h = { authorization: `Bearer ${officer}` };
    for (const p of ['/api/dms/esign/requests', '/api/dms/esign/requests/sr-1/cancel', '/api/dms/public/esign/abc', '/api/dms/dev/esign/mock/x', '/api/dms/%65sign/requests', '/api/dms//esign/requests', '/api/DMS/esign/requests']) {
      expect((await api().post(p).set(h)).status, p).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it('ажилтны proxy-н бусад замууд хэвээр: dms файл, origination-ийн гэрээний e-sign endpoint', async () => {
    const h = { authorization: `Bearer ${officer}` };
    expect((await api().get('/api/dms/files/abc').set(h)).status).toBe(200);
    expect((await api().post('/api/origination/contracts/app-1/esign').set(h).send({})).status).toBe(200);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/files/abc', 'POST /api/contracts/app-1/esign']);
    expect(seen[1]!.headers['x-user-id']).toBe(SEED.users.officerA.id);
  });
});
