import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { RealPushGateway } from '../../integrations/push/push.real';
import { PUSH_GATEWAY } from '../../integrations/push/push.provider';
import { RealSmsGateway } from '../../integrations/sms/sms.real';
import { SMS_GATEWAY } from '../../integrations/sms/sms.provider';
import { createCustomer, hasTestDb, ORG } from '../../test-utils/factories';
import { backoffMs, BACKOFF_BASE_MS, DEFAULT_RECORD_RETRY_DELAYS_MS, DeliveryRecordError, LEASE_MS } from './delivery.processor';
import { NotificationRuntime } from './notification.runtime';
import { bootNotification, failDeliveryUpdates, NotificationEnv, resetNotification, setSetting } from './notification.test-helpers';

describe('backoffMs', () => {
  it('30с · 2^(attempts-1)', () => {
    expect(BACKOFF_BASE_MS).toBe(30_000);
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(0)).toBe(30_000);
  });
});

describe.skipIf(!hasTestDb)('notification: DeliveryProcessor', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification({ manual: true }); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  /** QUEUED хүргэлт шууд DB-д үүсгэнэ. */
  const make = (o: Record<string, unknown> = {}) => env.t.prisma.notificationDelivery.create({
    data: {
      orgId: ORG, type: 'PAYMENT_DUE', channel: 'SMS', recipientType: 'CUSTOMER', recipientId: 'cust-1', address: '+97699112233', subject: null, body: 'Сайн байна уу',
      dedupeKey: `k:${Math.random()}`, status: 'QUEUED', nextAttemptAt: env.t.clock.now(), scheduledFor: env.t.clock.now(), ...o,
    },
  });
  const reload = (id: string) => env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });

  it('SMS: gateway-ээр илгээж SENT (providerMessageId, sentAt, attempts=1); лавлагаа = delivery.id', async () => {
    const d = await make();
    expect(await env.processor.process(d.id)).toBe('SENT');
    const r = await reload(d.id);
    expect(r).toMatchObject({ status: 'SENT', attempts: 1, providerMessageId: 'mock-sms-1', lastError: null, nextAttemptAt: null });
    expect(r.sentAt?.toISOString()).toBe('2026-10-28T02:00:00.000Z');
    expect(env.sms.outbox).toEqual([{ to: '+97699112233', text: 'Сайн байна уу', ref: d.id, providerMessageId: 'mock-sms-1' }]);
  });

  it('EMAIL: гарчиг + текст + escape хийсэн html; PUSH: гарчиг, текст, data(type, applicationId)', async () => {
    const e = await make({ channel: 'EMAIL', address: 'bold@example.mn', subject: 'Гарчиг', body: 'Сайн уу <b>Болд</b>\n\nХоёр дахь догол' });
    const p = await make({ channel: 'PUSH', address: 'token-android-0001', subject: 'Push гарчиг', body: 'Push текст', applicationId: 'app-1' });
    expect(await env.processor.process(e.id)).toBe('SENT');
    expect(await env.processor.process(p.id)).toBe('SENT');
    expect(env.email.outbox[0]).toMatchObject({ to: 'bold@example.mn', subject: 'Гарчиг', text: 'Сайн уу <b>Болд</b>\n\nХоёр дахь догол', ref: e.id });
    expect(env.email.outbox[0].html).toContain('&lt;b&gt;Болд&lt;/b&gt;');
    expect(env.email.outbox[0].html).not.toContain('<b>');
    expect(env.push.outbox[0]).toMatchObject({ token: 'token-android-0001', title: 'Push гарчиг', body: 'Push текст', data: { type: 'PAYMENT_DUE', applicationId: 'app-1' }, ref: p.id });
  });

  it('QUEUED биш (SENT/FAILED/SKIPPED) эсвэл nextAttemptAt ирээдүйд бол илгээхгүй; байхгүй ID → NOT_FOUND', async () => {
    const sent = await make({ status: 'SENT' });
    const failed = await make({ status: 'FAILED' });
    const skipped = await make({ status: 'SKIPPED' });
    const later = await make({ nextAttemptAt: new Date('2026-10-28T02:00:01Z') });
    for (const d of [sent, failed, skipped, later]) expect(await env.processor.process(d.id)).toBe('NOT_CLAIMED');
    expect(await env.processor.process('missing-id')).toBe('NOT_FOUND');
    expect(env.sms.outbox).toHaveLength(0);
    env.t.clock.advanceMs(1000);
    expect(await env.processor.process(later.id)).toBe('SENT'); // цаг болсны дараа
  });

  it('nextAttemptAt=null бол яаралтай (хүлээгдэж буй) гэж үзнэ', async () => {
    const d = await make({ nextAttemptAt: null });
    expect(await env.processor.process(d.id)).toBe('SENT');
  });

  it('retryable алдаа: attempts++, nextAttemptAt = now + 30с·2^n, queue-д delay-тэй дахин оруулна; амжилттай болтол үргэлжилнэ', async () => {
    const d = await make();
    env.sms.failNext(2, { retryable: true });
    expect(await env.processor.process(d.id)).toBe('RETRY');
    let r = await reload(d.id);
    expect(r).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'PROVIDER_ERROR' });
    expect(r.nextAttemptAt?.toISOString()).toBe('2026-10-28T02:00:30.000Z');
    expect(env.manual!.enqueued).toEqual([{ id: d.id, delayMs: 30_000 }]);

    expect(await env.processor.process(d.id)).toBe('NOT_CLAIMED'); // backoff дуустал
    env.t.clock.advanceMs(30_000);
    expect(await env.processor.process(d.id)).toBe('RETRY');
    r = await reload(d.id);
    expect(r.attempts).toBe(2);
    expect(r.nextAttemptAt?.toISOString()).toBe('2026-10-28T02:01:30.000Z'); // 02:00:30 + 60с
    expect(env.manual!.enqueued[1]).toEqual({ id: d.id, delayMs: 60_000 });

    env.t.clock.advanceMs(60_000);
    expect(await env.processor.process(d.id)).toBe('SENT');
    r = await reload(d.id);
    expect(r).toMatchObject({ status: 'SENT', attempts: 3, lastError: null, nextAttemptAt: null });
    expect(env.sms.outbox).toHaveLength(1);
  });

  it('notification.max_attempts хүрвэл FAILED (анхдагч 5; setting-ээр өөрчилнө)', async () => {
    await setSetting(env, 'notification.max_attempts', 3);
    const d = await make();
    env.sms.failNext(10, { retryable: true, code: 'RATE_LIMITED' });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) { outcomes.push(await env.processor.process(d.id)); env.t.clock.advanceMs(10 * 60_000); }
    expect(outcomes).toEqual(['RETRY', 'RETRY', 'FAILED']);
    expect(await reload(d.id)).toMatchObject({ status: 'FAILED', attempts: 3, lastError: 'RATE_LIMITED', nextAttemptAt: null });
    expect(await env.processor.process(d.id)).toBe('NOT_CLAIMED'); // FAILED-ийг дахин оролдохгүй
    expect(env.sms.outbox).toHaveLength(0);
  });

  it('анхдагч max_attempts = 5', async () => {
    const d = await make();
    env.sms.failNext(10, { retryable: true });
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) { outcomes.push(await env.processor.process(d.id)); env.t.clock.advanceMs(60 * 60_000); }
    expect(outcomes).toEqual(['RETRY', 'RETRY', 'RETRY', 'RETRY', 'FAILED']);
    expect((await reload(d.id)).attempts).toBe(5);
  });

  it('non-retryable алдаа → шууд FAILED (дахин оруулахгүй)', async () => {
    const d = await make();
    env.sms.failNext(1, { retryable: false });
    expect(await env.processor.process(d.id)).toBe('FAILED');
    expect(await reload(d.id)).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'INVALID_ADDRESS', nextAttemptAt: null });
    expect(env.manual!.enqueued).toHaveLength(0);
  });

  it('PUSH INVALID_TOKEN → PushDevice.isActive=false + delivery SKIPPED (бусад төхөөрөмж хэвээр)', async () => {
    const dev = await env.t.prisma.pushDevice.create({ data: { orgId: ORG, ownerType: 'CUSTOMER', ownerId: 'cust-1', token: 'token-stale-0001', platform: 'IOS' } });
    const other = await env.t.prisma.pushDevice.create({ data: { orgId: ORG, ownerType: 'CUSTOMER', ownerId: 'cust-1', token: 'token-good-00001', platform: 'IOS' } });
    env.push.invalidateToken('token-stale-0001');
    const d = await make({ channel: 'PUSH', address: 'token-stale-0001', subject: 'T' });
    expect(await env.processor.process(d.id)).toBe('SKIPPED');
    expect(await reload(d.id)).toMatchObject({ status: 'SKIPPED', lastError: 'INVALID_TOKEN', attempts: 1, nextAttemptAt: null });
    expect((await env.t.prisma.pushDevice.findUniqueOrThrow({ where: { id: dev.id } })).isActive).toBe(false);
    expect((await env.t.prisma.pushDevice.findUniqueOrThrow({ where: { id: other.id } })).isActive).toBe(true);
  });

  it('зэрэг (Promise.all) боловсруулахад gateway нэг л удаа дуудагдана', async () => {
    const d = await make();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => env.processor.process(d.id)));
    expect(outcomes.filter((o) => o === 'SENT')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'NOT_CLAIMED')).toHaveLength(7);
    expect(env.sms.outbox).toHaveLength(1);
    expect((await reload(d.id)).attempts).toBe(1);
  });

  it('lease: claim хийсэн worker унавал LEASE_MS-ээс хойш дахин боловсруулагдана (тэр хүртэл түгжигдсэн)', async () => {
    const d = await make();
    // claim-ийг дуурайх: processor илгээхээс өмнө унасан
    await env.t.prisma.notificationDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(env.t.clock.now().getTime() + LEASE_MS) } });
    expect(await env.processor.process(d.id)).toBe('NOT_CLAIMED');
    env.t.clock.advanceMs(LEASE_MS);
    expect(await env.processor.process(d.id)).toBe('SENT');
  });

  it('gateway-н тодорхойгүй алдаа (ChannelError биш) → retryable PROVIDER_ERROR; лог/lastError-д хаяг орохгүй', async () => {
    const d = await make();
    vi.spyOn(env.sms, 'send').mockRejectedValueOnce(new Error('boom +97699112233'));
    expect(await env.processor.process(d.id)).toBe('RETRY');
    const r = await reload(d.id);
    expect(r.lastError).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(r)).not.toContain('boom');
  });

  describe('SENT бичилт унавал (gateway-ээр илгээгдсэн ДАРАА DB-ийн түр алдаа)', () => {
    const isSentWrite = (a: { data?: { status?: string } }) => a.data?.status === 'SENT';
    beforeEach(() => { env.processor.recordRetryDelaysMs = [0, 0]; }); // тестэд хүлээлгүй
    afterEach(() => { env.processor.recordRetryDelaysMs = DEFAULT_RECORD_RETRY_DELAYS_MS; });

    it('түр алдаа: SENT бичилтийг дахин оролдоно — gateway-н retry биш, мессеж ДАХИН явахгүй', async () => {
      const d = await make();
      const db = failDeliveryUpdates(env, isSentWrite, 1); // эхний SENT бичилт унана
      try {
        expect(await env.processor.process(d.id)).toBe('SENT');
      } finally { db.restore(); }
      expect(db.state).toEqual({ calls: 2, failed: 1 });
      expect(await reload(d.id)).toMatchObject({ status: 'SENT', attempts: 1, providerMessageId: 'mock-sms-1', lastError: null, nextAttemptAt: null });
      expect(env.manual!.enqueued).toHaveLength(0); // RETRY/backoff үүсээгүй
      env.t.clock.advanceMs(10 * 60_000);
      expect(await env.processor.process(d.id)).toBe('NOT_CLAIMED');
      expect(await env.processor.sweep()).toBe(0);
      expect(env.sms.outbox).toHaveLength(1); // нэг ref-тэй ганц мессеж
    });

    it('бүх оролдлого унавал DeliveryRecordError шиднэ (PROVIDER_ERROR/backoff биш); lease дууссаны дараа ДАХИН ИЛГЭЭЛГҮЙ SENT болгоно', async () => {
      const d = await make({ channel: 'EMAIL', address: 'bold@example.mn', subject: 'Гарчиг', body: 'Текст' });
      const logged: string[] = [];
      vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => { logged.push(String(m)); });
      const db = failDeliveryUpdates(env, isSentWrite);
      try {
        const err = await env.processor.process(d.id).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(DeliveryRecordError);
        expect(err).toMatchObject({ deliveryId: d.id, providerMessageId: 'mock-email-1' });
      } finally { db.restore(); }
      expect(db.state.failed).toBe(3); // 1 + 2 дахин оролдлого
      // Мөр өөрчлөгдөөгүй: QUEUED, lease-тэй, gateway-н алдаа гэж тооцогдоогүй
      const r1 = await reload(d.id);
      expect(r1).toMatchObject({ status: 'QUEUED', attempts: 0, lastError: null });
      expect(r1.nextAttemptAt?.toISOString()).toBe('2026-10-28T02:02:00.000Z');
      expect(env.email.outbox).toHaveLength(1);
      expect(env.manual!.enqueued).toHaveLength(0);
      // Лог: delivery ID + providerMessageId байна, хаяг/текст байхгүй
      const text = logged.join('\n');
      expect(text).toContain(d.id);
      expect(text).toContain('mock-email-1');
      expect(text).not.toContain('bold@example.mn');
      expect(text).not.toContain('Текст');

      expect(await env.processor.process(d.id)).toBe('NOT_CLAIMED'); // lease
      env.t.clock.advanceMs(LEASE_MS);
      expect(await env.processor.sweep()).toBe(1); // дахин боловсруулахаар queue-д
      await env.manual!.flush();
      expect(await reload(d.id)).toMatchObject({ status: 'SENT', attempts: 1, providerMessageId: 'mock-email-1', lastError: null, nextAttemptAt: null });
      expect(env.email.outbox).toHaveLength(1); // давхар имэйл явсангүй
    });

    it('SENT бичилт унасан нь gateway-н алдаа бус: attempts/backoff өөрчлөгдөхгүй, max_attempts-д тооцогдохгүй', async () => {
      await setSetting(env, 'notification.max_attempts', 1);
      const d = await make();
      env.processor.recordRetryDelaysMs = []; // дахин оролдлогогүй
      const db = failDeliveryUpdates(env, isSentWrite, 1);
      try { await expect(env.processor.process(d.id)).rejects.toBeInstanceOf(DeliveryRecordError); }
      finally { db.restore(); }
      expect((await reload(d.id)).status).toBe('QUEUED'); // max_attempts=1 хэдий ч FAILED болоогүй
      env.t.clock.advanceMs(LEASE_MS);
      expect(await env.processor.process(d.id)).toBe('SENT');
      expect(env.sms.outbox).toHaveLength(1);
    });

    it('gateway алдаа + дараах DB алдаа: мессеж явээгүй тул lease-ийн дараа дахин илгээнэ (хэвийн retry)', async () => {
      const d = await make();
      env.sms.failNext(1, { retryable: true });
      const db = failDeliveryUpdates(env, (a) => a.data?.status === 'QUEUED', 1); // backoff бичилт унана
      try { await expect(env.processor.process(d.id)).rejects.toThrow(/connection reset/); } finally { db.restore(); }
      expect(env.sms.outbox).toHaveLength(0);
      env.t.clock.advanceMs(LEASE_MS);
      expect(await env.processor.process(d.id)).toBe('SENT');
      expect(env.sms.outbox).toHaveLength(1);
    });
  });

  describe('sweep()', () => {
    it('queue-д алдагдсан QUEUED мөрийг дахин оруулна; SENT/ирээдүйн/lease-тэйг оруулахгүй', async () => {
      const stuck = await make({ nextAttemptAt: new Date('2026-10-28T01:00:00Z') });
      const nullNext = await make({ nextAttemptAt: null });
      await make({ status: 'SENT' });
      await make({ nextAttemptAt: new Date('2026-10-28T03:00:00Z') });
      expect(await env.processor.sweep()).toBe(2);
      expect(env.manual!.enqueued.map((e) => e.id).sort()).toEqual([stuck.id, nullNext.id].sort());
      await env.manual!.flush();
      expect(env.sms.outbox).toHaveLength(2);
      expect(await env.processor.sweep()).toBe(0);
    });

    it('grace: queue-ийн sweepGraceMs-ээс шинэ мөрийг хөндөхгүй (queue-д байгаа гэж үзнэ)', async () => {
      env.manual!.sweepGraceMs = 120_000;
      try {
        await make({ nextAttemptAt: new Date(env.t.clock.now().getTime() - 60_000) });
        const old = await make({ nextAttemptAt: new Date(env.t.clock.now().getTime() - 180_000) });
        expect(await env.processor.sweep()).toBe(1);
        expect(env.manual!.enqueued.map((e) => e.id)).toEqual([old.id]);
      } finally { env.manual!.sweepGraceMs = 0; }
    });

    it('NotificationRuntime.sweepOnce: sweep-ийг ажиллуулна, алдаа гарвал залгиж 0 буцаана; зэрэг давхар ажиллахгүй', async () => {
      const runtime = env.t.app.get(NotificationRuntime);
      await make({ nextAttemptAt: new Date('2026-10-28T01:00:00Z') });
      expect(await runtime.sweepOnce()).toBe(1);
      vi.spyOn(env.processor, 'sweep').mockRejectedValueOnce(new Error('DB унтарсан'));
      expect(await runtime.sweepOnce()).toBe(0);
      let release!: () => void;
      vi.spyOn(env.processor, 'sweep').mockImplementationOnce(() => new Promise<number>((resolve) => { release = () => resolve(7); }));
      const first = runtime.sweepOnce();
      expect(await runtime.sweepOnce()).toBe(0); // өмнөх нь дуусаагүй
      release();
      expect(await first).toBe(7);
    });

    it('queue хүрэхгүй бол эхний алдаанаар зогсоно (үлдсэнийг timeout хүртэл хүлээхгүй); мөр QUEUED үлдэж дараагийн sweep авна', async () => {
      for (let i = 0; i < 3; i++) await make({ nextAttemptAt: new Date('2026-10-28T01:00:00Z') });
      const enqueue = vi.spyOn(env.manual!, 'enqueue').mockRejectedValue(new Error('Redis унтарсан'));
      expect(await env.processor.sweep()).toBe(0);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(await env.t.prisma.notificationDelivery.count({ where: { status: 'QUEUED' } })).toBe(3);
      enqueue.mockRestore();
      expect(await env.processor.sweep()).toBe(3);
    });

    it('limit-тэй', async () => {
      for (let i = 0; i < 5; i++) await make({ nextAttemptAt: new Date('2026-10-28T01:00:00Z') });
      expect(await env.processor.sweep(3)).toBe(3);
    });
  });
});

