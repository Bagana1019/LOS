import { type INestApplication } from '@nestjs/common';
import { SEED } from '@los/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { HAS_DB, PASSWORD, createGateway } from './app';

// F9-24 · /settings/audit: объект/үйлдлийн шүүлт том/жижиг үсэг үл ялгах + хэсэгчилсэн; хэрэглэгчийг нэр/нэвтрэх нэрээр олох (audit:read).
// Маркер объект (`W4Probe`) нь шүүлтийн тоог өөр (HTTP_*, LOGIN_*) мөрөөс тусгаарлана.
describe.skipIf(!HAS_DB)('gateway audit filters + actor lookup (F9-24)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());
  const auth: Record<string, { authorization: string }> = {};
  const made: { orgId?: string; userIds: string[] } = { userIds: [] };

  const login = async (username: string) => {
    const res = await api().post('/api/auth/login').send({ username, password: PASSWORD });
    return { authorization: `Bearer ${res.body.accessToken as string}` };
  };
  const audit = async (query: Record<string, string>) => {
    const res = await api().get('/api/admin/audit-logs').query({ pageSize: '200', ...query }).set(auth.admin!);
    return res.body as { total: number; items: Array<{ entity: string; action: string }> };
  };
  const actors = async (q?: string, who = 'admin') => api().get('/api/admin/audit-actors').query(q === undefined ? {} : { q }).set(auth[who]!);

  beforeAll(async () => {
    ({ app, prisma } = await createGateway());
    await prisma.user.updateMany({ data: { failedLoginCount: 0, lockedUntil: null } });
    for (const u of ['admin', 'compliance', 'officer.a']) auth[u] = await login(u);

    const row = (entity: string, action: string) => ({ orgId: SEED.org.id, entity, entityId: `w4-${action}`, action });
    await prisma.auditLog.createMany({
      data: [row('W4Probe', 'PROBE_CREATED'), row('W4Probe', 'PROBE_UPDATED'), row('W4Probe', 'PROBELOGOUT'), row('W4Other', 'PROBE_CREATED')],
    });

    const other = await prisma.org.create({ data: { code: 'W4AUD', name: 'W4 Audit Test Org' } });
    made.orgId = other.id;
    const mk = (orgId: string, username: string, fullName: string, isActive = true) =>
      ({ orgId, username, passwordHash: 'x', fullName, roles: ['OFFICER'], isActive });
    const rows = [
      mk(other.id, 'w4.stranger', 'Адм Бусдын байгууллага'),
      mk(SEED.org.id, 'w4.gone', 'Явсан Хэрэглэгч', false),
      ...Array.from({ length: 22 }, (_, i) => mk(SEED.org.id, `w4cap.${String(i).padStart(2, '0')}`, `Хязгаар ${i}`)),
    ];
    for (const r of rows) made.userIds.push((await prisma.user.create({ data: r })).id);
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: made.userIds } } });
    if (made.orgId) await prisma.org.delete({ where: { id: made.orgId } });
    await app.close();
  });

  describe('GET /api/admin/audit-logs · объект, үйлдэл', () => {
    it('объект том/жижиг үсэг үл ялгана: "w4probe" = "W4Probe" 3 мөр', async () => {
      const res = await audit({ entity: 'w4probe' });
      expect(res.total).toBe(3);
      expect(res.items.every((i) => i.entity === 'W4Probe')).toBe(true);
    });

    it('объект хэсэгчилсэн: "4PRO" → W4Probe (3), "W4" → W4Probe + W4Other (4)', async () => {
      expect((await audit({ entity: '4PRO' })).total).toBe(3);
      expect((await audit({ entity: 'W4' })).total).toBe(4);
    });

    it('үйлдэл том/жижиг үсэг үл ялгах, хэсэгчилсэн: "created" → *_CREATED', async () => {
      const res = await audit({ entity: 'w4', action: 'created' });
      expect(res.total).toBe(2);
      expect(res.items.every((i) => i.action === 'PROBE_CREATED')).toBe(true);
    });

    it('объект + үйлдэл хоёул хамт хэрэглэгдэнэ (AND)', async () => {
      const res = await audit({ entity: 'w4probe', action: 'created' });
      expect(res.total).toBe(1);
      expect(res.items[0]).toMatchObject({ entity: 'W4Probe', action: 'PROBE_CREATED' });
    });

    it('таарахгүй утга 0 мөр буцаана', async () => {
      expect((await audit({ entity: 'w4', action: 'zzz-no-such-action' })).total).toBe(0);
    });

    it('"_" ба "%" нь LIKE-ийн орлуулагч биш, шууд тэмдэгт: "_" зөвхөн доогуур зураастай үйлдлийг олно', async () => {
      const underscore = await audit({ entity: 'w4', action: '_' });
      expect(underscore.total).toBe(3); // PROBELOGOUT (зураасгүй) орохгүй
      expect(underscore.items.some((i) => i.action === 'PROBELOGOUT')).toBe(false);
      expect((await audit({ entity: 'w4', action: '%' })).total).toBe(0);
    });
  });

  describe('GET /api/admin/audit-actors · хэрэглэгч нэрээр олох', () => {
    it('нэвтрэх нэрийн хэсгээр, том/жижиг үсэг үл ялгана: "ADM" → admin', async () => {
      const res = await actors('ADM');
      expect(res.status).toBe(200);
      expect(res.body.map((a: { username: string }) => a.username)).toContain('admin');
    });

    it('овог нэрээр, кирилл том/жижиг үсэг үл ялгана: "АДМИН" → "Админ"', async () => {
      const res = await actors('АДМИН');
      expect(res.body).toEqual(expect.arrayContaining([{ id: SEED.users.admin.id, username: 'admin', fullName: 'Админ' }]));
    });

    it('бусад байгууллагын хэрэглэгч хэзээ ч гарахгүй', async () => {
      const res = await actors('адм');
      expect(res.body.map((a: { username: string }) => a.username)).not.toContain('w4.stranger');
    });

    it('идэвхгүй болсон ажилтныг олно (хуучин аудитын мөрийг нэрээр нь хайхад хэрэгтэй)', async () => {
      const res = await actors('w4.gone');
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ username: 'w4.gone', fullName: 'Явсан Хэрэглэгч' });
    });

    it('хоосон q → бүгдээс, 20-оор хязгаарлагдана; овог нэрээр эрэмбэлнэ', async () => {
      const all = await actors();
      expect(all.status).toBe(200);
      expect(all.body).toHaveLength(20);
      const names = all.body.map((a: { fullName: string }) => a.fullName);
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'mn')));
      expect((await actors('w4cap.')).body).toHaveLength(20); // 22 таарахаас 20
    });

    it('зөвхөн id, username, fullName буцаана (нууц үг, имэйл, утас, дүр гарахгүй)', async () => {
      const res = await actors('w4.gone');
      expect(Object.keys(res.body[0]).sort()).toEqual(['fullName', 'id', 'username']);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|email|phone|roles/i);
    });

    it('эрх: нэвтрээгүй 401; audit:read-гүй (ЗЭЗ) 403; COMPLIANCE (audit:read, user:manage-гүй) 200', async () => {
      expect((await api().get('/api/admin/audit-actors')).status).toBe(401);
      expect((await actors('adm', 'officer.a')).status).toBe(403);
      expect((await actors('комплаенс', 'compliance')).status).toBe(200);
    });

    it('q 60 тэмдэгтээс урт бол 400', async () => {
      expect((await actors('x'.repeat(61))).status).toBe(400);
    });
  });
});
