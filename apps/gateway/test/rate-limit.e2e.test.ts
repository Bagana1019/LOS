// M7 (login limiter keyed by username+IP, per-IP ceiling) and M9 (limits shared by several gateway pods through Redis).
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

const ENV_KEYS = ['LOGIN_RATE_LIMIT', 'LOGIN_IP_RATE_LIMIT', 'TRUST_PROXY', 'RATE_LIMIT_KEY_PREFIX'] as const;

describe.skipIf(!HAS_DB)('login rate limits (M7) across pods (M9)', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const apps: INestApplication[] = [];
  let prisma: PrismaService;

  /** A gateway pod. Pods created in one test share RATE_LIMIT_KEY_PREFIX (= the same Redis keyspace). */
  const pod = async () => { const g = await createGateway(); apps.push(g.app); prisma = g.prisma; return g.app; };
  const login = (app: INestApplication, username: string, password = PASSWORD, ip?: string) => {
    const r = request(app.getHttpServer()).post('/api/auth/login');
    return (ip ? r.set('x-forwarded-for', ip) : r).send({ username, password });
  };

  beforeEach(() => {
    process.env.RATE_LIMIT_KEY_PREFIX = `test:${randomUUID()}:`; // fresh counters per test
    process.env.LOGIN_RATE_LIMIT = '3';
    process.env.LOGIN_IP_RATE_LIMIT = '1000';
    delete process.env.TRUST_PROXY;
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await prisma?.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
  });

  it('failures of one user block only that user from that IP — a colleague behind the same NAT IP still logs in', async () => {
    const app = await pod();
    for (let i = 0; i < 3; i++) expect((await login(app, 'ghost.user', 'wrong-password')).status).toBe(401);
    const blocked = await login(app, 'ghost.user', 'wrong-password');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body).toMatchObject({ code: 'TOO_MANY_LOGIN_ATTEMPTS' });
    expect((await login(app, 'officer.a')).status).toBe(200);
    expect((await login(app, 'manager')).status).toBe(200);
  });

  it('a blocked (username, IP) pair is rejected even with the right password', async () => {
    const app = await pod();
    for (let i = 0; i < 3; i++) await login(app, 'compliance', 'wrong-password');
    expect((await login(app, 'compliance')).status).toBe(429);
  });

  it('username is normalised (case, surrounding spaces) so variants share one counter', async () => {
    const app = await pod();
    for (const u of ['GHOST.X', ' ghost.x ', 'Ghost.X']) expect((await login(app, u, 'wrong-password')).status).toBe(401);
    expect((await login(app, 'ghost.x', 'wrong-password')).status).toBe(429);
  });

  it('a successful login resets that user\'s failure counter', async () => {
    const app = await pod();
    for (let i = 0; i < 2; i++) await login(app, 'approver', 'wrong-password');
    expect((await login(app, 'approver')).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await login(app, 'approver', 'wrong-password')).status).toBe(401);
  });

  it('with TRUST_PROXY the client IP comes from X-Forwarded-For: the same username from another branch IP is not blocked', async () => {
    process.env.TRUST_PROXY = '1';
    const app = await pod();
    for (let i = 0; i < 3; i++) await login(app, 'ghost.y', 'wrong-password', '10.1.1.1');
    expect((await login(app, 'ghost.y', 'wrong-password', '10.1.1.1')).status).toBe(429);
    expect((await login(app, 'ghost.y', 'wrong-password', '10.2.2.2')).status).toBe(401);
  });

  it('without TRUST_PROXY a spoofed X-Forwarded-For does not reset the counter', async () => {
    const app = await pod();
    for (let i = 0; i < 3; i++) await login(app, 'ghost.z', 'wrong-password', `10.9.9.${i}`);
    expect((await login(app, 'ghost.z', 'wrong-password', '10.9.9.200')).status).toBe(429);
  });

  it('per-IP ceiling (LOGIN_IP_RATE_LIMIT) still stops password spraying across many usernames', async () => {
    process.env.LOGIN_IP_RATE_LIMIT = '4';
    process.env.LOGIN_RATE_LIMIT = '1000';
    const app = await pod();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await login(app, `spray.${i}`, 'wrong-password')).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
  });

  it('two gateway pods share the failure counter (Redis): failures on pod A block the pair on pod B', async () => {
    const [a, b] = [await pod(), await pod()];
    await login(a, 'ghost.multi', 'wrong-password');
    await login(b, 'ghost.multi', 'wrong-password');
    await login(a, 'ghost.multi', 'wrong-password');
    expect((await login(b, 'ghost.multi', 'wrong-password')).status).toBe(429);
    expect((await login(a, 'officer.b')).status).toBe(200);
  });

  it('two gateway pods share the per-IP ceiling (Redis throttler storage)', async () => {
    process.env.LOGIN_IP_RATE_LIMIT = '2';
    const [a, b] = [await pod(), await pod()];
    expect((await login(a, 'officer.a')).status).toBe(200);
    expect((await login(b, 'officer.a')).status).toBe(200);
    expect((await login(a, 'officer.a')).status).toBe(429);
  });
});
