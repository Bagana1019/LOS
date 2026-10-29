// BullmqImportQueue — БОДИТ Redis дээр. REDIS_URL_TEST (жишээ redis://127.0.0.1:63791) тохируулаагүй бол алгасна.
// Тест бүр өөрийн BullMQ prefix-тэй, дуусахад зөвхөн тэр prefix-ийн түлхүүрүүдийг устгана (бусдын өгөгдөлд хүрэхгүй).
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BullmqImportQueue, ImportQueueError, type BullmqImportQueueOptions, type ImportJobAttempt } from './import-queue';

const REDIS_URL = process.env.REDIS_URL_TEST;
const J1 = '6f1b2c3d-1111-4111-8111-000000000001';
const J2 = '6f1b2c3d-2222-4222-8222-000000000002';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const logger = { warn: () => undefined, error: () => undefined };

describe.skipIf(!REDIS_URL)('BullmqImportQueue (real Redis, REDIS_URL_TEST)', () => {
  let admin: Redis;
  let seq = 0;
  const opened: BullmqImportQueue[] = [];
  const prefixes: string[] = [];
  let prefix = '';

  beforeAll(() => {
    admin = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((q) => q.close()));
    for (const p of prefixes.splice(0)) {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await admin.scan(cursor, 'MATCH', `${p}:*`, 'COUNT', 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      if (keys.length > 0) await admin.del(...keys);
    }
  });

  afterAll(async () => {
    await admin.quit();
  });

  function newPrefix(): string {
    seq += 1;
    prefix = `bsa-it-${process.pid}-${seq}`;
    prefixes.push(prefix);
    return prefix;
  }

  function make(over: Partial<BullmqImportQueueOptions> = {}): BullmqImportQueue {
    const q = new BullmqImportQueue({ redisUrl: REDIS_URL!, prefix: prefix || newPrefix(), backoffDelayMs: 20, concurrency: 1, logger, ...over });
    opened.push(q);
    return q;
  }

  async function stateOf(q: BullmqImportQueue, jobId: string): Promise<string | undefined> {
    return q.jobState(jobId);
  }

  it('enqueue -> handler is called exactly once with the jobId and attempt info', async () => {
    newPrefix();
    const q = make();
    const calls: Array<[string, ImportJobAttempt]> = [];
    await q.start(async (id, info) => void calls.push([id, info]));
    await q.enqueue(J1);
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('completed'), { timeout: 5_000 });
    await sleep(200); // дахин дуудагдахгүйг шалгана
    expect(calls).toEqual([[J1, { attempt: 1, attempts: 3, isLastAttempt: false }]]);
  });

  it('a failing handler is retried with backoff, then the job completes', async () => {
    newPrefix();
    const q = make();
    const infos: ImportJobAttempt[] = [];
    const started = Date.now();
    await q.start(async (_id, info) => {
      infos.push(info);
      if (info.attempt < 3) throw new Error('transient parse hiccup');
    });
    await q.enqueue(J1);
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('completed'), { timeout: 10_000 });
    expect(infos.map((i) => [i.attempt, i.isLastAttempt])).toEqual([[1, false], [2, false], [3, true]]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50); // 20ms + 40ms экспоненциал backoff
  });

  it('a handler that always fails is retried `attempts` times and then marked failed (not retried further)', async () => {
    newPrefix();
    const q = make();
    const infos: ImportJobAttempt[] = [];
    await q.start(async (_id, info) => {
      infos.push(info);
      throw new Error('permanently broken statement');
    });
    await q.enqueue(J1);
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('failed'), { timeout: 10_000 });
    await sleep(300);
    expect(infos.map((i) => [i.attempt, i.isLastAttempt])).toEqual([[1, false], [2, false], [3, true]]);
  });

  it('per-job attempts override the default', async () => {
    newPrefix();
    const q = make();
    const handler = vi.fn(async () => {
      throw new Error('x');
    });
    await q.start(handler);
    await q.enqueue(J1, { attempts: 1 });
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('failed'), { timeout: 5_000 });
    await sleep(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('duplicate enqueue of the same jobId (concurrent and after completion) is processed once', async () => {
    newPrefix();
    const q = make();
    const handler = vi.fn(async () => undefined);
    await q.start(handler);
    await Promise.all([q.enqueue(J1), q.enqueue(J1), q.enqueue(J1)]);
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('completed'), { timeout: 5_000 });
    await q.enqueue(J1);
    await q.enqueue(J1);
    await sleep(300);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('re-enqueueing a FAILED job runs it again (retry a failed import), keeping the same jobId', async () => {
    newPrefix();
    const q = make();
    let broken = true;
    const handler = vi.fn(async () => {
      if (broken) throw new Error('bad');
    });
    await q.start(handler);
    await q.enqueue(J1, { attempts: 1 });
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('failed'), { timeout: 5_000 });
    broken = false;
    await q.enqueue(J1, { attempts: 1 });
    await vi.waitFor(async () => expect(await stateOf(q, J1)).toBe('completed'), { timeout: 5_000 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('jobs enqueued before any worker started survive and are processed by another instance (restart / other process)', async () => {
    newPrefix();
    const producer = make();
    await producer.enqueue(J1);
    await producer.enqueue(J2);
    expect(await stateOf(producer, J1)).toBe('waiting');
    await producer.close();
    const seen: string[] = [];
    const consumer = make();
    await consumer.start(async (id) => void seen.push(id));
    await vi.waitFor(() => expect(seen.sort()).toEqual([J1, J2].sort()), { timeout: 5_000 });
  });

  it('stores only the jobId as job data and applies the retention / retry options', async () => {
    newPrefix();
    const q = make({ attempts: 4, backoffDelayMs: 1_000 });
    await q.enqueue(J1);
    const inspector = new Queue('bsa-import', { connection: new Redis(REDIS_URL!, { maxRetriesPerRequest: null }), prefix });
    try {
      const job = await inspector.getJob(J1);
      expect(job?.data).toEqual({ jobId: J1 });
      expect(job?.opts).toMatchObject({
        jobId: J1,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000, age: 7 * 24 * 3600 },
        removeOnFail: { count: 5_000 },
      });
    } finally {
      await inspector.close();
      await (inspector.opts.connection as Redis).quit();
    }
  });

  it('respects the worker concurrency option', async () => {
    for (const [concurrency, expectedMax] of [[1, 1], [2, 2]] as const) {
      newPrefix();
      const q = make({ concurrency });
      let running = 0;
      let max = 0;
      let done = 0;
      await q.start(async () => {
        running += 1;
        max = Math.max(max, running);
        await sleep(250);
        running -= 1;
        done += 1;
      });
      await Promise.all([q.enqueue(J1), q.enqueue(J2)]);
      await vi.waitFor(() => expect(done).toBe(2), { timeout: 5_000 });
      expect(max).toBe(expectedMax);
      await q.close();
    }
  });

  it('close() is graceful: waits for the running job, then rejects new work; repeated close is a no-op', async () => {
    newPrefix();
    const q = make();
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered = vi.fn();
    await q.start(async () => {
      entered();
      await gate;
      finished = true;
    });
    await q.enqueue(J1);
    await vi.waitFor(() => expect(entered).toHaveBeenCalled(), { timeout: 5_000 });
    const closing = q.close();
    await sleep(100);
    expect(finished).toBe(false); // close дуусаагүй, ажлыг хүлээж байна
    release();
    await closing;
    expect(finished).toBe(true);
    await expect(q.close()).resolves.toBeUndefined();
    await expect(q.enqueue(J2)).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('enqueue() fails fast with REDIS_UNAVAILABLE instead of hanging while Redis stops answering writes', async () => {
    newPrefix();
    const q = make({ enqueueTimeoutMs: 300 });
    await q.enqueue(J2); // холболтыг урьдчилан үүсгэнэ
    await admin.call('CLIENT', 'PAUSE', '1500', 'WRITE'); // бичих командууд (Lua script) 1.5с хариулахгүй
    const started = Date.now();
    await expect(q.enqueue(J1)).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(1_000);
    await sleep(1_600); // pause дууссан; хоцорсон нэмэлт болон давтан enqueue нь jobId-аар нэг л ажил болно
    await q.enqueue(J1);
    expect(await stateOf(q, J1)).toBe('waiting');
    const jobs = await admin.lrange(`${prefix}:bsa-import:wait`, 0, -1);
    expect(jobs.filter((id) => id === J1)).toHaveLength(1);
  });

  it('rejects starting the worker twice and invalid job ids', async () => {
    newPrefix();
    const q = make();
    await q.start(async () => undefined);
    await expect(q.start(async () => undefined)).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
    await expect(q.enqueue('42')).rejects.toBeInstanceOf(ImportQueueError);
    await expect(q.enqueue('a:b')).rejects.toMatchObject({ code: 'INVALID_JOB_ID' });
  });
});
