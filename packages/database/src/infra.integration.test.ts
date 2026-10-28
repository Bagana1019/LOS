// Бодит Redis/Postgres хэрэгтэй: REDIS_URL, TEST_DATABASE_URL тавигдаагүй бол алгасна (CI-д service container).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisEventBus, type EventBus } from './event-bus';
import { buildEvent, OutboxRelay } from './outbox';

const REDIS_URL = process.env.REDIS_URL;
const PG_URL = process.env.TEST_DATABASE_URL;
const ctx = { orgId: 'o1', userId: 'u1', correlationId: 'corr' };
const ev = (key = 'k') => buildEvent(ctx, 'SettingsChanged', { key, productId: null });
const until = async (cond: () => boolean, ms = 8000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout waiting for condition'); await new Promise((r) => setTimeout(r, 25)); } };

describe.skipIf(!REDIS_URL)('Redis Streams event bus', () => {
  const stream = `test:events:${randomUUID()}`;
  const buses: EventBus[] = [];
  const mk = () => { const b = createRedisEventBus(REDIS_URL!, { stream }); buses.push(b); return b; };
  afterAll(async () => { await Promise.all(buses.map((b) => b.close())); });

  it('delivers to every consumer group and filters by event type', async () => {
    const bus = mk();
    const a: string[] = []; const b: string[] = []; const other: string[] = [];
    await bus.subscribe('g-a', ['SettingsChanged'], async (e) => { a.push(e.eventId); });
    await bus.subscribe('g-b', ['SettingsChanged'], async (e) => { b.push(e.eventId); });
    await bus.subscribe('g-other', ['KycCompleted'], async (e) => { other.push(e.eventId); });
    const e1 = ev(); await bus.publish(e1);
    await until(() => a.length === 1 && b.length === 1);
    expect(a).toEqual([e1.eventId]); expect(b).toEqual([e1.eventId]);
    await new Promise((r) => setTimeout(r, 200));
    expect(other).toEqual([]);
  });
  it('a new group still receives events published before it existed', async () => {
    const bus = mk(); const e = ev('early'); await bus.publish(e);
    const got: string[] = [];
    await bus.subscribe('late-group', ['SettingsChanged'], async (x) => { got.push(x.eventId); });
    await until(() => got.includes(e.eventId));
  });
  it('redelivers after a handler failure, then succeeds', async () => {
    const bus = mk(); let calls = 0; const e = ev('retry'); const ok: string[] = [];
    await bus.subscribe('g-retry', ['SettingsChanged'], async (x) => { if (x.eventId !== e.eventId) return; calls++; if (calls < 3) throw new Error('flaky'); ok.push(x.eventId); }, { retryAfterMs: 50, maxDeliveries: 10 });
    await bus.publish(e);
    await until(() => ok.length === 1);
    expect(calls).toBe(3);
  });
  it('moves a poison message to the dead-letter stream after maxDeliveries', async () => {
    const bus = mk(); const e = ev('poison'); let calls = 0;
    await bus.subscribe('g-poison', ['SettingsChanged'], async (x) => { if (x.eventId === e.eventId) { calls++; throw new Error('always'); } }, { retryAfterMs: 30, maxDeliveries: 3 });
    await bus.publish(e);
    const { Redis } = await import('ioredis');
    const r = new Redis(REDIS_URL!);
    try {
      await until(() => calls >= 3);
      await new Promise((res) => setTimeout(res, 150));
      const dl = await r.xrange(`${stream}:dlq`, '-', '+');
      expect(dl.some(([, f]) => f.includes(e.eventId) || f.some((v) => v.includes(e.eventId)))).toBe(true);
    } finally { r.disconnect(); }
  });
});

describe.skipIf(!PG_URL)('OutboxRelay (Postgres)', () => {
  const schema = `relay_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  let pool: pg.Pool;
  const db = {
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({ $queryRawUnsafe: async (q: string, ...v: unknown[]) => (await c.query(q, v)).rows, $executeRawUnsafe: async (q: string, ...v: unknown[]) => (await c.query(q, v)).rowCount });
        await c.query('COMMIT');
        return out;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
  };
  const insert = async (e: ReturnType<typeof ev>, at: string) => pool.query(`INSERT INTO "${schema}".outbox (id, type, payload, created_at) VALUES ($1,$2,$3,$4)`, [e.eventId, e.type, JSON.stringify(e), at]);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".outbox (id text PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz)`);
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });

  it('rejects unsafe schema names', () => {
    expect(() => new OutboxRelay({ db, schema: 'a"; drop table x;--', bus: { publish: async () => {} } })).toThrow(/Invalid schema/);
  });
  it('publishes in created_at order, marks rows published, and is a no-op the second time', async () => {
    const a = ev('a'), b = ev('b'), c = ev('c');
    await insert(c, '2026-10-28T10:00:03Z'); await insert(a, '2026-10-28T10:00:01Z'); await insert(b, '2026-10-28T10:00:02Z');
    const sent: string[] = [];
    const relay = new OutboxRelay({ db, schema, bus: { publish: async (e) => { sent.push(e.eventId); } } });
    expect(await relay.relayOnce()).toBe(3);
    expect(sent).toEqual([a.eventId, b.eventId, c.eventId]);
    expect(await relay.relayOnce()).toBe(0);
  });
  it('stops at the first failure, keeps that row unpublished and retries it next time', async () => {
    const x = ev('x'), y = ev('y'), z = ev('z');
    await insert(x, '2026-10-28T11:00:01Z'); await insert(y, '2026-10-28T11:00:02Z'); await insert(z, '2026-10-28T11:00:03Z');
    let failY = true; const sent: string[] = []; const errors: string[] = [];
    const relay = new OutboxRelay({ db, schema, log: (_l, m) => errors.push(m), bus: { publish: async (e) => { if (e.eventId === y.eventId && failY) throw new Error('redis down'); sent.push(e.eventId); } } });
    expect(await relay.relayOnce()).toBe(1);
    expect(errors[0]).toContain('redis down');
    failY = false;
    expect(await relay.relayOnce()).toBe(2);
    expect(sent).toEqual([x.eventId, y.eventId, z.eventId]);
  });
  it('two relays never publish the same row twice (SKIP LOCKED)', async () => {
    const evs = Array.from({ length: 20 }, (_, i) => ev(`p${i}`));
    for (const [i, e] of evs.entries()) await insert(e, `2026-10-28T12:00:${String(i).padStart(2, '0')}Z`);
    const sent: string[] = [];
    const mk = () => new OutboxRelay({ db, schema, batchSize: 5, bus: { publish: async (e) => { await new Promise((r) => setTimeout(r, 5)); sent.push(e.eventId); } } });
    const [r1, r2] = [mk(), mk()];
    await Promise.all([r1.relayOnce(), r2.relayOnce(), r1.relayOnce(), r2.relayOnce(), r1.relayOnce(), r2.relayOnce()]);
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.length).toBe(20);
  });
});
