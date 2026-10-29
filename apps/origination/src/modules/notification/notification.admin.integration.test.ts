import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliveryListResponse, DeliveryView, NotificationPreferenceView, PreviewTemplateResponse, PushDeviceView, TemplateView } from '@los/contracts';
import { actors, BRANCH, createApplication, createBorrower, createCustomer, hasTestDb, ORG } from '../../test-utils/factories';
import { bootNotification, NotificationEnv, resetNotification } from './notification.test-helpers';
import { TemplateService } from './template.service';

describe.skipIf(!hasTestDb)('notification: загвар, хүргэлтийн бүртгэл, туршилт, төхөөрөмж, тохиргоо (HTTP)', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  // ── Загвар ────────────────────────────────────────────────────────────────────
  describe('GET/PUT /notifications/templates', () => {
    it('эрх: ADMIN л (401 / OFFICER, BRANCH_MANAGER, APPROVER, CUSTOMER 403)', async () => {
      for (const method of ['get', 'put'] as const) {
        await env.http()[method]('/api/notifications/templates').set(actors.anonymous()).send({}).expect(401);
        for (const who of [actors.officer(), actors.branchManager(), actors.approver(), actors.customer('c1')]) await env.http()[method]('/api/notifications/templates').set(who).send({}).expect(403);
      }
    });

    it('кодонд суулгасан 24 загвар (isBuiltin, id=null), type/channel дарааллаар', async () => {
      const res = await env.http().get('/api/notifications/templates').set(actors.admin()).expect(200);
      const views = TemplateView.array().parse(res.body);
      expect(views).toHaveLength(24);
      expect(views.every((v) => v.id === null && v.isBuiltin && v.isActive && v.locale === 'mn')).toBe(true);
      expect(views[0]).toMatchObject({ type: 'APPROVAL_REQUESTED', channel: 'IN_APP' });
      const approved = views.filter((v) => v.type === 'APPROVED').map((v) => v.channel);
      expect(approved).toEqual(['IN_APP', 'SMS', 'EMAIL', 'PUSH']);
    });

    it('PUT: override үүсгэнэ → жагсаалтад нийлнэ (id, isBuiltin=true хэвээр); дахин PUT шинэчилнэ (давхардахгүй)', async () => {
      const dto = { type: 'PAYMENT_DUE', channel: 'SMS', locale: 'mn', body: 'Сануулга: {{amount}} {{currency}}, {{dueDate}}', isActive: true };
      const created = TemplateView.parse((await env.http().put('/api/notifications/templates').set(actors.admin('admin-9')).send(dto).expect(200)).body);
      expect(created).toMatchObject({ type: 'PAYMENT_DUE', channel: 'SMS', body: dto.body, subject: null, isActive: true, isBuiltin: true });
      expect(created.id).toBeTruthy();
      const updated = TemplateView.parse((await env.http().put('/api/notifications/templates').set(actors.admin()).send({ ...dto, body: 'Шинэ {{amount}}' }).expect(200)).body);
      expect(updated.id).toBe(created.id);
      expect(await env.t.prisma.notificationTemplate.count()).toBe(1);
      expect(await env.t.prisma.notificationTemplate.findFirstOrThrow()).toMatchObject({ orgId: ORG, createdBy: 'admin-9', updatedBy: 'admin-1', body: 'Шинэ {{amount}}' });
      const list = TemplateView.array().parse((await env.http().get('/api/notifications/templates').set(actors.admin())).body);
      expect(list).toHaveLength(24);
      expect(list.find((v) => v.type === 'PAYMENT_DUE' && v.channel === 'SMS')).toMatchObject({ id: created.id, body: 'Шинэ {{amount}}' });
    });

    it('override нь хэрэгжинэ (бодит render) — идэвхгүй болговол кодонд суулгасан руу буцна', async () => {
      const dto = { type: 'PAYMENT_RECEIVED', channel: 'EMAIL', locale: 'mn', subject: 'Баримт {{contractNo}}', body: 'Хүлээн авсан: {{amount}}', isActive: true };
      await env.http().put('/api/notifications/templates').set(actors.admin()).send(dto).expect(200);
      const vars = { contractNo: 'BZ-1', amount: 5000 };
      const tpl = env.t.app.get(TemplateService);
      expect(await tpl.render(ORG, 'PAYMENT_RECEIVED', 'EMAIL', 'mn', vars)).toMatchObject({ subject: 'Баримт BZ-1', body: 'Хүлээн авсан: 5,000' });
      await env.http().put('/api/notifications/templates').set(actors.admin()).send({ ...dto, isActive: false }).expect(200);
      expect((await tpl.render(ORG, 'PAYMENT_RECEIVED', 'EMAIL', 'mn', vars))!.subject).toBe('Төлбөр хүлээн авлаа');
      expect(await tpl.render('other-org', 'PAYMENT_RECEIVED', 'EMAIL', 'mn', vars)).toMatchObject({ subject: 'Төлбөр хүлээн авлаа' }); // өөр байгууллагад нөлөөлөхгүй
    });

    it('SMS-д гарчиг хадгалагдахгүй (null); EMAIL/PUSH/IN_APP-д гарчиг заавал (400 SUBJECT_REQUIRED)', async () => {
      const sms = TemplateView.parse((await env.http().put('/api/notifications/templates').set(actors.admin()).send({ type: 'APPROVED', channel: 'SMS', body: 'x {{amount}}', subject: 'үл тоомсорлоно' }).expect(200)).body);
      expect(sms.subject).toBeNull();
      for (const channel of ['EMAIL', 'PUSH', 'IN_APP']) {
        const res = await env.http().put('/api/notifications/templates').set(actors.admin()).send({ type: 'APPROVED', channel, body: 'x', subject: '  ' }).expect(400);
        expect(res.body.code).toBe('SUBJECT_REQUIRED');
      }
    });

    it('үл мэдэгдэх placeholder / буруу хаалт → 400 INVALID_PLACEHOLDER (хадгалахгүй)', async () => {
      const res = await env.http().put('/api/notifications/templates').set(actors.admin()).send({ type: 'APPROVED', channel: 'SMS', body: 'Сайн уу {{borrowerName}} {{secret}} {{password}}' }).expect(400);
      expect(res.body).toMatchObject({ code: 'INVALID_PLACEHOLDER', details: { placeholders: ['secret', 'password'] } });
      expect(res.body.message).toContain('secret');
      const subj = await env.http().put('/api/notifications/templates').set(actors.admin()).send({ type: 'APPROVED', channel: 'EMAIL', subject: '{{nope}}', body: 'ok' }).expect(400);
      expect(subj.body.details.placeholders).toEqual(['nope']);
      await env.http().put('/api/notifications/templates').set(actors.admin()).send({ type: 'APPROVED', channel: 'SMS', body: '{{amount' }).expect(400);
      expect(await env.t.prisma.notificationTemplate.count()).toBe(0);
    });

    it('validation: буруу type/channel, хоосон/хэт урт body → 400 VALIDATION_FAILED', async () => {
      for (const bad of [{ type: 'NOPE', channel: 'SMS', body: 'x' }, { type: 'APPROVED', channel: 'FAX', body: 'x' }, { type: 'APPROVED', channel: 'SMS', body: '' }, { type: 'APPROVED', channel: 'SMS', body: 'x'.repeat(2001) }, {}]) {
        const res = await env.http().put('/api/notifications/templates').set(actors.admin()).send(bad).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('зэрэгцээ PUT: нэг мөр, алдаагүй', async () => {
      const dto = { type: 'MENTION', channel: 'IN_APP', subject: 'Дурдлаа', body: '{{comment}}' };
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => env.http().put('/api/notifications/templates').set(actors.admin()).send({ ...dto, body: `{{comment}} ${i}` })));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(await env.t.prisma.notificationTemplate.count()).toBe(1);
    });

    it('өөр locale-ийн override нь тусдаа мөр (isBuiltin=false)', async () => {
      const en = TemplateView.parse((await env.http().put('/api/notifications/templates').set(actors.admin()).send({ type: 'APPROVED', channel: 'SMS', locale: 'en', body: 'Approved {{contractNo}}' }).expect(200)).body);
      expect(en).toMatchObject({ locale: 'en', isBuiltin: false });
      expect(TemplateView.array().parse((await env.http().get('/api/notifications/templates').set(actors.admin())).body)).toHaveLength(25);
    });
  });

  describe('POST /notifications/templates/preview', () => {
    it('жишээ утгаар render, SMS сегмент, имэйл html escape, үл мэдэгдэх placeholder жагсаалт', async () => {
      const sms = PreviewTemplateResponse.parse((await env.http().post('/api/notifications/templates/preview').set(actors.admin()).send({ type: 'PAYMENT_DUE', channel: 'SMS', body: '{{borrowerName}}: {{amount}} {{currency}} {{x}}' }).expect(200)).body);
      expect(sms).toMatchObject({ subject: null, body: 'Болд: 1,200,000 MNT', html: null, unknownPlaceholders: ['x'], smsSegments: 1 });
      const mail = PreviewTemplateResponse.parse((await env.http().post('/api/notifications/templates/preview').set(actors.admin()).send({ type: 'PAYMENT_DUE', channel: 'EMAIL', subject: 'Сайн уу {{borrowerName}}', body: '<script>alert(1)</script> {{comment}}' }).expect(200)).body);
      expect(mail.subject).toBe('Сайн уу Болд');
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain('&lt;script&gt;');
      expect(mail.smsSegments).toBeNull();
      expect(await env.t.prisma.notificationTemplate.count()).toBe(0); // хадгалахгүй
    });
    it('эрх ADMIN; validation', async () => {
      await env.http().post('/api/notifications/templates/preview').set(actors.officer()).send({ type: 'PAYMENT_DUE', channel: 'SMS', body: 'x' }).expect(403);
      await env.http().post('/api/notifications/templates/preview').set(actors.admin()).send({ type: 'PAYMENT_DUE', channel: 'SMS' }).expect(400);
    });
  });

  // ── Хүргэлтийн бүртгэл ───────────────────────────────────────────────────────────
  describe('GET /notifications/deliveries', () => {
    const mk = (o: Record<string, unknown> = {}) => env.t.prisma.notificationDelivery.create({
      data: {
        orgId: ORG, type: 'PAYMENT_DUE', channel: 'SMS', recipientType: 'CUSTOMER', recipientId: 'c1', address: '+97699112233', body: 'нууц текст', status: 'SENT', dedupeKey: `k:${Math.random()}`,
        scheduledFor: new Date(env.t.clock.now().getTime() + Math.floor(Math.random() * 1000)), ...o,
      },
    });

    it('эрх: 401; OFFICER/APPROVER/CUSTOMER 403; ADMIN, BRANCH_MANAGER 200', async () => {
      await env.http().get('/api/notifications/deliveries').set(actors.anonymous()).expect(401);
      for (const who of [actors.officer(), actors.approver(), actors.customer('c1')]) await env.http().get('/api/notifications/deliveries').set(who).expect(403);
      await env.http().get('/api/notifications/deliveries').set(actors.admin()).expect(200);
      await env.http().get('/api/notifications/deliveries').set(actors.branchManager()).expect(200);
    });

    it('ADMIN бүгдийг (өөрийн org), шүүлт: status, channel, applicationId; addressMasked — бүтэн хаяг/текст задрахгүй', async () => {
      await mk({ applicationId: 'app-1', channel: 'SMS', status: 'SENT' });
      await mk({ applicationId: 'app-1', channel: 'EMAIL', address: 'bold@example.mn', status: 'FAILED', lastError: 'INVALID_ADDRESS' });
      await mk({ applicationId: 'app-2', channel: 'PUSH', address: 'token-android-0001', status: 'QUEUED' });
      await mk({ orgId: 'other-org' });
      const all = DeliveryListResponse.parse((await env.http().get('/api/notifications/deliveries').set(actors.admin()).expect(200)).body);
      expect(all).toMatchObject({ total: 3, page: 1, pageSize: 20 });
      const text = JSON.stringify(all);
      for (const secret of ['+97699112233', 'bold@example.mn', 'token-android-0001', 'нууц текст']) expect(text).not.toContain(secret);
      expect(all.items.map((i) => i.addressMasked).sort()).toEqual(['+976******33', 'b***@example.mn', 'toke***0001']);
      const failed = DeliveryListResponse.parse((await env.http().get('/api/notifications/deliveries?status=FAILED').set(actors.admin())).body);
      expect(failed.items).toHaveLength(1);
      expect(DeliveryView.parse(failed.items[0])).toMatchObject({ channel: 'EMAIL', lastError: 'INVALID_ADDRESS', attempts: 0, sentAt: null });
      expect((await env.http().get('/api/notifications/deliveries?channel=PUSH').set(actors.admin())).body.total).toBe(1);
      expect((await env.http().get('/api/notifications/deliveries?applicationId=app-1').set(actors.admin())).body.total).toBe(2);
    });

    it('хуудаслалт, шинэ нь эхэнд', async () => {
      for (let i = 0; i < 5; i++) await mk({ scheduledFor: new Date(Date.UTC(2026, 9, 28, 3, i)), recipientId: `c${i}` });
      const p1 = (await env.http().get('/api/notifications/deliveries?pageSize=2').set(actors.admin())).body;
      expect(p1.items.map((i: { recipientId: string }) => i.recipientId)).toEqual(['c4', 'c3']);
      expect(p1.total).toBe(5);
      expect((await env.http().get('/api/notifications/deliveries?pageSize=2&page=3').set(actors.admin())).body.items.map((i: { recipientId: string }) => i.recipientId)).toEqual(['c0']);
      await env.http().get('/api/notifications/deliveries?pageSize=500').set(actors.admin()).expect(400);
      await env.http().get('/api/notifications/deliveries?status=BOGUS').set(actors.admin()).expect(400);
    });

    it('BRANCH_MANAGER зөвхөн өөрийн салбарын хүсэлтийн хүргэлт; салбарын хүсэлтгүй (applicationId=null) хүргэлтийг харахгүй', async () => {
      await mk({ applicationId: 'a1', branchId: BRANCH });
      await mk({ applicationId: 'a2', branchId: 'branch-2' });
      await mk({ applicationId: null, branchId: null, channel: 'EMAIL', address: 'a@example.mn' });
      const mine = (await env.http().get('/api/notifications/deliveries').set(actors.branchManager('bm-1', BRANCH)).expect(200)).body;
      expect(mine.total).toBe(1);
      expect(mine.items[0].applicationId).toBe('a1');
      const other = (await env.http().get('/api/notifications/deliveries').set(actors.branchManager('bm-2', 'branch-2'))).body;
      expect(other.items.map((i: { applicationId: string }) => i.applicationId)).toEqual(['a2']);
      // өөр салбарын хүсэлтийг applicationId-аар шүүж болохгүй
      expect((await env.http().get('/api/notifications/deliveries?applicationId=a2').set(actors.branchManager('bm-1', BRANCH))).body.total).toBe(0);
      expect((await env.http().get('/api/notifications/deliveries').set(actors.admin())).body.total).toBe(3);
    });

    it('салбарын захирал X-Branch-Id-гүй бол 403', async () => {
      const headers = { 'x-user-id': 'bm-1', 'x-roles': 'BRANCH_MANAGER', 'x-org-id': ORG };
      await env.http().get('/api/notifications/deliveries').set(headers).expect(403);
    });
  });

  // ── Туршилтын мессеж ─────────────────────────────────────────────────────────────
  describe('POST /notifications/test-send', () => {
    it('эрх: ADMIN л', async () => {
      const body = { channel: 'SMS', to: '99112233' };
      await env.http().post('/api/notifications/test-send').set(actors.anonymous()).send(body).expect(401);
      await env.http().post('/api/notifications/test-send').set(actors.officer()).send(body).expect(403);
      await env.http().post('/api/notifications/test-send').set(actors.branchManager()).send(body).expect(403);
    });

    it('SMS: gateway-ээр шууд илгээж delivery бүртгэнэ (SENT), [Туршилт] тэмдэглэгээтэй, утас нормчилсон', async () => {
      const res = await env.http().post('/api/notifications/test-send').set(actors.admin('admin-5')).send({ channel: 'SMS', to: '9911 2233' }).expect(200);
      const view = DeliveryView.parse(res.body);
      expect(view).toMatchObject({ channel: 'SMS', type: 'PAYMENT_DUE', status: 'SENT', attempts: 1, recipientType: 'USER', recipientId: 'admin-5', addressMasked: '+976******33' });
      expect(env.sms.outbox).toHaveLength(1);
      expect(env.sms.outbox[0]).toMatchObject({ to: '+97699112233', ref: view.id });
      expect(env.sms.outbox[0].text.startsWith('[Туршилт] Болд,')).toBe(true);
      expect(await env.t.prisma.notificationDelivery.count()).toBe(1);
    });

    it('EMAIL (гарчиг + html) ба PUSH; төрлийг сонгож болно', async () => {
      const mail = DeliveryView.parse((await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'EMAIL', to: 'admin@example.mn', type: 'APPROVED' }).expect(200)).body);
      expect(mail).toMatchObject({ channel: 'EMAIL', type: 'APPROVED', status: 'SENT' });
      expect(env.email.outbox[0].subject).toBe('[Туршилт] Таны зээлийн хүсэлт батлагдлаа');
      expect(env.email.outbox[0].html).toContain('<p');
      const push = DeliveryView.parse((await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'PUSH', to: 'token-android-0001' }).expect(200)).body);
      expect(push.status).toBe('SENT');
      expect(env.push.outbox[0]).toMatchObject({ token: 'token-android-0001', title: '[Туршилт] Төлбөр төлөх хугацаа' });
    });

    it('gateway алдаа: retryable → QUEUED (дахин оролдоно), non-retryable → FAILED; хариу нь төлөвийг харуулна', async () => {
      env.sms.failNext(1, { retryable: true });
      const retry = DeliveryView.parse((await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'SMS', to: '99112233' }).expect(200)).body);
      expect(retry).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'PROVIDER_ERROR' });
      env.email.failNext(1, { retryable: false });
      const fail = DeliveryView.parse((await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'EMAIL', to: 'a@example.mn' }).expect(200)).body);
      expect(fail).toMatchObject({ status: 'FAILED', lastError: 'INVALID_ADDRESS' });
    });

    it('буруу хаяг → 422 INVALID_ADDRESS (delivery үүсгэхгүй); IN_APP → 422; validation 400', async () => {
      for (const body of [{ channel: 'SMS', to: '1234' }, { channel: 'EMAIL', to: 'not-email' }, { channel: 'PUSH', to: 'short' }]) {
        const res = await env.http().post('/api/notifications/test-send').set(actors.admin()).send(body).expect(422);
        expect(res.body.code).toBe('INVALID_ADDRESS');
      }
      expect((await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'IN_APP', to: 'someone' }).expect(422)).body.code).toBe('CHANNEL_NOT_TESTABLE');
      expect((await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'SMS', to: '99112233', type: 'SLA_BREACH' }).expect(422)).body.code).toBe('TEMPLATE_NOT_FOUND');
      await env.http().post('/api/notifications/test-send').set(actors.admin()).send({ channel: 'FAX', to: 'x' }).expect(400);
      expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
    });
  });

  // ── Push төхөөрөмж ───────────────────────────────────────────────────────────────
  describe('POST/DELETE /notifications/push-devices', () => {
    const body = (o: Record<string, unknown> = {}) => ({ ownerType: 'USER', ownerId: 'officer-1', token: 'fcm-token-officer-0001', platform: 'ANDROID', ...o });

    it('нэвтрээгүй 401; validation 400 (богино токен, буруу платформ)', async () => {
      await env.http().post('/api/notifications/push-devices').set(actors.anonymous()).send(body()).expect(401);
      await env.http().post('/api/notifications/push-devices').set(actors.officer()).send(body({ token: 'short' })).expect(400);
      await env.http().post('/api/notifications/push-devices').set(actors.officer()).send(body({ platform: 'WINDOWS' })).expect(400);
    });

    it('ажилтан өөрийн userId-аар: 201 (шинэ), дахин бүртгэхэд 200 (lastSeenAt шинэчлэгдэнэ, давхардахгүй); токен нуугдсан', async () => {
      const created = await env.http().post('/api/notifications/push-devices').set(actors.officer()).send(body()).expect(201);
      const view = PushDeviceView.parse(created.body);
      expect(view).toMatchObject({ ownerType: 'USER', ownerId: 'officer-1', platform: 'ANDROID', isActive: true, tokenMasked: 'fcm-***0001' });
      expect(JSON.stringify(created.body)).not.toContain('fcm-token-officer-0001');
      env.t.clock.advanceMs(3600_000);
      const again = await env.http().post('/api/notifications/push-devices').set(actors.officer()).send(body({ platform: 'IOS' })).expect(200);
      expect(PushDeviceView.parse(again.body)).toMatchObject({ id: view.id, platform: 'IOS', lastSeenAt: '2026-10-28T03:00:00.000Z' });
      expect(await env.t.prisma.pushDevice.count()).toBe(1);
    });

    it('идэвхгүй болсон токен дахин бүртгэгдэхэд идэвхжинэ; токен өөр эзэмшигч рүү шилжинэ', async () => {
      await env.http().post('/api/notifications/push-devices').set(actors.officer('officer-1')).send(body()).expect(201);
      await env.t.prisma.pushDevice.updateMany({ data: { isActive: false } });
      await env.http().post('/api/notifications/push-devices').set(actors.officer('officer-2')).send(body({ ownerId: 'officer-2' })).expect(200);
      expect(await env.t.prisma.pushDevice.findFirstOrThrow()).toMatchObject({ ownerId: 'officer-2', isActive: true });
    });

    it('ажилтан бусдын userId-аар / CUSTOMER төрлөөр бүртгэж чадахгүй (403)', async () => {
      await env.http().post('/api/notifications/push-devices').set(actors.officer('officer-1')).send(body({ ownerId: 'officer-2' })).expect(403);
      await env.http().post('/api/notifications/push-devices').set(actors.officer('officer-1')).send(body({ ownerType: 'CUSTOMER', ownerId: 'cust-1' })).expect(403);
      await env.http().post('/api/notifications/push-devices').set(actors.admin()).send(body({ ownerType: 'CUSTOMER', ownerId: 'cust-1' })).expect(403);
      expect(await env.t.prisma.pushDevice.count()).toBe(0);
    });

    it('CUSTOMER дүр зөвхөн өөрийн customerId-аар; бусдын/USER төрлөөр 403', async () => {
      const ok = await env.http().post('/api/notifications/push-devices').set(actors.customer('cust-1')).send(body({ ownerType: 'CUSTOMER', ownerId: 'cust-1', token: 'apns-token-customer-1', platform: 'IOS' })).expect(201);
      expect(PushDeviceView.parse(ok.body)).toMatchObject({ ownerType: 'CUSTOMER', ownerId: 'cust-1' });
      await env.http().post('/api/notifications/push-devices').set(actors.customer('cust-1')).send(body({ ownerType: 'CUSTOMER', ownerId: 'cust-2', token: 'apns-token-customer-2' })).expect(403);
      await env.http().post('/api/notifications/push-devices').set(actors.customer('cust-1')).send(body({ ownerType: 'USER', ownerId: 'officer-1', token: 'apns-token-customer-3' })).expect(403);
      expect(await env.t.prisma.pushDevice.count()).toBe(1);
    });

    it('зэрэгцээ ижил токен: нэг мөр, алдаагүй', async () => {
      const rs = await Promise.all(Array.from({ length: 6 }, () => env.http().post('/api/notifications/push-devices').set(actors.officer()).send(body())));
      expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await env.t.prisma.pushDevice.count()).toBe(1);
    });

    it('DELETE: эзэмшигч л (204); бусдынх/байхгүй 404; дахин устгавал 404', async () => {
      await env.http().post('/api/notifications/push-devices').set(actors.officer('officer-1')).send(body()).expect(201);
      await env.http().delete('/api/notifications/push-devices/fcm-token-officer-0001').set(actors.anonymous()).expect(401);
      const foreign = await env.http().delete('/api/notifications/push-devices/fcm-token-officer-0001').set(actors.officer('officer-2')).expect(404);
      expect(foreign.body.code).toBe('PUSH_DEVICE_NOT_FOUND');
      await env.http().delete('/api/notifications/push-devices/fcm-token-officer-0001').set(actors.customer('officer-1')).expect(404);
      expect(await env.t.prisma.pushDevice.count()).toBe(1);
      await env.http().delete('/api/notifications/push-devices/fcm-token-officer-0001').set(actors.officer('officer-1')).expect(204);
      expect(await env.t.prisma.pushDevice.count()).toBe(0);
      await env.http().delete('/api/notifications/push-devices/fcm-token-officer-0001').set(actors.officer('officer-1')).expect(404);
      await env.http().delete('/api/notifications/push-devices/short').set(actors.officer()).expect(400);
    });

    it('токен дотор ":" ба "/" encode-той бол ажиллана (FCM токен)', async () => {
      const token = 'abc123:APA91b_xyz-0123456789';
      await env.http().post('/api/notifications/push-devices').set(actors.officer()).send(body({ token })).expect(201);
      await env.http().delete(`/api/notifications/push-devices/${encodeURIComponent(token)}`).set(actors.officer()).expect(204);
    });
  });

  // ── Сувгийн тохиргоо (opt-out) ───────────────────────────────────────────────────
  describe('GET/PUT /notifications/preferences/:recipientType/:recipientId', () => {
    async function seedOwned(officerId = 'officer-1') {
      const customer = await createCustomer(env.t.prisma, { phone: '99112233', email: 'bold@example.mn' });
      const app = await createApplication(env.t.prisma, { officerId });
      await createBorrower(env.t.prisma, app.id, customer.id, 'PRIMARY');
      return customer;
    }
    const put = (who: Record<string, string>, type: string, id: string, channels: unknown) => env.http().put(`/api/notifications/preferences/${type}/${id}`).set(who).send({ channels });
    const get = (who: Record<string, string>, type: string, id: string) => env.http().get(`/api/notifications/preferences/${type}/${id}`).set(who);

    it('анхдагч: зээлдэгчид SMS/EMAIL/PUSH бүгд идэвхтэй, ажилтанд IN_APP', async () => {
      const c = await seedOwned();
      const res = NotificationPreferenceView.parse((await get(actors.admin(), 'CUSTOMER', c.id).expect(200)).body);
      expect(res).toEqual({ recipientType: 'CUSTOMER', recipientId: c.id, channels: [{ channel: 'SMS', enabled: true }, { channel: 'EMAIL', enabled: true }, { channel: 'PUSH', enabled: true }] });
      expect((await get(actors.officer('officer-1'), 'USER', 'officer-1').expect(200)).body.channels).toEqual([{ channel: 'IN_APP', enabled: true }]);
    });

    it('ADMIN болон хариуцсан ЗЭЗ зээлдэгчийн өмнөөс; PUT нь opt-out хадгалж, дараагийн notifyCustomers-д нөлөөлнө', async () => {
      const c = await seedOwned();
      const res = NotificationPreferenceView.parse((await put(actors.officer('officer-1'), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: false }]).expect(200)).body);
      expect(res.channels).toEqual([{ channel: 'SMS', enabled: false }, { channel: 'EMAIL', enabled: true }, { channel: 'PUSH', enabled: true }]);
      const r2 = await put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'EMAIL', enabled: false }, { channel: 'SMS', enabled: true }]).expect(200);
      expect(r2.body.channels).toEqual([{ channel: 'SMS', enabled: true }, { channel: 'EMAIL', enabled: false }, { channel: 'PUSH', enabled: true }]);
      expect(await env.t.prisma.notificationPreference.count()).toBe(2); // давхардахгүй
      const r = await env.service.notifyCustomers({ orgId: ORG, customerIds: [c.id], type: 'PAYMENT_DUE', payload: { contractNo: 'B' }, dedupeBase: 'pref:1' });
      expect(r.queued).toBe(1); // зөвхөн SMS (EMAIL унтраасан, PUSH төхөөрөмжгүй)
      expect(env.email.outbox).toHaveLength(0);
      expect(env.sms.outbox).toHaveLength(1);
    });

    it('CUSTOMER дүр зөвхөн өөрийнх (өөр зээлдэгч, USER 403)', async () => {
      const c = await seedOwned();
      const other = await createCustomer(env.t.prisma);
      await put(actors.customer(c.id), 'CUSTOMER', c.id, [{ channel: 'PUSH', enabled: false }]).expect(200);
      await get(actors.customer(c.id), 'CUSTOMER', c.id).expect(200);
      await put(actors.customer(c.id), 'CUSTOMER', other.id, [{ channel: 'PUSH', enabled: false }]).expect(403);
      await get(actors.customer(c.id), 'CUSTOMER', other.id).expect(403);
      await get(actors.customer(c.id), 'USER', 'officer-1').expect(403);
    });

    it('OFFICER өөрийн хариуцаагүй зээлдэгчийн, APPROVER/BRANCH_MANAGER бусдын өмнөөс өөрчилж чадахгүй (403); 401', async () => {
      const c = await seedOwned('officer-1');
      await put(actors.officer('officer-2'), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: false }]).expect(403);
      await get(actors.officer('officer-2'), 'CUSTOMER', c.id).expect(403);
      await put(actors.approver(), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: false }]).expect(403);
      await put(actors.branchManager(), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: false }]).expect(403);
      await put(actors.anonymous(), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: false }]).expect(401);
      expect(await env.t.prisma.notificationPreference.count()).toBe(0);
    });

    it('ADMIN: үл мэдэгдэх зээлдэгч 404; буруу recipientType 400', async () => {
      expect((await get(actors.admin(), 'CUSTOMER', 'no-such').expect(404)).body.code).toBe('CUSTOMER_NOT_FOUND');
      expect((await get(actors.admin(), 'ROBOT', 'x').expect(400)).body.code).toBe('VALIDATION_FAILED');
    });

    it('ажилтан (USER): зөвхөн өөрийн IN_APP; унтраавал notifyUsers алгасна; ADMIN бусдынх', async () => {
      await put(actors.officer('officer-1'), 'USER', 'officer-1', [{ channel: 'IN_APP', enabled: false }]).expect(200);
      expect((await env.service.notifyUsers({ orgId: ORG, userIds: ['officer-1', 'officer-2'], type: 'MENTION' })).created).toBe(1);
      await put(actors.officer('officer-2'), 'USER', 'officer-1', [{ channel: 'IN_APP', enabled: true }]).expect(403);
      await put(actors.admin(), 'USER', 'officer-1', [{ channel: 'IN_APP', enabled: true }]).expect(200);
      expect((await env.service.notifyUsers({ orgId: ORG, userIds: ['officer-1'], type: 'MENTION' })).created).toBe(1);
    });

    describe('байгууллагын хил (multi-tenant)', () => {
      const OTHER = 'other-org';
      const otherAdmin = () => ({ ...actors.admin('admin-x'), 'x-org-id': OTHER });

      it('өөр байгууллагын ADMIN ажилтны (USER) хонхыг унтрааж чадахгүй: мөр зөвхөн өөрийн org-д үүсч, org-test-ийн notifyUsers-д нөлөөлөхгүй', async () => {
        await put(otherAdmin(), 'USER', 'officer-1', [{ channel: 'IN_APP', enabled: false }]).expect(200);
        const rows = await env.t.prisma.notificationPreference.findMany();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ orgId: OTHER, subjectId: 'officer-1', enabled: false });
        expect((await env.service.notifyUsers({ orgId: ORG, userIds: ['officer-1'], type: 'MENTION' })).created).toBe(1); // org-test-д унтраагаагүй
        expect((await env.service.notifyUsers({ orgId: OTHER, userIds: ['officer-1'], type: 'MENTION' })).created).toBe(0); // өөрийн org-д унтраасан
      });

      it('өөр байгууллагын ADMIN org-test-ийн одоо байгаа тохиргоог дарж/уншиж чадахгүй (мөр өөрчлөгдөхгүй, GET анхдагчийг харуулна)', async () => {
        await put(actors.officer('officer-1'), 'USER', 'officer-1', [{ channel: 'IN_APP', enabled: false }]).expect(200);
        expect((await get(otherAdmin(), 'USER', 'officer-1').expect(200)).body.channels).toEqual([{ channel: 'IN_APP', enabled: true }]); // org-test-ийн унтраасан төлөв харагдахгүй
        await put(otherAdmin(), 'USER', 'officer-1', [{ channel: 'IN_APP', enabled: true }]).expect(200);
        const own = await env.t.prisma.notificationPreference.findFirstOrThrow({ where: { orgId: ORG, subjectId: 'officer-1' } });
        expect(own.enabled).toBe(false); // өөрчлөгдөөгүй
        expect((await get(actors.officer('officer-1'), 'USER', 'officer-1').expect(200)).body.channels).toEqual([{ channel: 'IN_APP', enabled: false }]);
        expect(await env.t.prisma.notificationPreference.count()).toBe(2); // org бүрд тусдаа мөр (unique-д orgId орсон)
        expect((await env.service.notifyUsers({ orgId: ORG, userIds: ['officer-1'], type: 'MENTION' })).created).toBe(0);
      });

      it('зээлдэгчийн opt-out нь org-оор хязгаарлагдана: өөр org-ийн мөр зээлдэгчийг унтраахгүй', async () => {
        const c = await seedOwned();
        await env.t.prisma.notificationPreference.create({ data: { orgId: OTHER, subjectType: 'CUSTOMER', subjectId: c.id, channel: 'SMS', enabled: false } });
        const r = await env.service.notifyCustomers({ orgId: ORG, customerIds: [c.id], type: 'PAYMENT_DUE', payload: { contractNo: 'B' }, dedupeBase: 'pref:org' });
        expect(r.queued).toBe(2); // SMS + EMAIL (өөр org-ийн SMS opt-out хамаарахгүй)
        expect((await get(actors.admin(), 'CUSTOMER', c.id).expect(200)).body.channels[0]).toEqual({ channel: 'SMS', enabled: true });
        // өөрийн org-д PUT хийхэд өөр org-ийн мөрийг хөндөхгүй (өөрийн org-д шинэ мөр үүснэ)
        await put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: true }]).expect(200);
        expect((await env.t.prisma.notificationPreference.findMany({ orderBy: { orgId: 'asc' } })).map((p) => [p.orgId, p.enabled])).toEqual([[ORG, true], [OTHER, false]]);
      });
    });

    it('хамааралгүй суваг → 400 CHANNEL_NOT_APPLICABLE; validation (хоосон жагсаалт, буруу суваг)', async () => {
      const c = await seedOwned();
      expect((await put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'IN_APP', enabled: false }]).expect(400)).body.code).toBe('CHANNEL_NOT_APPLICABLE');
      expect((await put(actors.admin(), 'USER', 'u1', [{ channel: 'SMS', enabled: false }]).expect(400)).body.code).toBe('CHANNEL_NOT_APPLICABLE');
      expect((await put(actors.admin(), 'CUSTOMER', c.id, []).expect(400)).body.code).toBe('VALIDATION_FAILED');
      await put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'FAX', enabled: false }]).expect(400);
      await put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'SMS' }]).expect(400);
    });

    it('зэрэгцээ PUT: нэг мөр/суваг, сүүлийнх давамгайлна, алдаагүй', async () => {
      const c = await seedOwned();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: i % 2 === 0 }])));
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(await env.t.prisma.notificationPreference.count()).toBe(1);
    });

    it('хүсэлт доторх давхардсан суваг: сүүлийнх', async () => {
      const c = await seedOwned();
      const res = await put(actors.admin(), 'CUSTOMER', c.id, [{ channel: 'SMS', enabled: false }, { channel: 'SMS', enabled: true }]).expect(200);
      expect(res.body.channels[0]).toEqual({ channel: 'SMS', enabled: true });
    });
  });
});
