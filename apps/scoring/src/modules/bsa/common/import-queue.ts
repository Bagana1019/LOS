// BSA импортын ажлын дараалал (CLAUDE.md §3.1 "Job queue": BullMQ/Redis). ImportQueue port-ийн adapter-ууд:
//   BullmqImportQueue (бодит) · InlineImportQueue (тест: 'sync'; Redis-гүй dev: 'async') · createImportQueue(env).
// jobId = bsa_import_job.id. Ажлын өгөгдөлд зөвхөн jobId орно (PII үгүй); алдааны лог дээр зөвхөн алдааны класс/код (мессеж орохгүй:
// parser-ийн алдаа мөрийн агуулга агуулж магадгүй). Redis URL нууц үг агуулж болох тул зөвхөн host:port хэвлэнэ.
import { Logger } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { envInteger, envString, EnvConfigError, isProduction, type EnvLike } from './env';
import type { ImportQueue } from './infra.ports';

/** Handler-т өгөх оролдлогын мэдээлэл. Сүүлийн оролдлого дээр алдаа гарвал handler ажлыг FAILED болгох ёстой (дахин оролдлого үлдээгүй) */
export interface ImportJobAttempt {
  /** 1-ээс эхэлнэ */
  attempt: number;
  attempts: number;
  isLastAttempt: boolean;
}
export type ImportJobHandler = (jobId: string, info: ImportJobAttempt) => Promise<void>;

/** `ImportQueue` port + handler-т оролдлогын мэдээлэл (`info`) дамжуулах. Port-ийн handler (`(jobId) => …`) мөн л хүчинтэй */
export interface AttemptAwareImportQueue extends ImportQueue {
  start(handler: ImportJobHandler): Promise<void>;
  /** Nest shutdown-д */
  onModuleDestroy(): Promise<void>;
}

export type ImportQueueErrorCode = 'INVALID_JOB_ID' | 'INVALID_OPTIONS' | 'REDIS_UNAVAILABLE' | 'ALREADY_STARTED' | 'CLOSED';

export class ImportQueueError extends Error {
  constructor(readonly code: ImportQueueErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportQueueError';
  }
}

/** Анхдагч утгууд ЭНД (env BSA_IMPORT_ATTEMPTS / BSA_IMPORT_BACKOFF_MS / BSA_IMPORT_CONCURRENCY-ээр дарна) */
export const IMPORT_QUEUE_DEFAULTS = {
  queueName: 'bsa-import',
  attempts: 3,
  /** Экспоненциал backoff-ийн суурь: 1-р дахин оролдлого delay, 2-р 2×delay, … (NFR-8) */
  backoffDelayMs: 5_000,
  concurrency: 2,
  connectTimeoutMs: 5_000,
  /** enqueue() Redis-ийн хариуг хүлээх дээд хугацаа: HTTP хүсэлт Redis-ийн саатал дээр өлгөгдөхөөс сэргийлнэ */
  enqueueTimeoutMs: 10_000,
  /** Worker-ийн lock: том PDF parse event loop-ыг барьж lock шинэчлэх (lockDuration/2 тутамд) саатвал ажил "stalled" болж
   *  давхар ажиллана; тиймээс 30с-ийн анхдагчаас урт (NFR-1: импорт ≤60с) */
  lockDurationMs: 120_000,
  removeOnComplete: { count: 1_000, age: 7 * 24 * 3600 },
  removeOnFail: { count: 5_000 },
} as const;

const JOB_NAME = 'import';
const JOB_ID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const QUEUE_NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_ATTEMPTS = 20;

/** BullMQ: custom id нь бүхэл тоо байж болохгүй, ':' агуулж болохгүй. Бид UUID хэрэглэнэ */
function assertJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId) || /^\d+$/.test(jobId)) {
    throw new ImportQueueError('INVALID_JOB_ID', 'jobId must be 1-200 characters of [A-Za-z0-9_.-] and not purely numeric');
  }
}

