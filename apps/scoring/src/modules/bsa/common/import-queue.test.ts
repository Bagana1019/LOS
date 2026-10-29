// InlineImportQueue, createImportQueue, BullmqImportQueue-ийн тохиргоо/алдаа (Redis-гүйгээр). Бодит Redis-тэй тест: import-queue.integration.test.ts
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { EnvConfigError } from './env';
import {
  BullmqImportQueue,
  createImportQueue,
  describeError,
  ImportQueueError,
  InlineImportQueue,
  parseRedisTarget,
  resetImportQueueWarningsForTests,
  type ImportJobAttempt,
  type ImportQueueErrorCode,
  type QueueLogger,
} from './import-queue';

const J1 = '6f1b2c3d-1111-4111-8111-000000000001';
const J2 = '6f1b2c3d-2222-4222-8222-000000000002';
const J3 = '6f1b2c3d-3333-4333-8333-000000000003';

const silent = (): QueueLogger & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, warn: (m) => void lines.push(m), error: (m) => void lines.push(m) };
};

async function codeOf(fn: () => Promise<unknown> | unknown): Promise<ImportQueueErrorCode | undefined> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ImportQueueError);
    return (e as ImportQueueError).code;
  }
  return undefined;
}

/** OS-ийн өгсөн порт дээр сонсоод шууд хаана → тухайн порт дээр холболт ECONNREFUSED (loopback, сүлжээ шаардахгүй) */
async function closedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('InlineImportQueue (sync mode)', () => {
  it('awaits the handler inside enqueue and passes attempt info', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    const calls: Array<[string, ImportJobAttempt]> = [];
    await q.start(async (id, info) => void calls.push([id, info]));
    await q.enqueue(J1);
    expect(calls).toEqual([[J1, { attempt: 1, attempts: 3, isLastAttempt: false }]]);
    expect(q.getJob(J1)).toMatchObject({ state: 'completed', attemptsMade: 1 });
  });

  it('processes a duplicate jobId once (also when enqueued concurrently)', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    const handler = vi.fn(async () => undefined);
    await q.start(handler);
    await Promise.all([q.enqueue(J1), q.enqueue(J1), q.enqueue(J1)]);
    await q.enqueue(J1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retries a failing handler up to attempts, then succeeds', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    const infos: ImportJobAttempt[] = [];
    let n = 0;
    await q.start(async (_id, info) => {
      infos.push(info);
      if (++n < 3) throw new Error('transient');
    });
    await q.enqueue(J1);
    expect(infos.map((i) => i.attempt)).toEqual([1, 2, 3]);
    expect(infos.map((i) => i.isLastAttempt)).toEqual([false, false, true]);
    expect(q.getJob(J1)).toMatchObject({ state: 'completed', attemptsMade: 3 });
    expect(q.getJob(J1)?.lastError).toBeUndefined();
  });

  it('marks the job failed after exhausting attempts; enqueue itself does not throw (BullMQ semantics)', async () => {
    const q = new InlineImportQueue({ mode: 'sync', attempts: 2, logger: silent() });
    const handler = vi.fn(async () => {
      throw new TypeError('boom');
    });
    await q.start(handler);
    await expect(q.enqueue(J1)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(q.getJob(J1)).toMatchObject({ state: 'failed', attempts: 2, attemptsMade: 2, lastError: 'TypeError' });
  });

  it('honours per-job attempts', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    const handler = vi.fn(async (_id: string, _info: ImportJobAttempt) => {
      throw new Error('x');
    });
    await q.start(handler);
    await q.enqueue(J1, { attempts: 1 });
    await q.enqueue(J2, { attempts: 4 });
    expect(handler.mock.calls.filter(([id]) => id === J1)).toHaveLength(1);
    expect(handler.mock.calls.filter(([id]) => id === J2)).toHaveLength(4);
    expect(handler.mock.calls.find(([id]) => id === J1)?.[1].isLastAttempt).toBe(true);
  });

  it('re-enqueueing a FAILED job runs it again (retry failed import), a completed one does not', async () => {
    const q = new InlineImportQueue({ mode: 'sync', attempts: 1, logger: silent() });
    let fail = true;
    const handler = vi.fn(async () => {
      if (fail) throw new Error('first time');
    });
    await q.start(handler);
    await q.enqueue(J1);
    expect(q.getJob(J1)?.state).toBe('failed');
    fail = false;
    await q.enqueue(J1);
    expect(q.getJob(J1)).toMatchObject({ state: 'completed', attemptsMade: 1 });
    await q.enqueue(J1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially between attempts (injected sleep)', async () => {
    const sleeps: number[] = [];
    const q = new InlineImportQueue({ mode: 'sync', attempts: 4, retryDelayMs: 10, sleep: async (ms) => void sleeps.push(ms), logger: silent() });
    await q.start(async () => {
      throw new Error('x');
    });
    await q.enqueue(J1);
    expect(sleeps).toEqual([10, 20, 40]); // сүүлийн оролдлогын дараа хүлээхгүй
  });

  it('jobs enqueued before start() wait and are processed on start, in order', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    await q.enqueue(J1);
    await q.enqueue(J2);
    expect(q.getJob(J1)?.state).toBe('waiting');
    const seen: string[] = [];
    await q.start(async (id) => void seen.push(id));
    expect(seen).toEqual([J1, J2]);
  });

  it('does not deadlock when a handler enqueues a follow-up job', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    const seen: string[] = [];
    await q.start(async (id) => {
      seen.push(id);
      if (id === J1) await q.enqueue(J2);
    });
    await q.enqueue(J1);
    expect(seen).toEqual([J1, J2]);
  });
});

