import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApplication, createCustomer, hasTestDb, ORG } from '../../test-utils/factories';
import { bootNotification, deliveries, NotificationEnv, resetNotification, setSetting } from './notification.test-helpers';

describe.skipIf(!hasTestDb)('notification: notifyCustomers (SMS / Email / Push)', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification({ manual: true }); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  const payload = { applicationNo: 'APP-1', contractNo: 'BZ-1', amount: 1_500_000, currency: 'MNT', dueDate: '2026-11-03', daysOverdue: 0 };
  const notify = (customerIds: string[], o: Record<string, unknown> = {}) =>
    env.service.notifyCustomers({ orgId: ORG, customerIds, type: 'PAYMENT_DUE', payload, dedupeBase: 'test:1', ...o });
  const addDevice = (ownerId: string, token: string, o: Record<string, unknown> = {}) =>
    env.t.prisma.pushDevice.create({ data: { orgId: ORG, ownerType: 'CUSTOMER', ownerId, token, platform: 'ANDROID', ...o } });

  it('утас + имэйл + идэвхтэй төхөөрөмжтэй зээлдэгчид 3 суваг (QUEUED), dedupeKey = base:customer:channel (PUSH-д :deviceId)', async () => {
    const app = await createApplication(env.t.prisma, { branchId: 'branch-7' });
    const c = await createCustomer(env.t.prisma, { firstName: 'Болд', phone: '9911-2233', email: 'bold@example.mn' });
    const device = await addDevice(c.id, 'token-android-0001');
    const res = await notify([c.id], { applicationId: app.id });
    expect(res).toMatchObject({ queued: 3, skipped: 0, duplicates: 0 });
    expect(res.deliveryIds).toHaveLength(3);
    expect(env.manual!.enqueued.map((e) => e.id).sort()).toEqual([...res.deliveryIds].sort()); // tx-гүй → автоматаар queue-д

    const rows = await deliveries(env);
    expect(rows.map((r) => [r.channel, r.dedupeKey])).toEqual([
      ['EMAIL', `test:1:${c.id}:EMAIL`], ['PUSH', `test:1:${c.id}:PUSH:${device.id}`], ['SMS', `test:1:${c.id}:SMS`],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ orgId: ORG, type: 'PAYMENT_DUE', recipientType: 'CUSTOMER', recipientId: c.id, applicationId: app.id, branchId: 'branch-7', status: 'QUEUED', attempts: 0, lastError: null });
      expect(r.nextAttemptAt?.toISOString()).toBe('2026-10-28T02:00:00.000Z');
      expect(r.payloadJson).toEqual(payload);
    }
    const sms = rows.find((r) => r.channel === 'SMS')!;
    expect(sms.address).toBe('+97699112233'); // E.164 нормчилсон
    expect(sms.subject).toBeNull();
    expect(sms.body).toBe('Болд, таны BZ-1 зээлийн 1,500,000 MNT төлбөрийн хугацаа 2026-11-03.');
    const email = rows.find((r) => r.channel === 'EMAIL')!;
    expect(email).toMatchObject({ address: 'bold@example.mn', subject: 'Зээлийн төлбөр төлөх хугацаа ойртлоо' });
    expect(email.body).toContain('Сайн байна уу, Болд.');
    expect(rows.find((r) => r.channel === 'PUSH')).toMatchObject({ address: 'token-android-0001', subject: 'Төлбөр төлөх хугацаа' });
  });

  it('суваг тус бүр холбоо барих мэдээлэл байгаа үед л: утас/имэйл/төхөөрөмжгүй бол мөр үүсэхгүй; идэвхгүй төхөөрөмж тооцохгүй', async () => {
    const onlyPhone = await createCustomer(env.t.prisma, { phone: '99110001', email: null });
    const onlyEmail = await createCustomer(env.t.prisma, { phone: null, email: 'a@example.mn' });
    const nothing = await createCustomer(env.t.prisma, { phone: '  ', email: '' });
    const inactive = await createCustomer(env.t.prisma, { phone: null, email: null });
    await addDevice(inactive.id, 'token-inactive-01', { isActive: false });
    const res = await notify([onlyPhone.id, onlyEmail.id, nothing.id, inactive.id]);
    expect(res.queued).toBe(2);
    expect((await deliveries(env)).map((r) => `${r.recipientId === onlyPhone.id ? 'phone' : 'email'}:${r.channel}`).sort()).toEqual(['email:EMAIL', 'phone:SMS']);
  });

  it('setting notification.channels_customer ∩ суваг: зөвхөн SMS идэвхтэй бол SMS л', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110002', email: 'b@example.mn' });
    await addDevice(c.id, 'token-android-0002');
    await setSetting(env, 'notification.channels_customer', ['SMS']);
    expect((await notify([c.id])).queued).toBe(1);
    expect((await deliveries(env)).map((r) => r.channel)).toEqual(['SMS']);
    await setSetting(env, 'notification.channels_customer', []);
    expect(await notify([c.id], { dedupeBase: 'test:2' })).toMatchObject({ queued: 0, deliveryIds: [] });
  });

  it('setting эвдэрсэн (массив биш) бол анхдагч суваг (SMS, EMAIL, PUSH)', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110013', email: 'x@example.mn' });
    await setSetting(env, 'notification.channels_customer', 'SMS');
    expect((await notify([c.id])).queued).toBe(2);
  });

  it('queue-д оруулахад алдаа гарвал notifyCustomers амжилттай (QUEUED мөр DB-д үлдэж sweep нөхнө)', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110014', email: null });
    vi.spyOn(env.manual!, 'enqueue').mockRejectedValueOnce(new Error('Redis унтарсан'));
    const res = await notify([c.id]);
    expect(res.queued).toBe(1);
    expect((await deliveries(env))[0].status).toBe('QUEUED');
    expect(await env.processor.sweep()).toBe(1);
  });

  it('opt-out (NotificationPreference enabled=false) суваг алгасагдана; өөр хүн/суваг нөлөөлөхгүй', async () => {
    const a = await createCustomer(env.t.prisma, { phone: '99110003', email: 'a@example.mn' });
    const b = await createCustomer(env.t.prisma, { phone: '99110004', email: 'b@example.mn' });
    await env.t.prisma.notificationPreference.createMany({ data: [{ orgId: ORG, subjectType: 'CUSTOMER', subjectId: a.id, channel: 'SMS', enabled: false }, { orgId: ORG, subjectType: 'CUSTOMER', subjectId: b.id, channel: 'SMS', enabled: true }] });
    expect((await notify([a.id, b.id])).queued).toBe(3);
    expect((await deliveries(env)).map((r) => `${r.recipientId === a.id ? 'a' : 'b'}:${r.channel}`).sort()).toEqual(['a:EMAIL', 'b:EMAIL', 'b:SMS']);
  });

  it('буруу утас/имэйл → SKIPPED + lastError=INVALID_ADDRESS (алдаа шидэхгүй, queue-д орохгүй)', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '12345', email: 'not-an-email' });
    const res = await notify([c.id]);
    expect(res).toMatchObject({ queued: 0, skipped: 2, duplicates: 0, deliveryIds: [] });
    const rows = await deliveries(env);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ status: 'SKIPPED', lastError: 'INVALID_ADDRESS', nextAttemptAt: null, attempts: 0 });
    expect(env.manual!.enqueued).toHaveLength(0);
    expect(env.sms.outbox).toHaveLength(0);
  });

  it('давхардал: ижил dedupeBase-тэй дахин дуудахад шинэ мөр үүсэхгүй, duplicates тоологдоно; өөр base-тэй бол шинэ', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110005', email: 'c@example.mn' });
    expect(await notify([c.id])).toMatchObject({ queued: 2, duplicates: 0 });
    env.manual!.reset();
    expect(await notify([c.id])).toMatchObject({ queued: 0, skipped: 0, duplicates: 2, deliveryIds: [] });
    expect(env.manual!.enqueued).toHaveLength(0);
    expect(await env.t.prisma.notificationDelivery.count()).toBe(2);
    expect(await notify([c.id], { dedupeBase: 'test:other' })).toMatchObject({ queued: 2, duplicates: 0 });
    expect(await env.t.prisma.notificationDelivery.count()).toBe(4);
  });

  it('зэрэгцээ (Promise.all) ижил хүсэлт: нийт мөр давхардахгүй, queued нийлбэр = бодит мөр', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110006', email: 'd@example.mn' });
    const results = await Promise.all(Array.from({ length: 6 }, () => notify([c.id])));
    expect(await env.t.prisma.notificationDelivery.count()).toBe(2);
    expect(results.reduce((s, r) => s + r.queued, 0)).toBe(2);
    expect(results.reduce((s, r) => s + r.duplicates, 0)).toBe(10);
    expect(env.manual!.enqueued).toHaveLength(2);
  });

  it('олон төхөөрөмж: төхөөрөмж бүр өөрийн :deviceId түлхүүртэй; дээд тал нь 3 (хамгийн хуучин хасагдана)', async () => {
    const c = await createCustomer(env.t.prisma, { phone: null, email: null });
    const old = await addDevice(c.id, 'token-old-device-1', { lastSeenAt: new Date('2026-10-01T00:00:00Z') });
    const fresh = await addDevice(c.id, 'token-new-device-1', { lastSeenAt: new Date('2026-10-27T00:00:00Z') });
    const mid = await addDevice(c.id, 'token-mid-device-1', { lastSeenAt: new Date('2026-10-15T00:00:00Z') });
    await addDevice(c.id, 'token-4th-device-1', { lastSeenAt: new Date('2026-09-01T00:00:00Z') });
    expect((await notify([c.id])).queued).toBe(3);
    const byAddress = new Map((await deliveries(env)).map((r) => [r.address, r.dedupeKey]));
    expect([...byAddress.keys()].sort()).toEqual(['token-mid-device-1', 'token-new-device-1', 'token-old-device-1']);
    expect(byAddress.get('token-new-device-1')).toBe(`test:1:${c.id}:PUSH:${fresh.id}`);
    expect(byAddress.get('token-mid-device-1')).toBe(`test:1:${c.id}:PUSH:${mid.id}`);
    expect(byAddress.get('token-old-device-1')).toBe(`test:1:${c.id}:PUSH:${old.id}`);
  });

  describe('push dedupeKey төхөөрөмж бүрд тогтвортой (эрэмбээс хамаарахгүй)', () => {
    it('lastSeenAt-ийн эрэмбэ өөрчлөгдөөд ижил dedupeBase-ээр дахин ажиллуулахад давхар push явахгүй', async () => {
      const c = await createCustomer(env.t.prisma, { phone: null, email: null });
      const a = await addDevice(c.id, 'token-device-A-01', { lastSeenAt: new Date('2026-10-28T01:00:00Z') });
      const b = await addDevice(c.id, 'token-device-B-01', { lastSeenAt: new Date('2026-10-27T01:00:00Z') });
      expect(await notify([c.id])).toMatchObject({ queued: 2, duplicates: 0 });
      // B дахин харагдлаа → одоо хамгийн сүүлийнх нь B (өмнө нь A байсан)
      await env.t.prisma.pushDevice.update({ where: { id: b.id }, data: { lastSeenAt: new Date('2026-10-28T02:00:00Z') } });
      expect(await notify([c.id])).toMatchObject({ queued: 0, duplicates: 2, deliveryIds: [] });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(2);
      expect((await deliveries(env)).map((r) => r.dedupeKey).sort()).toEqual([`test:1:${c.id}:PUSH:${a.id}`, `test:1:${c.id}:PUSH:${b.id}`].sort());
    });

    it('идэвхгүй болсон төхөөрөмжийн түлхүүрийг шинэ төхөөрөмж өвлөхгүй: шинэ төхөөрөмж ижил dedupeBase-д ч сануулга авна', async () => {
      const c = await createCustomer(env.t.prisma, { phone: null, email: null });
      await addDevice(c.id, 'token-device-A-01', { lastSeenAt: new Date('2026-10-28T01:00:00Z') });
      expect(await notify([c.id])).toMatchObject({ queued: 1 });
      env.push.invalidateToken('token-device-A-01');
      await env.manual!.flush(); // INVALID_TOKEN → SKIPPED, төхөөрөмж идэвхгүй
      expect((await deliveries(env))[0]).toMatchObject({ status: 'SKIPPED', lastError: 'INVALID_TOKEN' });

      const b = await addDevice(c.id, 'token-device-B-01', { lastSeenAt: new Date('2026-10-28T02:00:00Z') });
      const res = await notify([c.id]); // ижил dedupeBase
      expect(res).toMatchObject({ queued: 1, duplicates: 0 });
      const row = await env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: res.deliveryIds[0] } });
      expect(row).toMatchObject({ address: 'token-device-B-01', status: 'QUEUED', dedupeKey: `test:1:${c.id}:PUSH:${b.id}` });
      await env.manual!.flush();
      expect(env.push.outbox.map((m) => m.token)).toEqual(['token-device-B-01']);
    });

    it('SMS/EMAIL-ийн түлхүүр өөрчлөгдөөгүй (суффиксгүй)', async () => {
      const c = await createCustomer(env.t.prisma, { phone: '99110021', email: 'k@example.mn' });
      await notify([c.id]);
      expect((await deliveries(env)).map((r) => r.dedupeKey)).toEqual([`test:1:${c.id}:EMAIL`, `test:1:${c.id}:SMS`]);
    });
  });

  it('queue хүрэхгүй бол dispatch эхний алдаанаар зогсоно (үлдсэнийг оролдохгүй), notifyCustomers амжилттай; QUEUED мөр үлдэж sweep нөхнө', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110022', email: 'q@example.mn' });
    await addDevice(c.id, 'token-android-0003');
    const enqueue = vi.spyOn(env.manual!, 'enqueue').mockRejectedValue(new Error('Redis унтарсан'));
    const res = await notify([c.id]);
    expect(res.queued).toBe(3);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await env.t.prisma.notificationDelivery.count({ where: { status: 'QUEUED' } })).toBe(3);
    enqueue.mockRestore();
    expect(await env.processor.sweep()).toBe(3);
  });

  it('үл мэдэгдэх зээлдэгч, хоосон жагсаалт, өөр байгууллагын зээлдэгч → алдаагүй, мөр үүсэхгүй', async () => {
    const foreign = await createCustomer(env.t.prisma, { orgId: 'other-org', phone: '99110007' });
    expect(await notify(['no-such-customer', foreign.id])).toMatchObject({ queued: 0, deliveryIds: [] });
    expect(await notify([])).toMatchObject({ queued: 0 });
    expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
  });

  it('dryRun: юу ч бичихгүй, дараа нь үнэхээр ажиллуулсан тоотой таарна', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110008', email: 'e@example.mn' });
    expect(await notify([c.id], { dryRun: true })).toMatchObject({ queued: 2, duplicates: 0, deliveryIds: [] });
    expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
    expect(env.manual!.enqueued).toHaveLength(0);
    expect(await notify([c.id])).toMatchObject({ queued: 2 });
    expect(await notify([c.id], { dryRun: true })).toMatchObject({ queued: 0, duplicates: 2 });
  });

  it('tx-тэй: дуудагч commit хийх хүртэл queue-д оруулахгүй; rollback бол мөр үлдэхгүй; commit-ийн дараа dispatch', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99110009', email: null });
    await expect(env.t.prisma.$transaction(async (tx) => {
      expect((await env.service.notifyCustomers({ orgId: ORG, customerIds: [c.id], type: 'PAYMENT_DUE', payload, dedupeBase: 'tx:1' }, tx)).queued).toBe(1);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
    expect(env.manual!.enqueued).toHaveLength(0);

    const res = await env.t.prisma.$transaction((tx) => env.service.notifyCustomers({ orgId: ORG, customerIds: [c.id], type: 'PAYMENT_DUE', payload, dedupeBase: 'tx:2' }, tx));
    expect(res.queued).toBe(1);
    expect(env.manual!.enqueued).toHaveLength(0);
    await env.service.dispatch(res.deliveryIds);
    expect(env.manual!.enqueued.map((e) => e.id)).toEqual(res.deliveryIds);
  });

  it('админы override загвар (идэвхтэй) давамгайлна; идэвхгүй бол кодонд суулгасан', async () => {
    const c = await createCustomer(env.t.prisma, { firstName: 'Сараа', phone: '99110010', email: null });
    await env.t.prisma.notificationTemplate.create({ data: { orgId: ORG, type: 'PAYMENT_DUE', channel: 'SMS', locale: 'mn', body: '{{borrowerName}}: {{amount}}{{currency}} {{dueDate}} <b>{{hack}}</b>', isActive: true } });
    await notify([c.id]);
    expect((await deliveries(env))[0].body).toBe('Сараа: 1,500,000MNT 2026-11-03 <b></b>');
    await env.t.prisma.notificationTemplate.updateMany({ data: { isActive: false } });
    await notify([c.id], { dedupeBase: 'test:2' });
    expect((await deliveries(env, { dedupeKey: `test:2:${c.id}:SMS` }))[0].body).toBe('Сараа, таны BZ-1 зээлийн 1,500,000 MNT төлбөрийн хугацаа 2026-11-03.');
  });

  it('хамтран зээлдэгч бүр өөрийн нэрээр; зээлдэгчийн нэр payload-д хадгалагдахгүй', async () => {
    const a = await createCustomer(env.t.prisma, { firstName: 'Ану', phone: '99110011', email: null });
    const b = await createCustomer(env.t.prisma, { firstName: 'Бат', phone: '99110012', email: null });
    await notify([a.id, b.id]);
    const rows = await deliveries(env);
    expect(rows.find((r) => r.recipientId === a.id)!.body.startsWith('Ану,')).toBe(true);
    expect(rows.find((r) => r.recipientId === b.id)!.body.startsWith('Бат,')).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.payloadJson))).not.toMatch(/Ану|Бат/);
  });
});
