import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '@los/calc';
import { createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { MockSmsGateway } from '../../integrations/sms/sms.mock';
import { SMS_GATEWAY } from '../../integrations/sms/sms.provider';
import { NotificationModule } from './notification.module';
import { NotificationService } from './notification.service';
import { NotificationRuntime } from './notification.runtime';
import { bootNotification, NotificationEnv, publish, resetNotification } from './notification.test-helpers';
import {
  BullMqNotificationQueue, createNotificationQueue, DEFAULT_ENQUEUE_TIMEOUT_MS, DEFAULT_REMINDER_CRON, InlineNotificationQueue, NOTIFICATION_QUEUE, QueueUnavailableError, REMINDER_SCHEDULER_ID,
  redisConnectionFromUrl,
} from './notification.queue';

const REDIS_URL = process.env.REDIS_URL;

async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: хугацаа дууслаа');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('redisConnectionFromUrl', () => {
  it('host, port, db, auth, tls', () => {
    expect(redisConnectionFromUrl('redis://127.0.0.1:6379/3')).toEqual({ host: '127.0.0.1', port: 6379, db: 3 });
    expect(redisConnectionFromUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379, db: 0 });
    expect(redisConnectionFromUrl('rediss://user:p%40ss@redis.example.mn:6380/1')).toEqual({ host: 'redis.example.mn', port: 6380, username: 'user', password: 'p@ss', db: 1, tls: {} });
    expect(redisConnectionFromUrl('redis://:secret@h:1/abc')).toMatchObject({ password: 'secret', db: 0 });
  });
});

describe('createNotificationQueue', () => {
  it('REDIS_URL байхгүй бол inline', () => expect(createNotificationQueue({})).toBeInstanceOf(InlineNotificationQueue));
  it('NOTIFICATION_QUEUE=inline бол REDIS_URL байсан ч inline', () => expect(createNotificationQueue({ REDIS_URL: 'redis://127.0.0.1:6379/3', NOTIFICATION_QUEUE: 'inline' })).toBeInstanceOf(InlineNotificationQueue));
  it.skipIf(!REDIS_URL)('REDIS_URL байвал BullMQ', async () => {
    const q = createNotificationQueue({ REDIS_URL, NOTIFICATION_QUEUE_PREFIX: `los-test-${randomUUID()}` });
    expect(q).toBeInstanceOf(BullMqNotificationQueue);
    expect(q.mode).toBe('bullmq');
    await q.close();
  });
});

describe('InlineNotificationQueue', () => {
  it('delay=0 бол боловсруулагчийг шууд дуудна; delay>0 бол юу ч хийхгүй (sweep авна); боловсруулагч алдаа шидвэл залгина', async () => {
    const q = new InlineNotificationQueue();
    const deliver = vi.fn().mockResolvedValue(undefined);
    await q.enqueue('before-start'); // start-аас өмнө — алгасна
    await q.start({ deliver, runReminders: vi.fn() });
    await q.enqueue('d-1');
    await q.enqueue('d-2', 30_000);
    expect(deliver.mock.calls).toEqual([['d-1']]);
    deliver.mockRejectedValueOnce(new Error('DB унтарсан'));
    await expect(q.enqueue('d-3')).resolves.toBeUndefined();
    await q.close();
    await q.enqueue('d-4');
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(q.sweepGraceMs).toBe(0);
  });
});