function assertAttempts(attempts: unknown): asserts attempts is number {
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new ImportQueueError('INVALID_OPTIONS', `attempts must be an integer in [1, ${MAX_ATTEMPTS}]`);
  }
}

export interface QueueLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Алдааны товч тодорхойлолт: класс + (байвал) код. Мессеж ХЭЗЭЭ Ч орохгүй (PII байж болзошгүй) */
export function describeError(e: unknown): string {
  if (typeof e !== 'object' || e === null) return 'NonError';
  const code = (e as { code?: unknown }).code;
  return `${e.constructor?.name ?? 'Error'}${typeof code === 'string' ? `(${code})` : ''}`;
}

// ───────────────────────── BullMQ ─────────────────────────

export interface BullmqImportQueueOptions {
  /** redis:// эсвэл rediss:// */
  redisUrl: string;
  queueName?: string;
  /** Ажил бүрийн анхдагч оролдлогын тоо (enqueue-ийн opts.attempts-аар дарна) */
  attempts?: number;
  backoffDelayMs?: number;
  concurrency?: number;
  /** BullMQ key prefix (тестэд тусгаарлахад). Анхдагч 'bull' */
  prefix?: string;
  /** Redis-тэй анх холбогдох хугацаа; хэтэрвэл REDIS_UNAVAILABLE */
  connectTimeoutMs?: number;
  /** enqueue()-ийн Redis дуудлагын дээд хугацаа; хэтэрвэл REDIS_UNAVAILABLE (ажил хожим нэмэгдэж ч болно — jobId-аар идемпотент) */
  enqueueTimeoutMs?: number;
  lockDurationMs?: number;
  logger?: QueueLogger;
}

export class BullmqImportQueue implements AttemptAwareImportQueue {
  readonly #url: string;
  readonly #target: string;
  readonly #name: string;
  readonly #attempts: number;
  readonly #backoffDelayMs: number;
  readonly #concurrency: number;
  readonly #prefix: string | undefined;
  readonly #connectTimeoutMs: number;
  readonly #enqueueTimeoutMs: number;
  readonly #lockDurationMs: number;
  readonly #log: QueueLogger;
  #redis: Promise<Redis> | null = null;
  #queue: Queue | null = null;
  #worker: Worker | null = null;
  #closed = false;

