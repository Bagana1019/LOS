import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import { CTX_HEADERS, OrgDirectory } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// Origination-ийн Excel экспортын нэр: GET /api/internal/directory — JWT-гүй, зөвхөн дотоод токентой, байгууллагаар хязгаарлагдсан, PII-гүй.
describe.skipIf(!HAS_DB)('gateway GET /api/internal/directory', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const internal = { [CTX_HEADERS.internalToken]: process.env.INTERNAL_AUTH_SECRET ?? '' };
  const made: { orgId?: string; branchId?: string } = {};

  beforeAll(async () => {
    ({ app, prisma } = await createGateway());
    const other = await prisma.org.create({ data: { code: 'DIRTEST2', name: 'Directory Internal Test Org' } });
    made.orgId = other.id;
    made.branchId = (await prisma.branch.create({ data: { orgId: other.id, code: 'DI1', name: 'Бусдын дотоод салбар' } })).id;
  });
  afterAll(async () => {
    if (made.branchId) await prisma.branch.delete({ where: { id: made.branchId } });
    if (made.orgId) await prisma.org.delete({ where: { id: made.orgId } });
    await app.close();
  });

  it('дотоод токен + X-Org-Id → 200: seed салбар, ЗЭЗ-ийн нэр (JWT шаардахгүй, proxy-д шингэхгүй)', async () => {
    const res = await api().get('/api/internal/directory').set({ ...internal, [CTX_HEADERS.orgId]: SEED.org.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(OrgDirectory.safeParse(res.body).success).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual(['branches', 'users']);
    expect(res.body.branches[SEED.branches.head.id]).toBe(SEED.branches.head.name);
    expect(res.body.users[SEED.users.officerA.id]).toBe(SEED.users.officerA.fullName);
  });

  it('хариуд PII (username, email, phone, нууц үг, дүр) алга', async () => {
    const raw = JSON.stringify((await api().get('/api/internal/directory').set({ ...internal, [CTX_HEADERS.orgId]: SEED.org.id })).body);
    for (const leak of ['officer.a', '@', 'passwordHash', 'scrypt', 'OFFICER', 'APPROVER']) expect(raw, leak).not.toContain(leak);
  });

  it('байгууллагын тусгаарлалт: X-Org-Id-д заасан байгууллагын нэр л гарна', async () => {
    const other = await api().get('/api/internal/directory').set({ ...internal, [CTX_HEADERS.orgId]: made.orgId! });
    expect(other.status).toBe(200);
    expect(other.body.branches).toEqual({ [made.branchId!]: 'Бусдын дотоод салбар' });
    expect(other.body.users).toEqual({});
    const mine = await api().get('/api/internal/directory').set({ ...internal, [CTX_HEADERS.orgId]: SEED.org.id });
    expect(JSON.stringify(mine.body)).not.toContain('Бусдын дотоод салбар');
  });

  it('токен байхгүй / буруу → 401 INVALID_INTERNAL_TOKEN (JWT guard-ын UNAUTHENTICATED биш: зам нь JWT-ээс чөлөөлөгдсөн, токеноор хамгаалагдсан)', async () => {
    const org = { [CTX_HEADERS.orgId]: SEED.org.id };
    const none = await api().get('/api/internal/directory').set(org);
    expect([none.status, none.body.code]).toEqual([401, 'INVALID_INTERNAL_TOKEN']);
    const bad = await api().get('/api/internal/directory').set({ ...org, [CTX_HEADERS.internalToken]: 'wrong' });
    expect([bad.status, bad.body.code]).toEqual([401, 'INVALID_INTERNAL_TOKEN']);
  });

  it('ажилтны JWT нь дотоод токенийг орлохгүй', async () => {
    const login = await api().post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await api().get('/api/internal/directory').set({ authorization: `Bearer ${login.body.accessToken as string}`, [CTX_HEADERS.orgId]: SEED.org.id });
    expect([res.status, res.body.code]).toEqual([401, 'INVALID_INTERNAL_TOKEN']);
  });

  it('X-Org-Id байхгүй → 400 MISSING_ORG', async () => {
    const res = await api().get('/api/internal/directory').set(internal);
    expect([res.status, res.body.code]).toEqual([400, 'MISSING_ORG']);
  });

  it('INTERNAL_AUTH_SECRET тохируулаагүй бол хаалттай (503), токенгүй хүн нэр авч болохгүй', async () => {
    const saved = process.env.INTERNAL_AUTH_SECRET;
    delete process.env.INTERNAL_AUTH_SECRET;
    try {
      const res = await api().get('/api/internal/directory').set({ [CTX_HEADERS.orgId]: SEED.org.id });
      expect([res.status, res.body.code]).toEqual([503, 'INTERNAL_AUTH_NOT_CONFIGURED']);
    } finally { process.env.INTERNAL_AUTH_SECRET = saved; }
  });

  it('унших-зөвхөн; ажилтны /api/directory JWT-тэй хэвээр', async () => {
    for (const m of ['post', 'put', 'delete'] as const) expect([404, 405], m).toContain((await api()[m]('/api/internal/directory').set({ ...internal, [CTX_HEADERS.orgId]: SEED.org.id })).status);
    const anon = await api().get('/api/directory').set({ ...internal, [CTX_HEADERS.orgId]: SEED.org.id });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('UNAUTHENTICATED');
  });
});
