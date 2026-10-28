import { Logger } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

// CLAUDE.md §3.1: нэг сервис доторх урт ажил = BullMQ (Redis). REDIS_URL байхгүй / NOTIFICATION_QUEUE=inline үед процесс дотор шууд (dev, тест).

export const NOTIFICATION_QUEUE = Symbol('NOTIFICATION_QUEUE');
export const DELIVERY_QUEUE_NAME = 'notification-delivery';
export const REMINDER_SCHEDULER_ID = 'payment-reminders';
export const DEFAULT_REMINDER_CRON = '0 9 * * *';
/** Redis хариу өгөхгүй үед `enqueue` энэ хугацаанд дуусаагүй бол алдаатай (rejection) дуусна — дуудагч (dispatch, sweep, HTTP, event handler) гацахгүй. */
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 3_000;
/** Cron scheduler бүртгэлийн нэг оролдлогын хугацаа ба амжилтгүй бол дахин оролдох завсар. */
export const DEFAULT_SCHEDULER_TIMEOUT_MS = 5_000;
export const SCHEDULER_RETRY_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface QueueHandlers {
  /** DeliveryProcessor.process */
  deliver(deliveryId: string): Promise<unknown>;
  /** ReminderService.runAllOrgs (cron) */
  runReminders(): Promise<unknown>;
}

export interface NotificationQueue {
  readonly mode: 'inline' | 'bullmq';
  /**
   * `sweep()` нь QUEUED мөрийн nextAttemptAt-аас хойш энэ хугацаа өнгөрсөн бол queue-д алдагдсан гэж үзнэ.
   * Claim хийхэд DeliveryProcessor lease-ийг ч мөн nextAttemptAt-д тавьдаг.
   */
  readonly sweepGraceMs: number;
  /** delayMs > 0 бол тухайн хугацаанаас хойш. Энэ нь DB-ийн төлөв биш — алдагдвал sweep() нөхнө. */
  enqueue(deliveryId: string, delayMs?: number): Promise<void>;
  start(handlers: QueueHandlers): Promise<void>;
  close(): Promise<void>;
}

/**
 * Процесс доторх queue: delay=0 бол боловсруулагчийг шууд (await) дуудна — тест тодорхой. delay>0 бол юу ч хийхгүй:
 * DB дахь `nextAttemptAt`-аар sweep() дараа нь авна (автомат cron байхгүй — гараар endpoint).
 */
export class InlineNotificationQueue implements NotificationQueue {
  readonly mode = 'inline' as const;
  readonly sweepGraceMs = 0;
  private handlers: QueueHandlers | null = null;
  private readonly logger = new Logger('NotificationQueue');

  async enqueue(deliveryId: string, delayMs = 0): Promise<void> {
    if (delayMs > 0 || !this.handlers) return;
    try { await this.handlers.deliver(deliveryId); }
    catch (e) { this.logger.warn(`Хүргэлт ${deliveryId} боловсруулахад алдаа: ${e instanceof Error ? e.name : 'үл мэдэгдэх'}`); }
  }

  async start(handlers: QueueHandlers): Promise<void> { this.handlers = handlers; }
  async close(): Promise<void> { this.handlers = null; }
}

export interface BullMqQueueOptions {
  connection: ConnectionOptions;
  prefix?: string;
  queueName?: string;
  concurrency?: number;
  reminderCron?: string;
  /** `enqueue`-ийн дээд хугацаа (мс). Анхдагч {@link DEFAULT_ENQUEUE_TIMEOUT_MS}. */
  enqueueTimeoutMs?: number;
  /** Cron scheduler бүртгэлийн нэг оролдлогын дээд хугацаа (мс). Анхдагч {@link DEFAULT_SCHEDULER_TIMEOUT_MS}. */
  schedulerTimeoutMs?: number;
  /** Scheduler бүртгэл амжилтгүй бол дахин оролдох завсар (мс). Анхдагч {@link SCHEDULER_RETRY_MS}. */
  schedulerRetryMs?: number;
}

/** `promise` нь `ms`-ээс дотор дуусаагүй бол `message`-тэй алдаагаар rejected. Түр хугацааны таймер promise дуусмагц цэвэрлэгдэнэ. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new QueueUnavailableError(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Queue (Redis) хариу өгөхгүй / холбогдоогүй. Дуудагчид залгиж (QUEUED мөр DB-д байгаа тул sweep() нөхнө) болно. */
export class QueueUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'QueueUnavailableError'; }
}

/** Бэлэн ioredis instance (тест/хуваалцсан холболт) эсэх: өөрчлөх боломжгүй, зөвхөн plain тохиргоонд `enableOfflineQueue` нэмнэ. */
const isConnectionInstance = (c: ConnectionOptions): boolean => typeof (c as { duplicate?: unknown }).duplicate === 'function';