  constructor(options: BullmqImportQueueOptions) {
    this.#target = parseRedisTarget(options.redisUrl);
    this.#url = options.redisUrl;
    this.#name = options.queueName ?? IMPORT_QUEUE_DEFAULTS.queueName;
    this.#attempts = options.attempts ?? IMPORT_QUEUE_DEFAULTS.attempts;
    this.#backoffDelayMs = options.backoffDelayMs ?? IMPORT_QUEUE_DEFAULTS.backoffDelayMs;
    this.#concurrency = options.concurrency ?? IMPORT_QUEUE_DEFAULTS.concurrency;
    this.#prefix = options.prefix;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? IMPORT_QUEUE_DEFAULTS.connectTimeoutMs;
    this.#enqueueTimeoutMs = options.enqueueTimeoutMs ?? IMPORT_QUEUE_DEFAULTS.enqueueTimeoutMs;
    this.#lockDurationMs = options.lockDurationMs ?? IMPORT_QUEUE_DEFAULTS.lockDurationMs;
    this.#log = options.logger ?? new Logger('ImportQueue');
    assertAttempts(this.#attempts);
    const invalid = (message: string): ImportQueueError => new ImportQueueError('INVALID_OPTIONS', message);
    if (!QUEUE_NAME_RE.test(this.#name)) throw invalid('queueName must match [A-Za-z0-9_-]{1,100} (BullMQ forbids ":")');
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1) throw invalid('concurrency must be an integer >= 1');
    if (!Number.isInteger(this.#backoffDelayMs) || this.#backoffDelayMs < 0) throw invalid('backoffDelayMs must be an integer >= 0');
    if (!Number.isInteger(this.#enqueueTimeoutMs) || this.#enqueueTimeoutMs < 1) throw invalid('enqueueTimeoutMs must be an integer >= 1');
    if (!Number.isInteger(this.#lockDurationMs) || this.#lockDurationMs < 1_000) throw invalid('lockDurationMs must be an integer >= 1000');
  }

  /** Redis холболт/queue анхны хэрэглээнд л үүснэ (lazy): Redis унтарсан үед app boot эвдрэхгүй, `start()`/`enqueue()` тодорхой алдаа өгнө */
  async #ensureQueue(): Promise<Queue> {
    if (this.#closed) throw new ImportQueueError('CLOSED', 'import queue is closed');
    this.#redis ??= this.#openRedis().catch((e: unknown) => {
      this.#redis = null;
      throw e;
    });
    const connection = await this.#redis;
    if (this.#closed) throw new ImportQueueError('CLOSED', 'import queue is closed'); // await-ийн явцад close() дуудагдсан
    if (!this.#queue) {
      this.#queue = new Queue(this.#name, {
        connection,
        prefix: this.#prefix,
        defaultJobOptions: {
          attempts: this.#attempts,
          backoff: { type: 'exponential', delay: this.#backoffDelayMs },
          removeOnComplete: { ...IMPORT_QUEUE_DEFAULTS.removeOnComplete },
          removeOnFail: { ...IMPORT_QUEUE_DEFAULTS.removeOnFail },
        },
      });
      this.#queue.on('error', (e) => this.#log.error(`queue error: ${describeError(e)}`));
    }
    return this.#queue;
  }

  async #openRedis(): Promise<Redis> {
    // maxRetriesPerRequest: null — BullMQ Worker-ийн blocking команд шаарддаг. lazyConnect: анхны холболтыг энд тодорхой хийж, амжилтгүй бол
    // disconnect() хийгээд тодорхой алдаа өгнө (ioredis өөрөө үргэлж дахин оролдож enqueue/start-ыг өлгөхөөс сэргийлнэ).
    // Нэгэнт холбогдсоны дараа тасрах бол ioredis-ийн анхдагч стратегиор автоматаар дахин холбогдоно.
    const redis = new Redis(this.#url, { maxRetriesPerRequest: null, lazyConnect: true, connectTimeout: this.#connectTimeoutMs });
    redis.on('error', (e) => this.#log.error(`redis error: ${describeError(e)}`));
    try {
      await redis.connect();
      await redis.ping();
    } catch (e) {
      redis.disconnect();
      const hint = `cannot connect to Redis at ${this.#target} (is REDIS_URL correct and Redis running?)`;
      throw new ImportQueueError('REDIS_UNAVAILABLE', hint, { cause: e });
    }
    return redis;
  }

  async enqueue(jobId: string, opts?: { attempts?: number }): Promise<void> {
    assertJobId(jobId);
    if (opts?.attempts !== undefined) assertAttempts(opts.attempts);
    const queue = await this.#ensureQueue();
    await this.#bounded(this.#add(queue, jobId, opts?.attempts));
  }

  async #add(queue: Queue, jobId: string, attempts: number | undefined): Promise<void> {
    // Ижил jobId-тай ажил (хүлээж буй / явж буй / дууссан) BullMQ-д дахин нэмэгдэхгүй = idempotent. Харин АЛДААТАЙ дууссан ажлыг
    // дахин оруулах (BSA-FR-2.6, NFR-8) тул устгаад шинээр нэмнэ.
    const existing = await queue.getJob(jobId);
    if (existing && (await existing.getState()) === 'failed') await existing.remove();
    await queue.add(JOB_NAME, { jobId }, { jobId, ...(attempts !== undefined ? { attempts } : {}) });
  }

  /** Redis-ийн холболт тасарсан үед ioredis команд дарааллаад хүлээдэг (maxRetriesPerRequest: null) → хүсэлтийн thread өлгөгдөхгүй байлгана */
  #bounded<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      const message = `Redis at ${this.#target} did not answer within ${this.#enqueueTimeoutMs} ms`;
      timer = setTimeout(() => reject(new ImportQueueError('REDIS_UNAVAILABLE', message)), this.#enqueueTimeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  async start(handler: ImportJobHandler): Promise<void> {
    if (this.#worker) throw new ImportQueueError('ALREADY_STARTED', 'import queue worker is already started');
    await this.#ensureQueue();
    const connection = await this.#redis!;
    const worker = new Worker<{ jobId: string }>(
      this.#name,
      async (job: Job<{ jobId: string }>) => {
        const attempts = job.opts.attempts ?? this.#attempts;
        const attempt = job.attemptsMade + 1;
        await handler(job.data.jobId, { attempt, attempts, isLastAttempt: attempt >= attempts });
      },
      { connection, prefix: this.#prefix, concurrency: this.#concurrency, lockDuration: this.#lockDurationMs },
    );
    worker.on('error', (e) => this.#log.error(`worker error: ${describeError(e)}`));
    worker.on('failed', (job, e) => {
      const final = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
      const outcome = final ? 'giving up' : 'will retry';
      this.#log.warn(`import job ${job?.id ?? '?'} attempt ${job?.attemptsMade ?? '?'} failed (${describeError(e)}) - ${outcome}`);
    });
    this.#worker = worker;
    try {
      await worker.waitUntilReady();
    } catch (e) {
      this.#worker = null;
      await worker.close(true).catch(() => undefined);
      throw new ImportQueueError('REDIS_UNAVAILABLE', `worker cannot connect to Redis at ${this.#target}`, { cause: e });
    }
  }

  /** Ажлын BullMQ төлөв (waiting|active|delayed|completed|failed) эсвэл undefined — хяналт/тестэд */
  async jobState(jobId: string): Promise<string | undefined> {
    assertJobId(jobId);
    const job = await (await this.#ensureQueue()).getJob(jobId);
    return job ? job.getState() : undefined;
  }

  /** Graceful: явж буй ажлыг дуусгаж, worker → queue → Redis дарааллаар хаана. Давтан дуудахад аюулгүй */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker;
    const queue = this.#queue;
    const redisPromise = this.#redis;
    this.#worker = null;
    this.#queue = null;
    this.#redis = null;
    await worker?.close().catch((e: unknown) => this.#log.error(`worker close failed: ${describeError(e)}`));
    await queue?.close().catch((e: unknown) => this.#log.error(`queue close failed: ${describeError(e)}`));
    const redis = await redisPromise?.catch(() => undefined);
    if (redis) await redis.quit().catch(() => redis.disconnect());
  }

  /** Nest lifecycle: app.close() / shutdown hook-д */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

/** `host:port` (нууц үггүй). Буруу URL-д ImportQueueError('INVALID_OPTIONS'); URL-ийг мессежид хэвлэхгүй */
export function parseRedisTarget(redisUrl: string): string {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new ImportQueueError('INVALID_OPTIONS', 'REDIS_URL is not a valid URL (expected redis://[:password@]host[:port][/db])');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new ImportQueueError('INVALID_OPTIONS', `REDIS_URL must use the redis:// or rediss:// scheme (got ${url.protocol})`);
  }
  return `${url.hostname}:${url.port || '6379'}`;
}

// ───────────────────────── Inline ─────────────────────────

export type InlineJobState = 'waiting' | 'active' | 'completed' | 'failed';
export interface InlineJobInfo {
  state: InlineJobState;
  attempts: number;
  attemptsMade: number;
  /** Сүүлийн алдааны класс/код (мессеж биш) */
  lastError?: string;
}

export interface InlineImportQueueOptions {
  /** 'sync': enqueue handler дуустал хүлээнэ (тест) · 'async': setImmediate-ээр дараа нь, дарааллаар (Redis-гүй dev). Анхдагч 'async' */
  mode?: 'sync' | 'async';
  attempts?: number;
  /** Дахин оролдлогын өмнөх хүлээлт (экспоненциал: delay × 2^(n-1)). Анхдагч 0 */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: QueueLogger;
}

/**
 * Redis-гүй орчинд ажлыг процесс дотор гүйцэтгэнэ. BullMQ-тай ижил семантик: jobId давхардвал нэг л удаа боловсруулна (алдаатайг
 * дахин оруулж болно), handler алдаа шидвэл `attempts` хүртэл дахин оролдоно, ажлууд дарааллаар.
 * Дахин асаахад ажил алдагдана — ЗӨВХӨН dev/тест.
 * Эцсийн алдаа `enqueue`-ээс шидэгдэхгүй (BullMQ шиг) — `getJob()`/`idle()`-ээр шалгана.
 */
export class InlineImportQueue implements AttemptAwareImportQueue {
  readonly #mode: 'sync' | 'async';
  readonly #attempts: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: QueueLogger;
  readonly #jobs = new Map<string, InlineJobInfo>();
  #handler: ImportJobHandler | null = null;
  #chain: Promise<void> = Promise.resolve();
  readonly #inflight = new Set<Promise<void>>();
  #scheduled = 0;
  #closed = false;

  constructor(options: InlineImportQueueOptions = {}) {
    this.#mode = options.mode ?? 'async';
    this.#attempts = options.attempts ?? IMPORT_QUEUE_DEFAULTS.attempts;
    this.#retryDelayMs = options.retryDelayMs ?? 0;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#log = options.logger ?? new Logger('InlineImportQueue');
    assertAttempts(this.#attempts);
    if (!Number.isInteger(this.#retryDelayMs) || this.#retryDelayMs < 0) {
      throw new ImportQueueError('INVALID_OPTIONS', 'retryDelayMs must be an integer >= 0');
    }
  }

  async enqueue(jobId: string, opts?: { attempts?: number }): Promise<void> {
    if (this.#closed) throw new ImportQueueError('CLOSED', 'import queue is closed');
    assertJobId(jobId);
    if (opts?.attempts !== undefined) assertAttempts(opts.attempts);
    const existing = this.#jobs.get(jobId);
    if (existing && existing.state !== 'failed') return; // idempotent
    this.#jobs.set(jobId, { state: 'waiting', attempts: opts?.attempts ?? this.#attempts, attemptsMade: 0 });
    if (this.#handler) await this.#dispatch(jobId);
  }

  async start(handler: ImportJobHandler): Promise<void> {
    if (this.#closed) throw new ImportQueueError('CLOSED', 'import queue is closed');
    if (this.#handler) throw new ImportQueueError('ALREADY_STARTED', 'import queue worker is already started');
    this.#handler = handler;
    // start-аас өмнө enqueue хийсэн ажлууд (BullMQ-д Redis-д хүлээж байдаг шиг) одоо гүйцэтгэгдэнэ
    const waiting = [...this.#jobs].filter(([, j]) => j.state === 'waiting').map(([id]) => id);
    await Promise.all(waiting.map((id) => this.#dispatch(id)));
  }

  getJob(jobId: string): InlineJobInfo | undefined {
    const j = this.#jobs.get(jobId);
    return j && { ...j };
  }

  /** Бүх товлогдсон/явж буй ажил дуустал хүлээнэ ('async' горимын тестэд) */
  async idle(): Promise<void> {
    while (this.#scheduled > 0 || this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.idle();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /** 'sync': шууд (дарааллалгүй) — handler дотроос дахин enqueue хийвэл deadlock болохгүй. 'async': setImmediate + нэг нэгээр */
  #dispatch(jobId: string): Promise<void> {
    if (this.#mode === 'sync') return this.#track(this.#run(jobId));
    this.#scheduled += 1;
    setImmediate(() => {
      this.#scheduled -= 1;
      this.#chain = this.#chain.then(() => this.#run(jobId));
      this.#track(this.#chain);
    });
    return Promise.resolve();
  }

  #track(run: Promise<void>): Promise<void> {
    this.#inflight.add(run);
    void run.finally(() => this.#inflight.delete(run));
    return run;
  }

  /** Хэзээ ч reject хийхгүй: алдаа job-ийн төлөвт бичигдэнэ */
  async #run(jobId: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    const handler = this.#handler;
    if (!job || !handler || job.state !== 'waiting') return;
    job.state = 'active';
    for (let attempt = 1; attempt <= job.attempts; attempt += 1) {
      job.attemptsMade = attempt;
      try {
        await handler(jobId, { attempt, attempts: job.attempts, isLastAttempt: attempt === job.attempts });
        job.state = 'completed';
        delete job.lastError;
        return;
      } catch (e) {
        job.lastError = describeError(e);
        const willRetry = attempt < job.attempts;
        const outcome = willRetry ? 'will retry' : 'giving up';
        this.#log.warn(`inline import job ${jobId} attempt ${attempt} failed (${job.lastError}) - ${outcome}`);
        if (willRetry && this.#retryDelayMs > 0) await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      }
    }
    job.state = 'failed';
  }
}

// ───────────────────────── Factory ─────────────────────────

let inlineWarned = false;
/** Тестэд "нэг удаагийн" анхааруулгыг дахин идэвхжүүлэх */
export function resetImportQueueWarningsForTests(): void {
  inlineWarned = false;
}

export interface CreateImportQueueOptions {
  /** Redis-гүй inline горимын нэг удаагийн анхааруулга */
  warn?: (message: string) => void;
  /** Дарааллын ажиллагааны лог (анхдагч: Nest Logger) */
  logger?: QueueLogger;
}

/**
 * REDIS_URL байвал BullMQ, үгүй бол процесс доторх 'async' inline дараалал (нэг удаагийн дуутай анхааруулгатай).
 * NODE_ENV=production үед REDIS_URL байхгүй бол шидэнэ: inline дараалал дахин асаахад ажлаа алддаг.
 * Env: BSA_IMPORT_ATTEMPTS, BSA_IMPORT_BACKOFF_MS, BSA_IMPORT_CONCURRENCY, BSA_IMPORT_QUEUE (queue name).
 */
export function createImportQueue(env: EnvLike = process.env, options: CreateImportQueueOptions = {}): AttemptAwareImportQueue {
  const attempts = envInteger(env, 'BSA_IMPORT_ATTEMPTS', { min: 1, max: MAX_ATTEMPTS });
  const redisUrl = envString(env, 'REDIS_URL');
  if (redisUrl !== undefined) {
    const queueName = envString(env, 'BSA_IMPORT_QUEUE');
    if (queueName !== undefined && !QUEUE_NAME_RE.test(queueName)) {
      throw new EnvConfigError('BSA_IMPORT_QUEUE', 'must match [A-Za-z0-9_-]{1,100}');
    }
    try {
      parseRedisTarget(redisUrl);
    } catch (e) {
      throw new EnvConfigError('REDIS_URL', e instanceof Error ? e.message : 'invalid');
    }
    return new BullmqImportQueue({
      redisUrl,
      queueName,
      attempts,
      backoffDelayMs: envInteger(env, 'BSA_IMPORT_BACKOFF_MS', { min: 0 }),
      concurrency: envInteger(env, 'BSA_IMPORT_CONCURRENCY', { min: 1, max: 64 }),
      logger: options.logger,
    });
  }
  if (isProduction(env)) {
    throw new EnvConfigError('REDIS_URL', 'is required when NODE_ENV=production (the inline import queue loses jobs on restart)');
  }
  if (!inlineWarned) {
    inlineWarned = true;
    const message = 'REDIS_URL is not set: BSA imports run on the INLINE in-process queue (jobs are lost on restart). Local dev ONLY.';
    (options.warn ?? ((m: string) => new Logger('ImportQueue').warn(m)))(message);
  }
  return new InlineImportQueue({ mode: 'async', attempts, logger: options.logger });
}
