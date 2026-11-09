import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// FR-13 · салбар, хэрэглэгчийн удирдлага (нэмэх, засах, идэвхгүй болгох, нууц үг шинэчлэх). Өөрийн үүсгэсэн мөрийг л өөрчилнө.
describe.skipIf(!HAS_DB)('gateway admin management (branches, users)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const login = async (username: string, password = PASSWORD) => api().post('/api/auth/login').send({ username, password });
  const bearer = async (username: string) => ({ authorization: `Bearer ${(await login(username)).body.accessToken as string}` });
  const created: { users: string[]; branches: string[] } = { users: [], branches: [] };
  const uname = (n: string) => `t13.${n}`;

  beforeAll(async () => {
    ({ app, prisma } = await createGateway());
    await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
  });
  afterAll(async () => {
    await prisma.session.deleteMany({ where: { userId: { in: created.users } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...created.users, ...created.branches] } } });
    await prisma.user.deleteMany({ where: { id: { in: created.users } } });
    await prisma.branch.deleteMany({ where: { id: { in: created.branches } } });
    await app.close();
  });

  const newUser = async (h: object, over: Record<string, unknown> = {}) => {
    const res = await api().post('/api/admin/users').set(h).send({ username: uname('u'), fullName: 'Тест Хэрэглэгч', roles: ['OFFICER'], branchId: SEED.branches.head.id, ...over });
    if (res.status === 201) created.users.push(res.body.user.id);
    return res;
  };

  it('ADMIN биш бүгд 403', async () => {
    const h = await bearer('officer.a');
    expect((await api().post('/api/admin/branches').set(h).send({ code: 'ZZ1', name: 'Тест' })).status).toBe(403);
    expect((await api().post('/api/admin/users').set(h).send({ username: uname('x'), fullName: 'Тест', roles: ['OFFICER'], branchId: null })).status).toBe(403);
    expect((await api().post(`/api/admin/users/${SEED.users.approver.id}/deactivate`).set(h)).status).toBe(403);
    expect((await api().post(`/api/admin/users/${SEED.users.approver.id}/reset-password`).set(h)).status).toBe(403);
  });

  it('салбар: нэмэх (код том үсэг), давхардал 409, засах, идэвхтэй хэрэглэгчтэй салбарыг идэвхгүй болгож болохгүй, сэргээх', async () => {
    const h = await bearer('admin');
    const res = await api().post('/api/admin/branches').set(h).send({ code: 't13b', name: 'Тест салбар' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'T13B', name: 'Тест салбар', isActive: true, activeUserCount: 0 });
    const id = res.body.id as string;
    created.branches.push(id);
    expect((await api().post('/api/admin/branches').set(h).send({ code: 'T13B', name: 'Давхар' })).status).toBe(409);
    expect((await api().post('/api/admin/branches').set(h).send({ code: 'bad code!', name: 'Тест' })).status).toBe(400);

    expect((await api().put(`/api/admin/branches/${id}`).set(h).send({ name: 'Шинэ нэр' })).body.name).toBe('Шинэ нэр');

    const u = await newUser(h, { username: uname('inb'), branchId: id });
    expect(u.status).toBe(201);
    const blocked = await api().post(`/api/admin/branches/${id}/deactivate`).set(h);
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('BRANCH_HAS_ACTIVE_USERS');

    await api().post(`/api/admin/users/${u.body.user.id}/deactivate`).set(h).expect(200);
    const off = await api().post(`/api/admin/branches/${id}/deactivate`).set(h);
    expect(off.body.isActive).toBe(false);
    // идэвхгүй салбарт хэрэглэгч нэмэх/оноох боломжгүй, идэвхгүй салбартай хэрэглэгчийг сэргээх боломжгүй
    expect((await newUser(h, { username: uname('inb2'), branchId: id })).body.code).toBe('BRANCH_INACTIVE');
    expect((await api().post(`/api/admin/users/${u.body.user.id}/reactivate`).set(h)).body.code).toBe('BRANCH_INACTIVE');
    expect((await api().post(`/api/admin/branches/${id}/reactivate`).set(h)).body.isActive).toBe(true);
    expect((await api().post(`/api/admin/users/${u.body.user.id}/reactivate`).set(h)).body.isActive).toBe(true);

    const actions = (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['BRANCH_CREATED', 'BRANCH_UPDATED', 'BRANCH_DEACTIVATED', 'BRANCH_REACTIVATED']);
  });

  it('хэрэглэгч нэмэх: түр нууц үг нэг удаа, hash/нууц үг аудитад орохгүй, нэвтрэхэд заавал солих, нууц үг солиход ердийн болно', async () => {
    const h = await bearer('admin');
    const res = await newUser(h, { username: uname('new'), email: 'new.user@example.mn', phone: '99112233' });
    expect(res.status).toBe(201);
    const { user, temporaryPassword } = res.body as { user: { id: string; mustChangePassword: boolean }; temporaryPassword: string };
    expect(user.mustChangePassword).toBe(true);
    expect(temporaryPassword).toHaveLength(16);
    expect(JSON.stringify(res.body.user)).not.toMatch(/passwordHash|scrypt/i);
    const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: user.id } }));
    expect(audit).not.toContain(temporaryPassword);
    expect(audit).not.toContain('new.user@example.mn');
    expect(audit).not.toContain('99112233');
    expect((await newUser(h, { username: uname('new') })).status).toBe(409); // давхар нэр
    expect((await newUser(h, { username: 'Bad Name' })).status).toBe(400);

    const first = await login(uname('new'), temporaryPassword);
    expect(first.status).toBe(200);
    expect(first.body.mustChangePassword).toBe(true);
    const th = { authorization: `Bearer ${first.body.accessToken as string}` };
    const blocked = await api().get('/api/admin/users').set(th);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await api().get('/api/auth/me').set(th)).body.mustChangePassword).toBe(true);
    expect((await api().get('/api/origination/customers').set(th)).body.code).toBe('PASSWORD_CHANGE_REQUIRED'); // proxy-оор ч нэвтэрч чадахгүй

    expect((await api().post('/api/auth/change-password').set(th).send({ currentPassword: 'wrong', newPassword: 'Aa1!longenough' })).status).toBe(401);
    expect((await api().post('/api/auth/change-password').set(th).send({ currentPassword: temporaryPassword, newPassword: 'short' })).status).toBe(400);
    expect((await api().post('/api/auth/change-password').set(th).send({ currentPassword: temporaryPassword, newPassword: temporaryPassword })).status).toBe(422);
    expect((await api().post('/api/auth/change-password').set(th).send({ currentPassword: temporaryPassword, newPassword: 'NewPassw0rd-ok' })).status).toBe(204);
    expect((await login(uname('new'), temporaryPassword)).status).toBe(401);
    const again = await login(uname('new'), 'NewPassw0rd-ok');
    expect(again.status).toBe(200);
    expect(again.body.mustChangePassword).toBeUndefined();
    expect((await api().get('/api/auth/me').set({ authorization: `Bearer ${first.body.accessToken as string}` })).status).toBe(401); // хуучин сесс хаагдсан
  });

  it('дүр ↔ салбар шалгалт: ЗЭЗ/салбарын захирал салбаргүй 422; төвийн хэрэглэгч (батлагч, комплаенс) салбаргүй 201; дүр буруу 400', async () => {
    const h = await bearer('admin');
    const noBranch = await newUser(h, { username: uname('nb'), branchId: null });
    expect(noBranch.status).toBe(422);
    expect(noBranch.body.code).toBe('BRANCH_REQUIRED');
    expect((await newUser(h, { username: uname('appr'), roles: ['APPROVER', 'COMPLIANCE'], branchId: null })).status).toBe(201);
    expect((await newUser(h, { username: uname('badrole'), roles: ['SUPERUSER'] })).status).toBe(400);
    expect((await newUser(h, { username: uname('norole'), roles: [] })).status).toBe(400);
  });

  it('дүр өөрчлөх: сесс хүчингүй, шинэ эрх, аудит before/after (ПИИ-гүй); өөрийн ADMIN дүрийг хасч болохгүй', async () => {
    const h = await bearer('admin');
    const u = await newUser(h, { username: uname('role') });
    const { user, temporaryPassword } = u.body as { user: { id: string }; temporaryPassword: string };
    const sess = await login(uname('role'), temporaryPassword);
    const res = await api().put(`/api/admin/users/${user.id}`).set(h).send({ fullName: 'Шинэ нэр', roles: ['OFFICER', 'COMPLIANCE'], branchId: SEED.branches.head.id, email: 'x@y.mn' });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['OFFICER', 'COMPLIANCE']);
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect((await api().get('/api/auth/me').set({ authorization: `Bearer ${sess.body.accessToken as string}` })).status).toBe(401);
    const a = await prisma.auditLog.findFirstOrThrow({ where: { entityId: user.id, action: 'USER_ROLES_CHANGED' } });
    expect(a.beforeJson).toMatchObject({ roles: ['OFFICER'] });
    expect(a.afterJson).toMatchObject({ roles: ['OFFICER', 'COMPLIANCE'], profileChanged: true });
    expect(JSON.stringify(a)).not.toContain('x@y.mn');

    const self = await api().put(`/api/admin/users/${SEED.users.admin.id}`).set(h).send({ fullName: 'Админ', roles: ['APPROVER'], branchId: null });
    expect(self.status).toBe(422);
    expect(self.body.code).toBe('SELF_ADMIN_REMOVAL');
  });

  it('идэвхгүй болгох: нэвтэрч чадахгүй, сесс/токен хүчингүй, сэргээж болно; өөрийгөө болохгүй', async () => {
    const h = await bearer('admin');
    const u = await newUser(h, { username: uname('off') });
    const { user, temporaryPassword } = u.body as { user: { id: string }; temporaryPassword: string };
    const live = await login(uname('off'), temporaryPassword);
    const res = await api().post(`/api/admin/users/${user.id}/deactivate`).set(h);
    expect(res.body.isActive).toBe(false);
    expect((await login(uname('off'), temporaryPassword)).status).toBe(401);
    expect((await api().get('/api/auth/me').set({ authorization: `Bearer ${live.body.accessToken as string}` })).status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deactivatedAt).not.toBeNull();
    expect((await api().post(`/api/admin/users/${user.id}/reactivate`).set(h)).body.isActive).toBe(true);
    expect((await login(uname('off'), temporaryPassword)).status).toBe(200);

    const self = await api().post(`/api/admin/users/${SEED.users.admin.id}/deactivate`).set(h);
    expect(self.status).toBe(422);
    expect(self.body.code).toBe('SELF_DEACTIVATION');
    const actions = (await prisma.auditLog.findMany({ where: { entityId: user.id }, orderBy: { at: 'asc' } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['USER_CREATED', 'USER_DEACTIVATED', 'USER_REACTIVATED']));
  });

  it('нууц үг шинэчлэх: шинэ түр нууц үг, хуучин ажиллахгүй, заавал солих, сесс хаагдана; өөрийнхийг болохгүй; идэвхгүйд болохгүй', async () => {
    const h = await bearer('admin');
    const u = await newUser(h, { username: uname('rst') });
    const { user, temporaryPassword: first } = u.body as { user: { id: string }; temporaryPassword: string };
    const sess = await login(uname('rst'), first);
    const res = await api().post(`/api/admin/users/${user.id}/reset-password`).set(h);
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).not.toBe(first);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect((await login(uname('rst'), first)).status).toBe(401);
    expect((await login(uname('rst'), res.body.temporaryPassword)).body.mustChangePassword).toBe(true);
    expect((await api().get('/api/auth/me').set({ authorization: `Bearer ${sess.body.accessToken as string}` })).status).toBe(401);
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: user.id } }))).not.toContain(res.body.temporaryPassword);

    expect((await api().post(`/api/admin/users/${SEED.users.admin.id}/reset-password`).set(h)).body.code).toBe('SELF_PASSWORD_RESET');
    await api().post(`/api/admin/users/${user.id}/deactivate`).set(h).expect(200);
    expect((await api().post(`/api/admin/users/${user.id}/reset-password`).set(h)).body.code).toBe('USER_INACTIVE');
  });
});
