// Delivery counting / dead-letter semantics. Requires real Redis (REDIS_URL); skipped otherwise.
// Default (no new options) must stay exactly as before: every handler error counts, DLQ after maxDeliveries.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisEventBus, type EventBus } from './event-bus';
import { buildEvent } from './outbox';

const REDIS_URL = process.env.REDIS_URL;
const ctx = { orgId: 'o1', userId: 'u1', correlationId: 'corr' };
const settings = () => buildEvent(ctx, 'SettingsChanged', { key: 'k', productId: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await sleep(25); } };
const FAST = { retryAfterMs: 50, blockMs: 50 };

class Transient extends Error { override name = 'Transient'; }

describe.skipIf(!REDIS_URL)('event bus: delivery counting and dead-letter', () => {
  const buses: EventBus[] = [];
  const redis = new Redis(REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true });
  const streams: string[] = [];
  const mk = () => { const stream = `test:retry:${randomUUID()}`; streams.push(stream, `${stream}:dlq`); const b = createRedisEventBus(REDIS_URL!, { stream }); buses.push(b); return { bus: b, stream }; };
  const dlq = async (stream: string) => (await redis.xrange(`${stream}:dlq`, '-', '+')).map(([, f]) => f);
  afterAll(async () => { await Promise.all(buses.map((b) => b.close())); if (streams.length) await redis.del(...streams); redis.disconnect(); });

  it('default: every handler error counts — dead-lettered (with group + error) and acked after maxDeliveries attempts', async () => {
    const { bus, stream } = mk();
    let calls = 0;
    const e = settings();
    await bus.subscribe('g-default', ['SettingsChanged'], async () => { calls++; throw new Error('boom'); }, { ...FAST, maxDeliveries: 3 });
    await bus.publish(e);
    await until(async () => (await dlq(stream)).length === 1);
    await sleep(300);
    expect(calls).toBe(3);
    const [fields] = await dlq(stream);
    expect(fields).toEqual(expect.arrayContaining(['group', 'g-default', 'error', 'boom', 'eventId', e.eventId]));
    expect(await redis.xpending(stream, 'g-default')).toEqual([0, null, null, null]);
  });

  it('isTransientError: transient failures never consume a delivery attempt (no DLQ, delivered once the fault clears)', async () => {
    const { bus, stream } = mk();
    let calls = 0; const done: string[] = [];
    const e = settings();
    await bus.subscribe('g-transient', ['SettingsChanged'], async (ev) => { calls++; if (calls <= 6) throw new Transient('dwh down'); done.push(ev.eventId); },
      { ...FAST, maxDeliveries: 2, isTransientError: (err) => err instanceof Transient });
    await bus.publish(e);
    await until(() => done.length === 1);
    expect(calls).toBe(7);
    expect(await dlq(stream)).toEqual([]);
  });

  it('isTransientError: only deterministic failures count — DLQ after exactly maxDeliveries of them, however many transient ones came first', async () => {
    const { bus, stream } = mk();
    const kinds: string[] = [];
    await bus.subscribe('g-mixed', ['SettingsChanged'], async () => {
      const transient = kinds.filter((k) => k === 'T').length < 4;
      kinds.push(transient ? 'T' : 'D');
      throw transient ? new Transient('down') : new Error('poison');
    }, { ...FAST, maxDeliveries: 2, isTransientError: (err) => err instanceof Transient });
    await bus.publish(settings());
    await until(async () => (await dlq(stream)).length === 1);
    await sleep(300);
    expect(kinds).toEqual(['T', 'T', 'T', 'T', 'D', 'D']);
  });

  it('onDeadLetter is called once per dead-lettered message with the error and the parsed event', async () => {
    const { bus } = mk();
    const seen: { msg: string; eventId?: string }[] = [];
    const e = settings();
    await bus.subscribe('g-dl', ['SettingsChanged'], async () => { throw new Error('nope'); },
      { ...FAST, maxDeliveries: 2, onDeadLetter: (err, ev) => seen.push({ msg: (err as Error).message, eventId: ev?.eventId }) });
    await bus.publish(e);
    await until(() => seen.length === 1);
    await sleep(300);
    expect(seen).toEqual([{ msg: 'nope', eventId: e.eventId }]);
  });

  it('a throwing isTransientError is treated as deterministic (counts toward the DLQ, never loops forever)', async () => {
    const { bus, stream } = mk();
    await bus.subscribe('g-bad-classifier', ['SettingsChanged'], async () => { throw new Error('x'); },
      { ...FAST, maxDeliveries: 2, isTransientError: () => { throw new Error('classifier bug'); } });
    await bus.publish(settings());
    await until(async () => (await dlq(stream)).length === 1);
  });
});