describe('InlineImportQueue (async mode)', () => {
  it('returns from enqueue before the handler runs, then runs jobs serially in order', async () => {
    const q = new InlineImportQueue({ mode: 'async', logger: silent() });
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;
    await q.start(async (id) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end:${id}`);
      running -= 1;
    });
    await q.enqueue(J1);
    await q.enqueue(J2);
    await q.enqueue(J3);
    expect(events).toEqual([]); // setImmediate-ээр хойшилсон
    await q.idle();
    expect(events).toEqual([`start:${J1}`, `end:${J1}`, `start:${J2}`, `end:${J2}`, `start:${J3}`, `end:${J3}`]);
    expect(maxRunning).toBe(1);
  });

  it('handler failures never surface as unhandled rejections and are recorded', async () => {
    const q = new InlineImportQueue({ mode: 'async', attempts: 2, logger: silent() });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await q.start(async () => {
        throw new RangeError('x');
      });
      await q.enqueue(J1);
      await q.idle();
      await new Promise((r) => setImmediate(r));
      expect(q.getJob(J1)).toMatchObject({ state: 'failed', attemptsMade: 2, lastError: 'RangeError' });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a failing job does not block the next one', async () => {
    const q = new InlineImportQueue({ mode: 'async', attempts: 1, logger: silent() });
    await q.start(async (id) => {
      if (id === J1) throw new Error('bad file');
    });
    await q.enqueue(J1);
    await q.enqueue(J2);
    await q.idle();
    expect([q.getJob(J1)?.state, q.getJob(J2)?.state]).toEqual(['failed', 'completed']);
  });

  it('close() finishes in-flight work, then refuses new jobs', async () => {
    const q = new InlineImportQueue({ mode: 'async', logger: silent() });
    let finished = false;
    await q.start(async () => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
    });
    await q.enqueue(J1);
    await q.close();
    expect(finished).toBe(true);
    expect(await codeOf(() => q.enqueue(J2))).toBe('CLOSED');
    expect(await codeOf(() => q.start(async () => undefined))).toBe('CLOSED');
    await expect(q.close()).resolves.toBeUndefined();
  });
});

describe('InlineImportQueue: validation and logging', () => {
  it('rejects start() twice', async () => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    await q.start(async () => undefined);
    expect(await codeOf(() => q.start(async () => undefined))).toBe('ALREADY_STARTED');
  });

  const badJobIds = ['', '123456', 'a:b', 'a b', '../x', 'x'.repeat(201), 42 as unknown as string, undefined as unknown as string];
  it.each(badJobIds.map((id) => [id]))('rejects jobId %j', async (id) => {
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    expect(await codeOf(() => q.enqueue(id))).toBe('INVALID_JOB_ID');
  });

  it.each([[0], [1.5], [21], [-1], [Number.NaN]])('rejects attempts %j', async (attempts) => {
    expect(await codeOf(() => new InlineImportQueue({ attempts }))).toBe('INVALID_OPTIONS');
    const q = new InlineImportQueue({ mode: 'sync', logger: silent() });
    expect(await codeOf(() => q.enqueue(J1, { attempts }))).toBe('INVALID_OPTIONS');
  });

  it('rejects a negative retry delay', () => {
    expect(() => new InlineImportQueue({ retryDelayMs: -1 })).toThrow(ImportQueueError);
  });

  it('logs only the error class/code - never the message (may contain statement rows / PII)', async () => {
    const log = silent();
    const q = new InlineImportQueue({ mode: 'sync', attempts: 2, logger: log });
    await q.start(async () => {
      throw Object.assign(new Error('row 7: Бат-Эрдэнэ УА12345678 100000'), { code: 'PARSE_FAILED' });
    });
    await q.enqueue(J1);
    expect(log.lines.length).toBe(2);
    for (const line of log.lines) {
      expect(line).toContain('Error(PARSE_FAILED)');
      expect(line).not.toContain('УА12345678');
      expect(line).not.toContain('Бат-Эрдэнэ');
    }
    expect(q.getJob(J1)?.lastError).toBe('Error(PARSE_FAILED)');
  });

  it('describeError handles non-error throwables', () => {
    expect(describeError('plain string with УА12345678')).toBe('NonError');
    expect(describeError(null)).toBe('NonError');
    expect(describeError(new ImportQueueError('CLOSED', 'x'))).toBe('ImportQueueError(CLOSED)');
    expect(describeError(new RangeError('x'))).toBe('RangeError');
  });
});

describe('createImportQueue(env)', () => {
  it('without REDIS_URL (non-production): inline async queue + one loud warning', async () => {
    resetImportQueueWarningsForTests();
    const warn = vi.fn();
    const q = createImportQueue({}, { warn });
    createImportQueue({ NODE_ENV: 'test' }, { warn });
    expect(q).toBeInstanceOf(InlineImportQueue);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/INLINE/);
    const seen: string[] = [];
    await q.start(async (id) => void seen.push(id));
    await q.enqueue(J1);
    await (q as InlineImportQueue).idle();
    expect(seen).toEqual([J1]);
    await q.close();
  });

  it('BSA_IMPORT_ATTEMPTS drives the inline attempts', async () => {
    resetImportQueueWarningsForTests();
    const q = createImportQueue({ BSA_IMPORT_ATTEMPTS: '2' }, { warn: () => undefined, logger: silent() }) as InlineImportQueue;
    const handler = vi.fn(async () => {
      throw new Error('x');
    });
    await q.start(handler);
    await q.enqueue(J1);
    await q.idle();
    expect(handler).toHaveBeenCalledTimes(2);
    await q.close();
  });

  it('NODE_ENV=production without REDIS_URL throws (never silently inline)', () => {
    expect(() => createImportQueue({ NODE_ENV: 'production' })).toThrow(EnvConfigError);
    expect(() => createImportQueue({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('with REDIS_URL returns a BullMQ queue without connecting (lazy)', async () => {
    const port = await closedLocalPort();
    const q = createImportQueue({ REDIS_URL: `redis://127.0.0.1:${port}`, NODE_ENV: 'production' });
    expect(q).toBeInstanceOf(BullmqImportQueue);
    await expect(q.close()).resolves.toBeUndefined(); // ёзоор хэзээ ч холбогдоогүй ч аюулгүй
  });

  it.each([
    ['REDIS_URL', { REDIS_URL: 'http://localhost:6379' }],
    ['REDIS_URL', { REDIS_URL: 'not a url' }],
    ['BSA_IMPORT_ATTEMPTS', { BSA_IMPORT_ATTEMPTS: '0' }],
    ['BSA_IMPORT_ATTEMPTS', { BSA_IMPORT_ATTEMPTS: 'three' }],
    ['BSA_IMPORT_ATTEMPTS', { BSA_IMPORT_ATTEMPTS: '21' }],
    ['BSA_IMPORT_BACKOFF_MS', { REDIS_URL: 'redis://localhost', BSA_IMPORT_BACKOFF_MS: '-5' }],
    ['BSA_IMPORT_CONCURRENCY', { REDIS_URL: 'redis://localhost', BSA_IMPORT_CONCURRENCY: '0' }],
    ['BSA_IMPORT_QUEUE', { REDIS_URL: 'redis://localhost', BSA_IMPORT_QUEUE: 'bad:name' }],
  ])('fails fast naming %s for invalid config', (variable, env) => {
    try {
      createImportQueue(env, { warn: () => undefined });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvConfigError);
      expect((e as EnvConfigError).variable).toBe(variable);
    }
  });

  it('never echoes the Redis password in configuration errors', () => {
    for (const REDIS_URL of ['http://user:topsecret@localhost:6379', 'topsecret@@@']) {
      try {
        createImportQueue({ REDIS_URL });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain('topsecret');
      }
    }
  });
});