describe.skipIf(!REDIS_URL)('BullMqNotificationQueue (бодит Redis)', () => {
  const prefix = `los-test-${randomUUID()}`;
  let queue: BullMqNotificationQueue;
  const make = (cron?: string) => new BullMqNotificationQueue({ connection: redisConnectionFromUrl(REDIS_URL!), prefix, queueName: 'notification-delivery-test', reminderCron: cron });
  afterEach(async () => { await queue?.raw.obliterate({ force: true }).catch(() => undefined); await queue?.close(); });

  it('enqueue → worker боловсруулагчийг дуудна; delay-тэй job хожим; attempts=1 (BullMQ өөрөө дахин оролдохгүй)', async () => {
    queue = make();
    const seen: string[] = [];
    await queue.start({ deliver: async (id) => { seen.push(id); }, runReminders: async () => undefined });
    await queue.enqueue('d-now');
    await waitFor(async () => seen.includes('d-now'));
    await queue.enqueue('d-later', 700);
    expect((await queue.raw.getDelayed()).filter((j) => j.name === 'deliver')).toHaveLength(1); // + cron scheduler-ийн дараагийн job
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).not.toContain('d-later');
    await waitFor(async () => seen.includes('d-later'));
    expect(seen).toEqual(['d-now', 'd-later']);
  });

  it('боловсруулагч алдаа шидвэл job нэг л удаа ажиллаж failed болно (BullMQ retry байхгүй)', async () => {
    queue = make();
    const deliver = vi.fn().mockRejectedValue(new Error('түр алдаа'));
    await queue.start({ deliver, runReminders: async () => undefined });
    await queue.enqueue('d-fail');
    await waitFor(async () => (await queue.raw.getFailedCount()) === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('completed job устгагдана (removeOnComplete)', async () => {
    queue = make();
    const seen: string[] = [];
    await queue.start({ deliver: async (id) => { seen.push(id); }, runReminders: async () => undefined });
    await queue.enqueue('d-1');
    await waitFor(async () => seen.length === 1);
    await waitFor(async () => (await queue.raw.getCompletedCount()) === 0);
  });

  it('төлөлт сануулах scheduler: 09:00 Asia/Ulaanbaatar cron бүртгэгдэнэ (дахин start() идемпотент); job ажиллахад runReminders', async () => {
    queue = make();
    const runReminders = vi.fn().mockResolvedValue(undefined);
    await queue.start({ deliver: async () => undefined, runReminders });
    await queue.close();
    queue = make();
    await queue.start({ deliver: async () => undefined, runReminders });
    const schedulers = await queue.raw.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: REMINDER_SCHEDULER_ID, name: REMINDER_SCHEDULER_ID, pattern: DEFAULT_REMINDER_CRON, tz: 'Asia/Ulaanbaatar' });
    await queue.raw.add(REMINDER_SCHEDULER_ID, {}); // cron-ыг хүлээлгүй гараар
    await waitFor(async () => runReminders.mock.calls.length > 0);
  });

  it('NOTIFICATION_REMINDER_CRON-оор cron солигдоно', async () => {
    queue = make('30 8 * * 1-5');
    await queue.start({ deliver: async () => undefined, runReminders: async () => undefined });
    expect((await queue.raw.getJobSchedulers())[0]).toMatchObject({ pattern: '30 8 * * 1-5', tz: 'Asia/Ulaanbaatar' });
  });
});

