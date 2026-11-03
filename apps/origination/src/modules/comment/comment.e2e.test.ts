import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { CommentListResponse, CommentView } from '@los/contracts';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, createApplication, hasTestDb, resetDb } from '../../test-utils/factories';
import { CommentModule } from './comment.module';

// FR-13.4: тайлбар/чат, @mention → MENTION мэдэгдэл; хүрээ (NFR-3).
describe.skipIf(!hasTestDb)('comments (DB)', () => {
  let t: TestApp;
  let http: () => request.Agent | ReturnType<typeof request>;
  beforeAll(async () => {
    t = await createTestApp([CommentModule]);
    await t.app.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    http = () => request(url);
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); });

  it('ЗЭЗ тайлбар бичиж @mention хийвэл дурдсан хүнд MENTION хонх, өөрийгөө дурдвал үүсэхгүй', async () => {
    const app = await createApplication(t.prisma, { officerId: 'officer-1' });
    const res = await http().post(`/api/applications/${app.id}/comments`).set(actors.officer('officer-1')).send({ body: '  Баримтыг нөхнө үү  ', mentions: ['approver-1', 'approver-1', 'officer-1'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const c = CommentView.parse(res.body);
    expect(c.body).toBe('Баримтыг нөхнө үү');
    expect(c.mentions).toEqual(['approver-1']);
    const notes = await t.prisma.notification.findMany({ where: { applicationId: app.id } });
    expect(notes.map((n) => [n.userId, n.type])).toEqual([['approver-1', 'MENTION']]);
    expect(await t.prisma.auditLog.count({ where: { applicationId: app.id, action: 'COMMENT_ADDED' } })).toBe(1);
    const list = CommentListResponse.parse((await http().get(`/api/applications/${app.id}/comments`).set(actors.approver('approver-1'))).body);
    expect(list.items.map((i) => i.id)).toEqual([c.id]);
  });

  it('хүрээ: өөр ЗЭЗ-ийн хүсэлтэд унших/бичих 403; хоосон/урт body 400; зээлдэгч 403', async () => {
    const app = await createApplication(t.prisma, { officerId: 'officer-1' });
    const other = actors.officer('officer-2');
    expect((await http().get(`/api/applications/${app.id}/comments`).set(other)).status).toBe(403);
    expect((await http().post(`/api/applications/${app.id}/comments`).set(other).send({ body: 'x' })).status).toBe(403);
    expect((await http().post(`/api/applications/${app.id}/comments`).set(actors.officer('officer-1')).send({ body: '   ' })).status).toBe(400);
    expect((await http().post(`/api/applications/${app.id}/comments`).set(actors.officer('officer-1')).send({ body: 'x'.repeat(2001) })).status).toBe(400);
    expect((await http().get(`/api/applications/${app.id}/comments`).set(actors.customer('c1'))).status).toBe(403);
    expect((await http().get(`/api/applications/${app.id}/comments`).set(actors.anonymous())).status).toBeGreaterThanOrEqual(401);
  });
});