describe('BullmqImportQueue (no Redis needed)', () => {
  it('parseRedisTarget returns host:port only', () => {
    expect(parseRedisTarget('redis://:pw@cache.internal:6380/2')).toBe('cache.internal:6380');
    expect(parseRedisTarget('rediss://cache.internal')).toBe('cache.internal:6379');
  });

  it.each([
    ['bad queue name', { queueName: 'a:b' }],
    ['zero attempts', { attempts: 0 }],
    ['zero concurrency', { concurrency: 0 }],
    ['negative backoff', { backoffDelayMs: -1 }],
    ['zero enqueue timeout', { enqueueTimeoutMs: 0 }],
    ['tiny lock duration', { lockDurationMs: 10 }],
    ['non-redis URL', { redisUrl: 'http://localhost' }],
  ])('rejects invalid options: %s', (_n, over) => {
    expect(() => new BullmqImportQueue({ redisUrl: 'redis://localhost:6379', ...over })).toThrow(ImportQueueError);
  });

  it('validates jobId/attempts BEFORE touching Redis', async () => {
    const q = new BullmqImportQueue({ redisUrl: `redis://127.0.0.1:${await closedLocalPort()}`, logger: silent() });
    expect(await codeOf(() => q.enqueue('12345'))).toBe('INVALID_JOB_ID');
    expect(await codeOf(() => q.enqueue(J1, { attempts: 0 }))).toBe('INVALID_OPTIONS');
    await q.close();
  });

  it('Redis down: enqueue() and start() fail fast with a clear REDIS_UNAVAILABLE (host:port, no password), and later calls retry', async () => {
    const port = await closedLocalPort();
    const log = silent();
    const q = new BullmqImportQueue({ redisUrl: `redis://:topsecret@127.0.0.1:${port}`, connectTimeoutMs: 500, logger: log });
    const started = Date.now();
    for (const op of [() => q.enqueue(J1), () => q.start(async () => undefined), () => q.enqueue(J2)]) {
      let err: unknown;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ImportQueueError);
      expect((err as ImportQueueError).code).toBe('REDIS_UNAVAILABLE');
      expect((err as Error).message).toContain(`127.0.0.1:${port}`);
      expect((err as Error).message).not.toContain('topsecret');
    }
    expect(Date.now() - started).toBeLessThan(5_000); // hang хийхгүй
    expect(log.lines.join('\n')).not.toContain('topsecret');
    await q.close();
    expect(await codeOf(() => q.enqueue(J1))).toBe('CLOSED');
  });
});
