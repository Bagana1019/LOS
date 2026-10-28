import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import { menuFor, permissionsFor } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

const flatIds = (items: { id: string; children?: { id: string }[] }[]): string[] => items.flatMap((i) => [i.id, ...(i.children ? flatIds(i.children as never) : [])]);
const cookieOf = (res: request.Response, name = 'los_rt'): string | undefined =>
  (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${name}=`));
const tokenOf = (cookie: string) => cookie.split(';')[0]!.split('=')[1]!;

describe.skipIf(!HAS_DB)('gateway auth (AC: 5 хэрэглэгчээр нэвтэрнэ)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const login = (username: string, password = PASSWORD) => api().post('/api/auth/login').send({ username, password });

  beforeAll(async () => { ({ app, prisma } = await createGateway()); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null, isActive: true } });
    await prisma.auditLog.deleteMany();
  });

  it.each(Object.values(SEED.users))('logs in $username and returns the role-specific menu', async (u) => {
    const res = await login(u.username);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: u.id, username: u.username, roles: [...u.roles], orgId: SEED.org.id });
    expect(res.body.user.branchId).toBe(u.branch ? SEED.branches[u.branch].id : null);
    expect(res.body.permissions).toEqual(permissionsFor(u.roles));
    expect(flatIds(res.body.menu)).toEqual(flatIds(menuFor(u.roles)));
    expect(res.body.accessToken.split('.')).toHaveLength(3);
    // refresh token зөвхөн httpOnly cookie-д, body-д байхгүй
    const c = cookieOf(res)!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Strict/i);
    expect(c).toMatch(/Path=\/api\/auth/);
    expect(JSON.stringify(res.body)).not.toContain(tokenOf(c));
  });

  it('menus differ by role: only ADMIN sees settings; OFFICER cannot', async () => {
    const admin = await login('admin');
    const officer = await login('officer.a');
    expect(flatIds(admin.body.menu)).toContain('settings');
    expect(flatIds(officer.body.menu)).not.toContain('settings');
  });

  it('GET /auth/me needs a valid bearer token', async () => {
    expect((await api().get('/api/auth/me')).status).toBe(401);
    expect((await api().get('/api/auth/me').set('authorization', 'Bearer not.a.jwt')).status).toBe(401);
    const { body } = await login('manager');
    const me = await api().get('/api/auth/me').set('authorization', `Bearer ${body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('manager');
  });

  it('answers wrong password, unknown user and inactive user identically (no enumeration)', async () => {
    await prisma.user.update({ where: { username: 'approver' }, data: { isActive: false } });
    const [wrong, unknown, inactive] = await Promise.all([login('admin', 'nope-nope-nope'), login('ghost', 'nope-nope-nope'), login('approver')]);
    for (const r of [wrong, unknown, inactive]) {
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    expect(unknown.body.message).toBe(wrong.body.message);
    expect(inactive.body.message).toBe(wrong.body.message);
  });

  it('rejects malformed login bodies with 400', async () => {
    expect((await api().post('/api/auth/login').send({ username: 'admin' })).status).toBe(400);
  });

  it('locks the account after repeated failures, even for the right password, and records it in the audit log', async () => {
    for (let i = 0; i < 5; i++) expect((await login('officer.b', 'wrong-password')).status).toBe(401);
    const locked = await login('officer.b'); // зөв нууц үг ч түгжигдсэн
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('INVALID_CREDENTIALS');
    const actions = (await prisma.auditLog.findMany({ where: { entityId: SEED.users.officerB.id }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions.filter((a) => a === 'LOGIN_FAILED')).toHaveLength(5);
    expect(actions).toContain('LOGIN_LOCKED');
    // түгжээ тайлагдвал (хугацаа дууссан) дахин нэвтэрнэ
    await prisma.user.update({ where: { username: 'officer.b' }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await login('officer.b')).status).toBe(200);
  });

  it('writes LOGIN_SUCCESS / LOGIN_FAILED without ever storing the password', async () => {
    await login('admin');
    await login('admin', 'super-secret-wrong');
    const rows = await prisma.auditLog.findMany();
    expect(rows.map((r) => r.action).sort()).toEqual(['LOGIN_FAILED', 'LOGIN_SUCCESS']);
    expect(JSON.stringify(rows)).not.toContain('super-secret-wrong');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it('rotates the refresh token: new cookie each time, old one is single-use', async () => {
    const first = await login('officer.a');
    const c1 = cookieOf(first)!;
    const r1 = await api().post('/api/auth/refresh').set('cookie', `los_rt=${tokenOf(c1)}`);
    expect(r1.status).toBe(200);
    const c2 = cookieOf(r1)!;
    expect(tokenOf(c2)).not.toBe(tokenOf(c1));
    expect(r1.body.accessToken).not.toBe(first.body.accessToken);
    // шинэ токен ажиллана
    expect((await api().post('/api/auth/refresh').set('cookie', `los_rt=${tokenOf(c2)}`)).status).toBe(200);
  });

  it('detects refresh token reuse and revokes the whole session family', async () => {
    const first = await login('officer.a');
    const stolen = tokenOf(cookieOf(first)!);
    const r1 = await api().post('/api/auth/refresh').set('cookie', `los_rt=${stolen}`);
    const legit = tokenOf(cookieOf(r1)!);
    // халдагч хуучин токеноо дахин ашиглана
    const replay = await api().post('/api/auth/refresh').set('cookie', `los_rt=${stolen}`);
    expect(replay.status).toBe(401);
    // гинж бүхэлдээ хүчингүй: зөв хэрэглэгчийн шинэ токен ч, access token ч ажиллахгүй
    expect((await api().post('/api/auth/refresh').set('cookie', `los_rt=${legit}`)).status).toBe(401);
    expect((await api().get('/api/auth/me').set('authorization', `Bearer ${r1.body.accessToken}`)).status).toBe(401);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain('TOKEN_REUSE_DETECTED');
  });

  it('refresh without a cookie, or from a foreign Origin, is rejected', async () => {
    expect((await api().post('/api/auth/refresh')).status).toBe(401);
    const first = await login('admin');
    const evil = await api().post('/api/auth/refresh').set('origin', 'https://evil.example').set('cookie', `los_rt=${tokenOf(cookieOf(first)!)}`);
    expect(evil.status).toBe(403);
    const ok = await api().post('/api/auth/refresh').set('origin', 'http://localhost:3000').set('cookie', `los_rt=${tokenOf(cookieOf(first)!)}`);
    expect(ok.status).toBe(200);
  });

  it('logout revokes the session at once: access token and refresh cookie both stop working', async () => {
    const first = await login('admin');
    const rt = tokenOf(cookieOf(first)!);
    const auth = { authorization: `Bearer ${first.body.accessToken}` };
    expect((await api().get('/api/auth/me').set(auth)).status).toBe(200);
    const out = await api().post('/api/auth/logout').set('cookie', `los_rt=${rt}`);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/los_rt=;/);
    expect((await api().get('/api/auth/me').set(auth)).status).toBe(401);
    expect((await api().post('/api/auth/refresh').set('cookie', `los_rt=${rt}`)).status).toBe(401);
    expect((await prisma.auditLog.findMany()).map((a) => a.action)).toContain('LOGOUT');
  });

  it('deactivating a user ends their access token immediately', async () => {
    const { body } = await login('approver');
    await prisma.user.update({ where: { username: 'approver' }, data: { isActive: false } });
    expect((await api().get('/api/auth/me').set('authorization', `Bearer ${body.accessToken}`)).status).toBe(401);
  });

  it('rate-limits login attempts per client (429)', async () => {
    process.env.LOGIN_RATE_LIMIT = '3';
    const fresh = await createGateway(); // шинэ throttler storage
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await request(fresh.app.getHttpServer()).post('/api/auth/login').send({ username: 'admin', password: 'wrong-password' })).status);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
    } finally { process.env.LOGIN_RATE_LIMIT = '1000'; await fresh.app.close(); }
  });

  it('GET /api/health is public and checks the database', async () => {
    const res = await api().get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'gateway' });
  });
});
