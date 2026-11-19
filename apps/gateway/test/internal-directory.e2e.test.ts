import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import { CTX_HEADERS, DIRECTORY_TOKEN_HEADER, OrgDirectory } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// Origination-ийн Excel экспортын нэр: GET /api/internal/directory — JWT-гүй, ЗӨВХӨН бие даасан GATEWAY_DIRECTORY_TOKEN (X-Directory-Token),
// X-Org-Id-д заасан байгууллагаар хязгаарлагдсан, PII-гүй. INTERNAL_AUTH_SECRET (proxy бүх backend-д тарааж өгдөг) энд хүчингүй.
describe.skipIf(!HAS_DB)('gateway GET /api/internal/directory', () => {
  const TOKEN = 'directory-token-for-tests-0123';
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const withToken = { [DIRECTORY_TOKEN_HEADER]: TOKEN };
  const org = (id: string) => ({ [CTX_HEADERS.orgId]: id });
  const made: { orgId?: string; branchId?: string } = {};
  const savedToken = process.env.GATEWAY_DIRECTORY_TOKEN;

  beforeAll(async () => {
    process.env.GATEWAY_DIRECTORY_TOKEN = TOKEN;
    ({ app, prisma } = await createGateway());
    const other = await prisma.org.create({ data: { code: 'DIRTEST2', name: 'Directory Internal Test Org' } });
    made.orgId = other.id;
    made.branchId = (await prisma.branch.create({ data: { orgId: other.id, code: 'DI1', name: 'Бусдын дотоод салбар' } })).id;
  });
  afterAll(async () => {
    if (savedToken === undefined) delete process.env.GATEWAY_DIRECTORY_TOKEN; else process.env.GATEWAY_DIRECTORY_TOKEN = savedToken;
    if (made.branchId) await prisma.branch.delete({ where: { id: made.branchId } });
    if (made.orgId) await prisma.org.delete({ where: { id: made.orgId } });
    await app.close();
  });

  it('зөв X-Directory-Token + X-Org-Id → 200: seed салбар, ЗЭЗ-ийн нэр (JWT шаардахгүй, proxy-д шингэхгүй)', async () => {
    const res = await api().get('/api/internal/directory').set({ ...withToken, ...org(SEED.org.id) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(OrgDirectory.safeParse(res.body).success).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual(['branches', 'users']);
    expect(res.body.branches[SEED.branches.head.id]).toBe(SEED.branches.head.name);
    expect(res.body.users[SEED.users.officerA.id]).toBe(SEED.users.officerA.fullName);
  });

  it('хариуд PII (username, email, phone, нууц үг, дүр) алга', async () => {
    const raw = JSON.stringify((await api().get('/api/internal/directory').set({ ...withToken, ...org(SEED.org.id) })).body);
    for (const leak of ['officer.a', '@', 'passwordHash', 'scrypt', 'OFFICER', 'APPROVER']) expect(raw, leak).not.toContain(leak);
  });

  it('ЗӨВХӨН X-Org-Id-д заасан байгууллага: бусад байгууллагын нэр холилдохгүй; үл мэдэгдэх (хүчинтэй хэлбэртэй) байгууллага → хоосон лавлах', async () => {
    const other = await api().get('/api/internal/directory').set({ ...withToken, ...org(made.orgId!) });
    expect(other.status).toBe(200);
    expect(other.body.branches).toEqual({ [made.branchId!]: 'Бусдын дотоод салбар' });
    expect(other.body.users).toEqual({});
    const mine = await api().get('/api/internal/directory').set({ ...withToken, ...org(SEED.org.id) });
    expect(JSON.stringify(mine.body)).not.toContain('Бусдын дотоод салбар');
    const unknown = await api().get('/api/internal/directory').set({ ...withToken, ...org('00000000-0000-4000-8000-000000000000') });
    expect([unknown.status, unknown.body]).toEqual([200, { branches: {}, users: {} }]);
  });

  it('токен байхгүй / буруу → 401 INVALID_DIRECTORY_TOKEN (JWT guard-ын UNAUTHENTICATED биш: зам нь JWT-ээс чөлөөлөгдсөн, токеноор хамгаалагдсан)', async () => {
    const none = await api().get('/api/internal/directory').set(org(SEED.org.id));
    expect([none.status, none.body.code]).toEqual([401, 'INVALID_DIRECTORY_TOKEN']);
    const bad = await api().get('/api/internal/directory').set({ ...org(SEED.org.id), [DIRECTORY_TOKEN_HEADER]: 'wrong' });
    expect([bad.status, bad.body.code]).toEqual([401, 'INVALID_DIRECTORY_TOKEN']);
  });

  it('хуучин дотоод токен (X-Internal-Token = INTERNAL_AUTH_SECRET) болон тэр утгыг X-Directory-Token-д өгөх нь хүчингүй → 401', async () => {
    const secret = process.env.INTERNAL_AUTH_SECRET!;
    expect(secret).toBeTruthy();
    const old = await api().get('/api/internal/directory').set({ ...org(SEED.org.id), [CTX_HEADERS.internalToken]: secret });
    expect([old.status, old.body.code]).toEqual([401, 'INVALID_DIRECTORY_TOKEN']);
    const swapped = await api().get('/api/internal/directory').set({ ...org(SEED.org.id), [DIRECTORY_TOKEN_HEADER]: secret });
    expect([swapped.status, swapped.body.code]).toEqual([401, 'INVALID_DIRECTORY_TOKEN']);
  });

  it('ажилтны JWT нь directory token-ийг орлохгүй', async () => {
    const login = await api().post('/api/auth/login').send({ username: 'admin', password: PASSWORD });
    const res = await api().get('/api/internal/directory').set({ authorization: `Bearer ${login.body.accessToken as string}`, ...org(SEED.org.id) });
    expect([res.status, res.body.code]).toEqual([401, 'INVALID_DIRECTORY_TOKEN']);
  });

  it('X-Org-Id байхгүй / буруу хэлбэртэй → 400 INVALID_ORG', async () => {
    for (const headers of [withToken, { ...withToken, ...org('') }, { ...withToken, ...org('org 1') }, { ...withToken, ...org('a'.repeat(65)) }, { ...withToken, ...org('../x') }]) {
      const res = await api().get('/api/internal/directory').set(headers);
      expect([res.status, res.body.code]).toEqual([400, 'INVALID_ORG']);
    }
  });

  it('GATEWAY_DIRECTORY_TOKEN тохируулаагүй бол хаалттай: 503 (дотоод токен/JWT/зөв токен — аль нь ч нэр авахгүй)', async () => {
    const saved = process.env.GATEWAY_DIRECTORY_TOKEN;
    delete process.env.GATEWAY_DIRECTORY_TOKEN;
    try {
      for (const headers of [org(SEED.org.id), { ...org(SEED.org.id), ...withToken }, { ...org(SEED.org.id), [CTX_HEADERS.internalToken]: process.env.INTERNAL_AUTH_SECRET! }]) {
        const res = await api().get('/api/internal/directory').set(headers);
        expect([res.status, res.body.code]).toEqual([503, 'DIRECTORY_TOKEN_NOT_CONFIGURED']);
      }
    } finally { process.env.GATEWAY_DIRECTORY_TOKEN = saved; }
  });

  it('/api/internal/* дахь бусад зам controller-оор үйлчлэгдэхгүй, proxy-д ч шилжихгүй: зөв токентой ч 404', async () => {
    for (const path of ['/api/internal/other', '/api/internal/directory/extra', '/api/internal/portal/me', '/api/internal']) {
      const res = await api().get(path).set({ ...withToken, ...org(SEED.org.id) });
      expect(res.status, path).toBe(404);
    }
  });

  it('унших-зөвхөн; ажилтны /api/directory JWT-тэй хэвээр (directory token-ээр нээгдэхгүй)', async () => {
    for (const m of ['post', 'put', 'delete'] as const) expect([404, 405], m).toContain((await api()[m]('/api/internal/directory').set({ ...withToken, ...org(SEED.org.id) })).status);
    const anon = await api().get('/api/directory').set({ ...withToken, ...org(SEED.org.id) });
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('UNAUTHENTICATED');
  });
});
