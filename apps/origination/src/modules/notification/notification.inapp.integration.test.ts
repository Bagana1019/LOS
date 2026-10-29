import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationListResponse, NotificationView, UnreadCountResponse, MarkAllReadResponse } from '@los/contracts';
import { actors, createApplication, hasTestDb, ORG } from '../../test-utils/factories';
import { bootNotification, NotificationEnv, resetNotification } from './notification.test-helpers';

describe.skipIf(!hasTestDb)('notification: ажилтны хонх (in-app)', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  const seed = async (userId: string, n: number) => {
    const app = await createApplication(env.t.prisma);
    for (let i = 0; i < n; i++) {
      env.t.clock.advanceMs(1000);
      await env.service.notifyUsers({ orgId: ORG, userIds: [userId], type: 'RETURNED', applicationId: app.id, payload: { applicationNo: app.appNo, comment: `Тайлбар ${i}` } });
    }
    return app;
  };

  describe('notifyUsers', () => {
    it('хэрэглэгч бүрт нэг мөр, давхардсан/хоосон ID-г алгасна', async () => {
      const res = await env.service.notifyUsers({ orgId: ORG, userIds: ['u1', 'u1', 'u2', null, undefined, ''], type: 'APPROVAL_REQUESTED', payload: { applicationNo: 'A-1' } });
      expect(res.created).toBe(2);
      expect(await env.t.prisma.notification.count()).toBe(2);
      expect(await env.service.notifyUsers({ orgId: ORG, userIds: [], type: 'MENTION' })).toEqual({ created: 0 });
    });

    it('IN_APP-ийг унтраасан ажилтныг алгасна', async () => {
      await env.t.prisma.notificationPreference.create({ data: { orgId: ORG, subjectType: 'USER', subjectId: 'u1', channel: 'IN_APP', enabled: false } });
      expect((await env.service.notifyUsers({ orgId: ORG, userIds: ['u1', 'u2'], type: 'MENTION' })).created).toBe(1);
      expect((await env.t.prisma.notification.findMany()).map((n) => n.userId)).toEqual(['u2']);
    });

    it('tx-тэй дуудахад rollback болбол мэдэгдэл үлдэхгүй (бизнес өөрчлөлттэй атомик)', async () => {
      await expect(env.t.prisma.$transaction(async (tx) => {
        await env.service.notifyUsers({ orgId: ORG, userIds: ['u1'], type: 'MENTION' }, tx);
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
      expect(await env.t.prisma.notification.count()).toBe(0);
    });
  });

  describe('GET /notifications', () => {
    it('нэвтрээгүй 401; CUSTOMER дүр (хонх байхгүй) 403', async () => {
      await env.http().get('/api/notifications').set(actors.anonymous()).expect(401);
      await env.http().get('/api/notifications').set(actors.customer('c1')).expect(403);
      await env.http().get('/api/notifications/unread-count').set(actors.customer('c1')).expect(403);
    });

    it('зөвхөн өөрийн мэдэгдэл, шинэ нь эхэнд, title/body IN_APP загвараас render хийгдсэн, DTO-д таарна', async () => {
      const app = await seed('officer-1', 3);
      await env.service.notifyUsers({ orgId: ORG, userIds: ['officer-2'], type: 'MENTION', payload: { applicationNo: 'X', comment: 'нууц' } });
      const res = await env.http().get('/api/notifications').set(actors.officer('officer-1')).expect(200);
      const body = NotificationListResponse.parse(res.body);
      expect(body).toMatchObject({ total: 3, unreadCount: 3, page: 1, pageSize: 20 });
      expect(body.items.map((i) => i.payload.comment)).toEqual(['Тайлбар 2', 'Тайлбар 1', 'Тайлбар 0']);
      expect(body.items[0]).toMatchObject({ type: 'RETURNED', applicationId: app.id, title: 'Хүсэлт буцаагдлаа', body: `${app.appNo} дугаартай хүсэлт буцаагдлаа. Тайлбар: Тайлбар 2`, readAt: null });
      expect(JSON.stringify(body)).not.toContain('нууц');
    });

    it('хуудаслалт, unreadOnly (?unreadOnly=false нь шүүхгүй)', async () => {
      await seed('officer-1', 5);
      const first = (await env.http().get('/api/notifications?pageSize=2').set(actors.officer()).expect(200)).body;
      expect(first.items).toHaveLength(2);
      expect(first.total).toBe(5);
      const third = (await env.http().get('/api/notifications?pageSize=2&page=3').set(actors.officer()).expect(200)).body;
      expect(third.items).toHaveLength(1);
      const id = first.items[0].id;
      await env.http().post(`/api/notifications/${id}/read`).set(actors.officer()).expect(200);
      expect((await env.http().get('/api/notifications?unreadOnly=true').set(actors.officer())).body).toMatchObject({ total: 4, unreadCount: 4 });
      expect((await env.http().get('/api/notifications?unreadOnly=false').set(actors.officer())).body).toMatchObject({ total: 5, unreadCount: 4 });
    });

    it('буруу query → 400 VALIDATION_FAILED', async () => {
      const res = await env.http().get('/api/notifications?pageSize=1000').set(actors.officer()).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      await env.http().get('/api/notifications?unreadOnly=maybe').set(actors.officer()).expect(400);
    });

    it('өөр байгууллагын мэдэгдэл харагдахгүй', async () => {
      await env.t.prisma.notification.create({ data: { orgId: 'other-org', userId: 'officer-1', type: 'MENTION' } });
      expect((await env.http().get('/api/notifications').set(actors.officer('officer-1')).expect(200)).body.total).toBe(0);
    });
  });

  describe('unread-count / read / read-all', () => {
    it('unread-count', async () => {
      await seed('officer-1', 2);
      const res = await env.http().get('/api/notifications/unread-count').set(actors.officer()).expect(200);
      expect(UnreadCountResponse.parse(res.body)).toEqual({ unreadCount: 2 });
      await env.http().get('/api/notifications/unread-count').set(actors.anonymous()).expect(401);
    });

    it('read: readAt тавигдана; дахин уншихад idempotent (readAt өөрчлөгдөхгүй)', async () => {
      await seed('officer-1', 1);
      const id = (await env.t.prisma.notification.findFirstOrThrow()).id;
      const first = NotificationView.parse((await env.http().post(`/api/notifications/${id}/read`).set(actors.officer()).expect(200)).body);
      expect(first.readAt).toBe('2026-10-28T02:00:01.000Z');
      env.t.clock.advanceMs(60_000);
      const second = NotificationView.parse((await env.http().post(`/api/notifications/${id}/read`).set(actors.officer()).expect(200)).body);
      expect(second.readAt).toBe(first.readAt);
      expect((await env.http().get('/api/notifications/unread-count').set(actors.officer())).body.unreadCount).toBe(0);
    });

    it('бусдын мэдэгдэл эсвэл байхгүй ID → 404 (бусдынх уншигдахгүй)', async () => {
      await seed('officer-2', 1);
      const id = (await env.t.prisma.notification.findFirstOrThrow()).id;
      const res = await env.http().post(`/api/notifications/${id}/read`).set(actors.officer('officer-1')).expect(404);
      expect(res.body.code).toBe('NOTIFICATION_NOT_FOUND');
      await env.http().post('/api/notifications/no-such-id/read').set(actors.officer('officer-1')).expect(404);
      expect((await env.t.prisma.notification.findFirstOrThrow()).readAt).toBeNull();
      await env.http().post(`/api/notifications/${id}/read`).set(actors.anonymous()).expect(401);
    });

    it('read-all: зөвхөн өөрийнхийг, тоог буцаана; дахин дуудахад 0', async () => {
      await seed('officer-1', 3);
      await seed('officer-2', 2);
      const res = await env.http().post('/api/notifications/read-all').set(actors.officer('officer-1')).expect(200);
      expect(MarkAllReadResponse.parse(res.body)).toEqual({ updated: 3 });
      expect((await env.http().post('/api/notifications/read-all').set(actors.officer('officer-1')).expect(200)).body).toEqual({ updated: 0 });
      expect((await env.http().get('/api/notifications/unread-count').set(actors.officer('officer-2'))).body.unreadCount).toBe(2);
    });

    it('зэрэгцээ read-all ба read: нийт нэг л удаа тоологдоно', async () => {
      await seed('officer-1', 4);
      const id = (await env.t.prisma.notification.findFirstOrThrow()).id;
      const [a, b, c] = await Promise.all([
        env.http().post('/api/notifications/read-all').set(actors.officer()), env.http().post('/api/notifications/read-all').set(actors.officer()), env.http().post(`/api/notifications/${id}/read`).set(actors.officer()),
      ]);
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
      expect(a.body.updated + b.body.updated).toBeLessThanOrEqual(4);
      expect((await env.http().get('/api/notifications/unread-count').set(actors.officer())).body.unreadCount).toBe(0);
    });
  });
});