/** `redis://[user:pass@]host:port/db` → BullMQ connection. */
export function redisConnectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0;
  return {
    host: u.hostname, port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: Number.isInteger(db) && db >= 0 ? db : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/**
 * BullMQ: `attempts: 1` — дахин оролдлогыг BullMQ биш DeliveryProcessor DB-ийн `attempts`-тай зөрчилгүй, `enqueue(id, delay)`-ээр өөрөө хийнэ.
 * Давхар job (sweep + анхны) аюултай биш: DeliveryProcessor claim хийж нэгийг л боловсруулна.
 */
export class BullMqNotificationQueue implements NotificationQueue {
  readonly mode = 'bullmq' as const;
  readonly sweepGraceMs = 120_000;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly logger = new Logger('NotificationQueue');

  constructor(private readonly opts: BullMqQueueOptions) {
    // Producer (enqueue) холболт: Redis унтарсан үед командыг offline буфферт хуримтлуулж 100+ секунд хүлээлгүй шууд алдаа өгнө.
    // Worker-ийн (blocking) холболтод хамаарахгүй — тэр нь `opts.connection`-ийг хэвээр ашиглана.
    const producer = isConnectionInstance(opts.connection) ? opts.connection : { ...opts.connection, enableOfflineQueue: false };
    this.queue = new Queue(opts.queueName ?? DELIVERY_QUEUE_NAME, { connection: producer, prefix: opts.prefix });
    this.queue.on('error', (e) => this.logger.error(`Queue алдаа: ${e.message}`));
  }

  /** Redis хүрэхгүй бол {@link QueueUnavailableError} (эсвэл холболтын алдаа)-аар хурдан rejected — хэзээ ч гацахгүй. */
  async enqueue(deliveryId: string, delayMs = 0): Promise<void> {
    const add = this.queue.add('deliver', { deliveryId }, {
      ...(delayMs > 0 ? { delay: Math.ceil(delayMs) } : {}), attempts: 1, removeOnComplete: true, removeOnFail: { count: 1000 },
    });
    await withTimeout(add, this.opts.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS, 'Queue (Redis) хариу өгсөнгүй');
  }

  async start(handlers: QueueHandlers): Promise<void> {
    if (this.worker) return;
    this.closed = false;
    this.worker = new Worker(
      this.opts.queueName ?? DELIVERY_QUEUE_NAME,
      async (job) => (job.name === REMINDER_SCHEDULER_ID ? handlers.runReminders() : handlers.deliver(String(job.data?.deliveryId))),
      { connection: this.opts.connection, prefix: this.opts.prefix, concurrency: this.opts.concurrency ?? 5 },
    );
    this.worker.on('error', (e) => this.logger.error(`Worker алдаа: ${e.message}`));
    this.worker.on('failed', (job, e) => this.logger.warn(`Job ${job?.name ?? '?'} амжилтгүй: ${e.name}`));
    await this.registerScheduler();
  }

  /**
   * FR-13.2: өдөр бүр 09:00 (Asia/Ulaanbaatar) төлөлт сануулах. Олон instance-д upsert нь идемпотент, job нэг л удаа ажиллана.
   * Redis хүрэхгүй үед модулийн эхлэлийг гацаахгүй: timeout-оор алдаа бичээд, амжилттай болтол тогтмол завсартай дахин оролдоно.
   */
  private async registerScheduler(): Promise<void> {
    if (this.closed) return;
    try {
      await withTimeout(
        this.queue.upsertJobScheduler(
          REMINDER_SCHEDULER_ID,
          { pattern: this.opts.reminderCron ?? DEFAULT_REMINDER_CRON, tz: 'Asia/Ulaanbaatar' },
          { name: REMINDER_SCHEDULER_ID, data: {}, opts: { removeOnComplete: true, removeOnFail: { count: 100 } } },
        ),
        this.opts.schedulerTimeoutMs ?? DEFAULT_SCHEDULER_TIMEOUT_MS, 'Queue (Redis) хариу өгсөнгүй',
      );
      this.schedulerTimer = null;
    } catch (e) {
      const retryMs = this.opts.schedulerRetryMs ?? SCHEDULER_RETRY_MS;
      this.logger.error(`Төлөлт сануулах cron бүртгэж чадсангүй (${Math.round(retryMs / 1000)}с-ийн дараа дахин оролдоно): ${e instanceof Error ? e.message : 'үл мэдэгдэх'}`);
      if (this.closed) return;
      this.schedulerTimer = setTimeout(() => void this.registerScheduler(), retryMs);
      this.schedulerTimer.unref();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    // Redis унтарсан үед graceful close (QUIT) алдаа өгч/гацаж болно — унтраалтыг эвдэхгүй, албадан салгана.
    const worker = this.worker;
    this.worker = null;
    await this.shutdown(() => worker?.close(), () => worker?.disconnect());
    await this.shutdown(() => this.queue.close(), async () => (await this.queue.client).disconnect());
  }

  private async shutdown(graceful: () => Promise<unknown> | undefined, force: () => Promise<unknown> | undefined): Promise<void> {
    try { await withTimeout(Promise.resolve(graceful()), CLOSE_TIMEOUT_MS, 'Queue хаах хугацаа дууслаа'); }
    catch (e) {
      this.logger.warn(`Queue-г зөөлөн хааж чадсангүй, албадан салгана: ${e instanceof Error ? e.message : 'үл мэдэгдэх'}`);
      try { await withTimeout(Promise.resolve(force()), CLOSE_TIMEOUT_MS, 'Queue салгах хугацаа дууслаа'); } catch { /* унтраалтыг үргэлжлүүлнэ */ }
    }
  }

  /** Тест/удирдлагад: queue-ийн дотоод объект. */
  get raw(): Queue { return this.queue; }
}

export function createNotificationQueue(env: NodeJS.ProcessEnv = process.env): NotificationQueue {
  if (env.NOTIFICATION_QUEUE === 'inline' || !env.REDIS_URL) return new InlineNotificationQueue();
  return new BullMqNotificationQueue({
    connection: redisConnectionFromUrl(env.REDIS_URL),
    prefix: env.NOTIFICATION_QUEUE_PREFIX || 'los',
    concurrency: Number(env.NOTIFICATION_WORKER_CONCURRENCY) || 5,
    reminderCron: env.NOTIFICATION_REMINDER_CRON || DEFAULT_REMINDER_CRON,
  });
}
