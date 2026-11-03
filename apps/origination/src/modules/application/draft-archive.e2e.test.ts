import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, createApplication, hasTestDb, resetDb } from '../../test-utils/factories';
import { ApplicationModule } from './application.module';

// FR-1.6: draft.auto_archive_days (DEMO 30) хоног өөрчлөгдөөгүй ноорог архивлагдаж жагсаалтаас нуугдана.
describe.skipIf(!hasTestDb)('draft auto-archive (DB)', () => {
  let t: TestApp;
  let url: string;
  beforeAll(async () => {
    t = await createTestApp([ApplicationModule]);
    await t.app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); });
  const daysAgo = (n: number) => new Date(t.clock.now().getTime() - n * 86_400_000);

  it('хуучирсан DRAFT архивлагдана; шинэхэн DRAFT болон DRAFT биш хүсэлт хөндөгдөхгүй; жагсаалтаас нуугдана', async () => {
    const old = await createApplication(t.prisma, { officerId: 'officer-1' });
    const fresh = await createApplication(t.prisma, { officerId: 'officer-1' });
    const submitted = await createApplication(t.prisma, { officerId: 'officer-1', status: 'SUBMITTED' });
    await t.prisma.loanApplication.update({ where: { id: old.id }, data: { updatedAt: daysAgo(31) } });
    await t.prisma.loanApplication.update({ where: { id: submitted.id }, data: { updatedAt: daysAgo(90) } });

    expect((await request(url).post('/api/applications/archive-stale').set(actors.officer('officer-1'))).status).toBe(403);
    const res = await request(url).post('/api/applications/archive-stale').set(actors.admin());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived: 1, days: 30 });

    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: old.id } })).archivedAt).not.toBeNull();
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: fresh.id } })).archivedAt).toBeNull();
    expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: submitted.id } })).archivedAt).toBeNull();
    const list = await request(url).get('/api/applications').set(actors.officer('officer-1'));
    expect(list.body.items.map((i: { id: string }) => i.id).sort()).toEqual([fresh.id, submitted.id].sort());
    expect(await t.prisma.auditLog.count({ where: { entityId: old.id, action: 'DRAFT_ARCHIVED' } })).toBe(1);
    // дахин ажиллуулахад давхар архивлахгүй
    expect((await request(url).post('/api/applications/archive-stale').set(actors.admin())).body.archived).toBe(0);
  });
});