describe.skipIf(!hasTestDb)('notification: Real gateway (тохиргоогүй / хэрэгжээгүй) → FAILED, дахин оролдохгүй', () => {
  let env: NotificationEnv;
  beforeAll(async () => {
    env = await bootNotification({
      manual: true,
      customize: (b) => b.overrideProvider(SMS_GATEWAY).useValue(new RealSmsGateway({})).overrideProvider(PUSH_GATEWAY).useValue(new RealPushGateway({ FCM_PROJECT_ID: 'p', FCM_SERVICE_ACCOUNT_JSON: '{}' })),
    });
  });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  const make = (o: Record<string, unknown>) => env.t.prisma.notificationDelivery.create({
    data: { orgId: ORG, type: 'PAYMENT_DUE', channel: 'SMS', recipientType: 'CUSTOMER', recipientId: 'c', address: '+97699112233', body: 'x', dedupeKey: `k:${Math.random()}`, status: 'QUEUED', nextAttemptAt: env.t.clock.now(), ...o },
  });

  it('SMS тохиргоогүй → NOT_CONFIGURED; Push тохиргоотой боловч хэрэгжээгүй → NOT_IMPLEMENTED', async () => {
    const sms = await make({});
    const push = await make({ channel: 'PUSH', address: 'token-android-0001', subject: 'T' });
    expect(await env.processor.process(sms.id)).toBe('FAILED');
    expect(await env.processor.process(push.id)).toBe('FAILED');
    expect(await env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: sms.id } })).toMatchObject({ status: 'FAILED', lastError: 'NOT_CONFIGURED', attempts: 1 });
    expect(await env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: push.id } })).toMatchObject({ status: 'FAILED', lastError: 'NOT_IMPLEMENTED', attempts: 1 });
    expect(env.manual!.enqueued).toHaveLength(0);
    expect(new IntegrationNotConfiguredError('sms', ['X']).message).toMatch(/тохируулаагүй/);
  });
});

describe.skipIf(!hasTestDb)('notification: inline queue — нэг алхамд хүргэнэ', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  it('notifyCustomers → шууд SENT (inline), нэг амжилтгүй retryable нь QUEUED үлдэж sweep/цагаар дахин илгээгдэнэ', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99112233', email: 'bold@example.mn' });
    env.sms.failNext(1, { retryable: true });
    const res = await env.service.notifyCustomers({ orgId: ORG, customerIds: [c.id], type: 'PAYMENT_RECEIVED', payload: { contractNo: 'BZ-1', amount: 50_000, currency: 'MNT' }, dedupeBase: 'inline:1' });
    expect(res.queued).toBe(2);
    expect(env.email.outbox).toHaveLength(1);
    expect(env.sms.outbox).toHaveLength(0);
    const sms = await env.t.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'SMS' } });
    expect(sms).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(await env.processor.sweep()).toBe(0); // backoff дуустал хүрэхгүй
    env.t.clock.advanceMs(31_000);
    expect(await env.processor.sweep()).toBe(1); // inline-д grace=0 → цаг болсон даруй
    expect(env.sms.outbox).toHaveLength(1);
    expect((await env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: sms.id } })).status).toBe('SENT');
  });
});
