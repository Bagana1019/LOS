import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// M13 · хэрэглэгч-салбар оноолт (user:manage), аудит лог (audit:read)
describe.skipIf(!HAS_DB)('gateway admin (user → branch)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const token = async (username: string) => (await api().post('/api/auth/login').send({ username, password: PASSWORD })).body.accessToken as string;
  const bearer = async (username: string) => ({ authorization: `Bearer ${await token(username)}` });
  const bayanzurkh = SEED.branches.bayanzurkh.id;

  beforeAll(async () => { ({ app, prisma } = await createGateway()); });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null, isActive: true } });
    await prisma.user.update({ where: { id: SEED.users.officerA.id }, data: { branchId: SEED.branches.head.id } });
  });

  it('нэвтрээгүй 401; ADMIN биш бүгд 403', async () => {
    expect((await api().get('/api/admin/users')).status).toBe(401);
    for (const u of ['officer.a', 'manager', 'approver']) {
      const h = await bearer(u);
      expect((await api().get('/api/admin/users').set(h)).status).toBe(403);
      expect((await api().get('/api/admin/branches').set(h)).status).toBe(403);
      expect((await api().put(`/api/admin/users/${SEED.users.officerA.id}/branch`).set(h).send({ branchId: bayanzurkh })).status).toBe(403);
      expect((await api().get('/api/admin/audit-logs').set(h)).status).toBe(403);
    }
  });

  it('салбар, хэрэглэгчийн жагсаалт (нууц үгийн hash гарахгүй)', async () => {
    const h = await bearer('admin');
    const branches = await api().get('/api/admin/branches').set(h);
    expect(branches.body.map((b: { code: string }) => b.code).filter((c: string) => ['100', '200'].includes(c))).toEqual(['100', '200']);
    const users = await api().get('/api/admin/users').set(h);
    expect(users.status).toBe(200);
    expect(users.body.length).toBeGreaterThanOrEqual(Object.keys(SEED.users).length);
    expect(JSON.stringify(users.body)).not.toMatch(/passwordHash|scrypt/i);
    expect(users.body.find((u: { username: string }) => u.username === 'officer.a')).toMatchObject({ branchId: SEED.branches.head.id, roles: ['OFFICER'] });
  });

  it('оноолт солигдоно: сесс хүчингүй болж, шинэ нэвтрэлт шинэ салбартай, аудит before/after', async () => {
    const oldSession = await api().post('/api/auth/login').send({ username: 'officer.a', password: PASSWORD });
    expect(oldSession.body.user.branchId).toBe(SEED.branches.head.id);
    const h = await bearer('admin');
    const res = await api().put(`/api/admin/users/${SEED.users.officerA.id}/branch`).set(h).set('x-correlation-id', 'corr-ub-1').send({ branchId: bayanzurkh });
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(bayanzurkh);
    expect(await prisma.session.count({ where: { userId: SEED.users.officerA.id, revokedAt: null } })).toBe(0);
    const again = await api().post('/api/auth/login').send({ username: 'officer.a', password: PASSWORD });
    expect(again.body.user.branchId).toBe(bayanzurkh);

    const audit = await api().get('/api/admin/audit-logs').query({ action: 'USER_BRANCH_ASSIGNED' }).set(h);
    expect(audit.body.total).toBe(1);
    expect(audit.body.items[0]).toMatchObject({ entityId: SEED.users.officerA.id, actorId: SEED.users.admin.id, beforeJson: { branchId: SEED.branches.head.id }, afterJson: { branchId: bayanzurkh }, correlationId: 'corr-ub-1' });
  });

  it('ЗЭЗ/салбарын захирлыг салбаргүй болгож болохгүй (422); админ салбаргүй байж болно; байхгүй салбар/хэрэглэгч 404', async () => {
    const h = await bearer('admin');
    const noBranch = await api().put(`/api/admin/users/${SEED.users.officerA.id}/branch`).set(h).send({ branchId: null });
    expect(noBranch.status).toBe(422);
    expect(noBranch.body.code).toBe('BRANCH_REQUIRED');
    expect((await api().put(`/api/admin/users/${SEED.users.approver.id}/branch`).set(h).send({ branchId: null })).status).toBe(200); // батлагч төвийн хэрэглэгч
    await prisma.user.update({ where: { id: SEED.users.approver.id }, data: { branchId: SEED.branches.head.id } });
    expect((await api().put(`/api/admin/users/${SEED.users.officerA.id}/branch`).set(h).send({ branchId: '00000000-0000-4000-8000-0000000009ff' })).status).toBe(404);
    expect((await api().put('/api/admin/users/00000000-0000-4000-8000-0000000009fe/branch').set(h).send({ branchId: bayanzurkh })).status).toBe(404);
    expect((await api().put(`/api/admin/users/${SEED.users.officerA.id}/branch`).set(h).send({ branchId: 'not-a-uuid' })).status).toBe(400);
  });
});