describe.skipIf(!hasTestDb || !REDIS_URL)('NotificationModule + BullMQ (бүтэн урсгал)', () => {
  let t: TestApp;
  let sms: MockSmsGateway;
  const prefix = `los-test-${randomUUID()}`;
  const saved = { q: process.env.NOTIFICATION_QUEUE, p: process.env.NOTIFICATION_QUEUE_PREFIX, s: process.env.NOTIFICATION_SWEEP };

  beforeAll(async () => {
    delete process.env.NOTIFICATION_QUEUE;
    process.env.NOTIFICATION_QUEUE_PREFIX = prefix;
    process.env.NOTIFICATION_SWEEP = 'off';
    t = await createTestApp([NotificationModule]);
    sms = t.app.get(SMS_GATEWAY);
  });
  afterAll(async () => {
    const q = t.app.get(NOTIFICATION_QUEUE) as BullMqNotificationQueue;
    await q.raw.obliterate({ force: true }).catch(() => undefined);
    await t.close();
    for (const [k, v] of [['NOTIFICATION_QUEUE', saved.q], ['NOTIFICATION_QUEUE_PREFIX', saved.p], ['NOTIFICATION_SWEEP', saved.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('REDIS_URL-тэй үед BullMQ сонгогдож, notifyCustomers → worker → SENT; retryable алдаа delay-тэй job болно', async () => {
    await resetDb(t.prisma);
    const queue = t.app.get(NOTIFICATION_QUEUE);
    expect(queue.mode).toBe('bullmq');
    const customer = await createCustomer(t.prisma, { phone: '99112233', email: null });
    const service = t.app.get(NotificationService);

    await service.notifyCustomers({ orgId: ORG, customerIds: [customer.id], type: 'PAYMENT_RECEIVED', payload: { contractNo: 'BZ-1', amount: 1000, currency: 'MNT' }, dedupeBase: 'bull:1' });
    const sent = await waitFor(() => t.prisma.notificationDelivery.findFirst({ where: { status: 'SENT' } }));
    expect(sent).toMatchObject({ channel: 'SMS', attempts: 1, providerMessageId: 'mock-sms-1' });
    expect(sms.outbox).toHaveLength(1);

    sms.failNext(1, { retryable: true });
    await service.notifyCustomers({ orgId: ORG, customerIds: [customer.id], type: 'PAYMENT_RECEIVED', payload: { contractNo: 'BZ-2' }, dedupeBase: 'bull:2' });
    const retrying = await waitFor(() => t.prisma.notificationDelivery.findFirst({ where: { dedupeKey: `bull:2:${customer.id}:SMS`, attempts: 1 } }));
    expect(retrying).toMatchObject({ status: 'QUEUED', lastError: 'PROVIDER_ERROR' });
    expect(retrying.nextAttemptAt!.getTime() - t.clock.now().getTime()).toBe(30_000);
    const delayed = (await (queue as BullMqNotificationQueue).raw.getDelayed()).filter((j) => j.name === 'deliver');
    expect(delayed).toHaveLength(1);
    expect(delayed[0].delay).toBe(30_000);
  });
});

// ── Redis хүрэхгүй үед ямар ч дуудагч гацахгүй (dispatch, retry enqueue, sweep, HTTP, event handler, модулийн эхлэл) ─────────────────────────────
const DEAD_REDIS = 'redis://127.0.0.1:6399/3'; // сонсогч байхгүй порт (ECONNREFUSED)

/** Хугацаанд дуусаагүй бол 'PENDING' (тест өөрөө гацахгүй). */
const settleWithin = async <T>(p: Promise<T>, ms: number): Promise<{ state: 'resolved'; value: T } | { state: 'rejected'; error: unknown } | { state: 'PENDING' }> =>
  Promise.race([
    p.then((value) => ({ state: 'resolved' as const, value }), (error: unknown) => ({ state: 'rejected' as const, error })),
    new Promise<{ state: 'PENDING' }>((resolve) => setTimeout(() => resolve({ state: 'PENDING' }), ms)),
  ]);

describe('BullMqNotificationQueue: Redis хүрэхгүй үед гацахгүй', () => {
  it('анхдагч enqueue timeout нь богино (хэдхэн секунд)', () => {
    expect(DEFAULT_ENQUEUE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_ENQUEUE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('Redis бүртгэлгүй (ECONNREFUSED): enqueue timeout-д QueueUnavailableError-оор rejected, дахин дуудахад ч мөн; close() гацахгүй', async () => {
    const q = new BullMqNotificationQueue({ connection: redisConnectionFromUrl(DEAD_REDIS), prefix: `los-test-${randomUUID()}`, enqueueTimeoutMs: 300 });
    try {
      const started = Date.now();
      for (let i = 0; i < 2; i++) {
        const r = await settleWithin(q.enqueue('x'), 5_000);
        expect(r.state).toBe('rejected');
        expect((r as { error: unknown }).error).toBeInstanceOf(QueueUnavailableError);
      }
      expect(Date.now() - started).toBeLessThan(3_000);
      expect((await settleWithin(q.enqueue('y', 5_000), 5_000)).state).toBe('rejected'); // delay-тэй ч адил
    } finally {
      expect((await settleWithin(q.close(), 10_000)).state).toBe('resolved');
    }
  });

  it('start(): Redis хүрэхгүй үед модулийн эхлэлийг гацаахгүй (scheduler timeout-оор алдаа бичээд дахин оролдоно); close() дахин оролдлогыг зогсооно', async () => {
    const q = new BullMqNotificationQueue({ connection: redisConnectionFromUrl(DEAD_REDIS), prefix: `los-test-${randomUUID()}`, schedulerTimeoutMs: 200, schedulerRetryMs: 150 });
    const upsert = vi.spyOn(q.raw, 'upsertJobScheduler');
    const started = Date.now();
    const r = await settleWithin(q.start({ deliver: async () => undefined, runReminders: async () => undefined }), 5_000);
    expect(r.state).toBe('resolved');
    expect(Date.now() - started).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(upsert.mock.calls.length).toBeGreaterThanOrEqual(3); // эхний + дахин оролдлогууд
    expect((await settleWithin(q.close(), 10_000)).state).toBe('resolved');
    const calls = upsert.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(upsert.mock.calls.length).toBe(calls); // close()-ийн дараа дахин оролдохгүй
  });

  describe.skipIf(!REDIS_URL)('Redis дундаас унтарч сэргэх (TCP proxy)', () => {
    it('унтарвал enqueue шууд rejected (offline буфферт хуримтлуулахгүй); сэргэмэгц дахин ажиллана; close() алдаагүй', async () => {
      const real = new URL(REDIS_URL!);
      const sockets = new Set<net.Socket>();
      const server = net.createServer((client) => {
        const upstream = net.connect(Number(real.port) || 6379, real.hostname);
        for (const s of [client, upstream]) { sockets.add(s); s.on('error', () => undefined); s.on('close', () => sockets.delete(s)); }
        client.pipe(upstream); upstream.pipe(client);
      });
      const listen = (port: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
      await listen(0);
      const port = (server.address() as net.AddressInfo).port;
      const conn = { ...(redisConnectionFromUrl(REDIS_URL!) as object), host: '127.0.0.1', port } as ReturnType<typeof redisConnectionFromUrl>;
      const q = new BullMqNotificationQueue({ connection: conn, prefix: `los-test-${randomUUID()}`, queueName: 'notification-delivery-test' });
      try {
        expect((await settleWithin(q.enqueue('up-1'), 5_000)).state).toBe('resolved');

        server.close(); // шинэ холболт авахаа болино
        for (const s of sockets) s.destroy(); // байгаа холболтыг таслана → Redis "унтарсан"
        await new Promise((resolve) => setTimeout(resolve, 200));
        const started = Date.now();
        const down = await settleWithin(q.enqueue('down-1'), 5_000);
        expect(down.state).toBe('rejected');
        expect(Date.now() - started).toBeLessThan(1_500); // timeout хүртэл хүлээгээгүй — шууд

        await listen(port); // Redis сэргэлээ
        await waitFor(async () => (await settleWithin(q.enqueue('up-2'), 3_000)).state === 'resolved', 15_000);
      } finally {
        await q.raw.obliterate({ force: true }).catch(() => undefined);
        expect((await settleWithin(q.close(), 10_000)).state).toBe('resolved');
        for (const s of sockets) s.destroy();
        server.close();
      }
    }, 40_000);
  });
});

describe.skipIf(!hasTestDb)('NotificationModule + Redis хүрэхгүй: дуудагчид гацахгүй, QUEUED мөр DB-д үлдэнэ', () => {
  let env: NotificationEnv;
  beforeAll(async () => {
    env = await bootNotification({
      customize: (b) => b.overrideProvider(NOTIFICATION_QUEUE).useValue(
        new BullMqNotificationQueue({ connection: redisConnectionFromUrl(DEAD_REDIS), prefix: `los-test-${randomUUID()}`, enqueueTimeoutMs: 200, schedulerTimeoutMs: 200, schedulerRetryMs: 100 }),
      ),
    });
  });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  it('notifyCustomers (tx-гүй, dispatch дотроо): хугацаандаа буцаж, мөр QUEUED үлдэнэ', async () => {
    const c = await createCustomer(env.t.prisma, { phone: '99112233', email: 'bold@example.mn' });
    const r = await settleWithin(env.service.notifyCustomers({ orgId: ORG, customerIds: [c.id], type: 'PAYMENT_RECEIVED', payload: { contractNo: 'BZ-1' }, dedupeBase: 'dead:1' }), 4_000);
    expect(r.state).toBe('resolved');
    expect((r as { value: { queued: number } }).value.queued).toBe(2);
    expect(await env.t.prisma.notificationDelivery.count({ where: { status: 'QUEUED' } })).toBe(2);
  });

  it('retry enqueue: gateway retryable алдаа → RETRY (backoff DB-д бичигдсэн), queue гацаахгүй', async () => {
    const d = await env.t.prisma.notificationDelivery.create({
      data: { orgId: ORG, type: 'PAYMENT_DUE', channel: 'SMS', recipientType: 'CUSTOMER', recipientId: 'c', address: '+97699112233', body: 'x', dedupeKey: `k:${Math.random()}`, status: 'QUEUED', nextAttemptAt: env.t.clock.now() },
    });
    env.sms.failNext(1, { retryable: true });
    const r = await settleWithin(env.processor.process(d.id), 4_000);
    expect(r).toEqual({ state: 'resolved', value: 'RETRY' });
    expect(await env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'QUEUED', attempts: 1 });
  });

  it('sweepOnce: гацахгүй, дараагийн sweep алгасагдахгүй (sweeping=true үлдэхгүй)', async () => {
    await env.t.prisma.notificationDelivery.create({
      data: { orgId: ORG, type: 'PAYMENT_DUE', channel: 'SMS', recipientType: 'CUSTOMER', recipientId: 'c', address: '+97699112233', body: 'x', dedupeKey: `k:${Math.random()}`, status: 'QUEUED', nextAttemptAt: new Date('2026-10-28T01:00:00Z') },
    });
    env.t.clock.advanceMs(10 * 60_000);
    const runtime = env.t.app.get(NotificationRuntime);
    const sweep = vi.spyOn(env.processor, 'sweep');
    expect(await settleWithin(runtime.sweepOnce(), 4_000)).toEqual({ state: 'resolved', value: 0 });
    expect(await settleWithin(runtime.sweepOnce(), 4_000)).toEqual({ state: 'resolved', value: 0 });
    expect(sweep).toHaveBeenCalledTimes(2); // хоёр дахь нь "өмнөх дуусаагүй" гээд алгасагдаагүй
  });

  it('event handler: ApplicationApproved → bus.publish хугацаандаа буцна (consumer гацаахгүй)', async () => {
    const customer = await createCustomer(env.t.prisma, { phone: '99112233', email: 'bold@example.mn' });
    const app = await createApplication(env.t.prisma, { status: 'APPROVED', contractNo: 'BZ-1' });
    await createBorrower(env.t.prisma, app.id, customer.id, 'PRIMARY');
    const r = await settleWithin(publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-1' }), 4_000);
    expect(r.state).toBe('resolved');
    expect(await env.t.prisma.notificationDelivery.count({ where: { status: 'QUEUED' } })).toBe(2);
    expect(await env.t.prisma.notification.count()).toBe(1); // ЗЭЗ-ийн хонх үүссэн
  });

  it('HTTP: POST /notifications/reminders/run гацахгүй (сануулгын хүргэлтийг DB-д бичээд буцна)', async () => {
    const customer = await createCustomer(env.t.prisma, { phone: '99112244', email: null });
    const app = await createApplication(env.t.prisma, { status: 'ACTIVE', contractNo: 'BZ-9' });
    await createBorrower(env.t.prisma, app.id, customer.id, 'PRIMARY');
    await createSchedule(env.t.prisma, app.id, { firstDue: addDays('2026-10-28', 3) });
    const res = await settleWithin(Promise.resolve(env.http().post('/api/notifications/reminders/run').set({ 'x-user-id': 'admin-1', 'x-roles': 'ADMIN', 'x-org-id': ORG }).send({}).then((r) => ({ status: r.status, body: r.body }))), 4_000);
    expect(res.state).toBe('resolved');
    expect((res as { value: { status: number; body: { scheduledDeliveries: number } } }).value).toMatchObject({ status: 200, body: { scheduledDeliveries: 1 } });
    expect(await env.t.prisma.notificationDelivery.count({ where: { status: 'QUEUED' } })).toBe(1);
  });
});
