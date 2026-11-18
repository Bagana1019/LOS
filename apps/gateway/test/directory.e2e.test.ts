import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import { OrgDirectory } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// FR-1.2 (M2): GET /api/directory — id → харуулах нэр. Нэвтэрсэн ямар ч ажилтан уншина; PII, бусад байгууллагын өгөгдөл гарахгүй.
describe.skipIf(!HAS_DB)('gateway GET /api/directory', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const bearer = async (username: string) => {
    const res = await api().post('/api/auth/login').send({ username, password: PASSWORD });
    return { authorization: `Bearer ${res.body.accessToken as string}` };
  };
  // Header-ийг ӨМНӨ нь авна: supertest нь нэг http.Server-ийг хуваалцдаг тул хүсэлтийг үүсгэсний дараа login хийвэл эхний хүсэлтийн сервер хаагдана.
  const getDirectory = async (username: string) => {
    const headers = await bearer(username);
    return api().get('/api/directory').set(headers);
  };
  const made: { orgId?: string; userIds: string[]; branchIds: string[] } = { userIds: [], branchIds: [] };

  beforeAll(async () => {
    ({ app, prisma } = await createGateway());
    await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
    // Өөр байгууллага: түүний нэр манай лавлахад ХЭЗЭЭ Ч орохгүй.
    const other = await prisma.org.create({ data: { code: 'DIRTEST', name: 'Directory Test Org' } });
    made.orgId = other.id;
    const otherBranch = await prisma.branch.create({ data: { orgId: other.id, code: 'DT1', name: 'Бусдын салбар' } });
    made.branchIds.push(otherBranch.id);
    const otherUser = await prisma.user.create({ data: { orgId: other.id, branchId: otherBranch.id, username: 'dirtest.other', passwordHash: 'x', fullName: 'Бусдын ажилтан', roles: ['OFFICER'] } });
    made.userIds.push(otherUser.id);
    // Идэвхгүй болсон ажилтан (өөрийн байгууллагад): хуучин хүсэлтийн ЗЭЗ-ийг нэрээр нь харуулах ёстой.
    const gone = await prisma.user.create({ data: { orgId: SEED.org.id, branchId: SEED.branches.head.id, username: 'dirtest.gone', passwordHash: 'x', fullName: 'Явсан ЗЭЗ', roles: ['OFFICER'], isActive: false, email: 'gone@example.test', phone: '99110000' } });
    made.userIds.push(gone.id);
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: made.userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: made.branchIds } } });
    if (made.orgId) await prisma.org.delete({ where: { id: made.orgId } });
    await app.close();
  });

  it('нэвтрээгүй хүсэлт 401', async () => {
    expect((await api().get('/api/directory')).status).toBe(401);
    expect((await api().get('/api/directory').set({ authorization: 'Bearer not-a-token' })).status).toBe(401);
  });

  it.each(['officer.a', 'officer.b', 'manager', 'approver', 'admin', 'compliance'])('%s (ажилтны дүр бүр) 200 авна', async (username) => {
    const res = await getDirectory(username);
    expect(res.status).toBe(200);
    expect(OrgDirectory.safeParse(res.body).success).toBe(true);
  });

  it('seed салбар, ЗЭЗ-ийн нэрийг id-аар нь буцаана (UUID биш нэр)', async () => {
    const res = await getDirectory('officer.a');
    expect(res.body.branches[SEED.branches.head.id]).toBe(SEED.branches.head.name);
    expect(res.body.branches[SEED.branches.bayanzurkh.id]).toBe(SEED.branches.bayanzurkh.name);
    expect(res.body.users[SEED.users.officerA.id]).toBe(SEED.users.officerA.fullName);
    expect(res.body.users[SEED.users.officerB.id]).toBe(SEED.users.officerB.fullName);
  });

  it('хариу зөвхөн { branches, users } — PII (username, email, phone, нууц үг, дүр) алга', async () => {
    const res = await getDirectory('officer.a');
    expect(Object.keys(res.body).sort()).toEqual(['branches', 'users']);
    const raw = JSON.stringify(res.body);
    for (const leak of ['officer.a', 'dirtest.gone', 'gone@example.test', '99110000', 'passwordHash', 'scrypt', 'OFFICER', 'APPROVER']) expect(raw, leak).not.toContain(leak);
    for (const v of [...Object.values(res.body.branches), ...Object.values(res.body.users)]) expect(typeof v).toBe('string');
  });

  it('идэвхгүй болсон ажилтны нэр орно (хуучин хүсэлтийн ЗЭЗ)', async () => {
    const res = await getDirectory('approver');
    const gone = made.userIds[1]!;
    expect(res.body.users[gone]).toBe('Явсан ЗЭЗ');
  });

  it('өөр байгууллагын салбар, ажилтан орохгүй (байгууллагын тусгаарлалт)', async () => {
    const res = await getDirectory('admin');
    expect(res.body.branches).not.toHaveProperty(made.branchIds[0]!);
    expect(res.body.users).not.toHaveProperty(made.userIds[0]!);
    expect(JSON.stringify(res.body)).not.toContain('Бусдын');
  });

  it('унших-зөвхөн: POST / PUT / DELETE зөвшөөрөгдөхгүй', async () => {
    const h = await bearer('admin');
    for (const m of ['post', 'put', 'delete'] as const) expect([404, 405], m).toContain((await api()[m]('/api/directory').set(h)).status);
  });
});
