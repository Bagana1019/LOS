// F9-14 — a wrong CURRENT password on POST /auth/change-password is a form error, not an expired session:
// the web client treats every 401 as "access token expired" (refresh + retry, then logout), so this must not be 401.
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

const WRONG = 'wrong-current-x';
const NEW_VALID = 'Aa1!longenough';
const CHANGE_PASSWORD_LIMIT = 10; // @Throttle on POST /auth/change-password (per minute, per IP)

describe.skipIf(!HAS_DB)('POST /auth/change-password — wrong current password (F9-14)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  const api = () => request(app.getHttpServer());
  const change = (currentPassword: string, newPassword = NEW_VALID) =>
    api().post('/api/auth/change-password').set('authorization', `Bearer ${token}`).send({ currentPassword, newPassword });

  beforeEach(async () => {
    process.env.RATE_LIMIT_KEY_PREFIX = `test:${randomUUID()}:`; // fresh counters per test
    ({ app, prisma } = await createGateway());
    await prisma.session.deleteMany();
    token = (await api().post('/api/auth/login').send({ username: 'officer.a', password: PASSWORD })).body.accessToken as string;
  });
  afterEach(async () => { await app.close(); });

  it('answers 422 INVALID_CURRENT_PASSWORD with a Mongolian message — never 401', async () => {
    const res = await change(WRONG);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'INVALID_CURRENT_PASSWORD', message: 'Одоогийн нууц үг буруу байна' });
  });

  it('keeps the session and the stored password untouched', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { username: 'officer.a' }, select: { passwordHash: true } });
    const res = await change(WRONG);
    expect(res.headers['set-cookie']).toBeUndefined(); // refresh cookie is not cleared
    expect((await api().get('/api/auth/me').set('authorization', `Bearer ${token}`)).status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { username: 'officer.a' }, select: { passwordHash: true } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it('reveals nothing beyond the standard error envelope (same surface as login errors)', async () => {
    const res = await change(WRONG);
    expect(Object.keys(res.body as object).sort()).toEqual(['code', 'correlationId', 'message']);
  });

  it('still counts every wrong attempt against the route limit, and a blocked caller learns nothing about the password', async () => {
    for (let i = 0; i < CHANGE_PASSWORD_LIMIT; i++) expect((await change(WRONG)).status).toBe(422);
    expect((await change(WRONG)).status).toBe(429);
    // Correct current password + unchanged new password would answer PASSWORD_UNCHANGED (422) = "the password is right" if it got through.
    const probe = await change(PASSWORD, PASSWORD);
    expect(probe.status).toBe(429);
    expect(probe.body.code).not.toBe('PASSWORD_UNCHANGED');
  });
});
