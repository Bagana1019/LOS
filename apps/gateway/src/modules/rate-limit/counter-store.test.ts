// M9 — shared (Redis) rate-limit counters for multiple gateway pods; memory only outside production.
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { FallbackCounterStore, MemoryCounterStore, RedisCounterStore, createCounterStore, type CounterStore } from './counter-store';
import { CounterThrottlerStorage } from './throttler.storage';

const REDIS_URL = process.env.REDIS_URL;

describe('MemoryCounterStore', () => {
  it('counts hits inside a fixed window and resets after it', async () => {
    let now = 1_000;
    const s = new MemoryCounterStore({ now: () => now });
    expect(await s.hit('k', 1000)).toEqual({ count: 1, resetMs: 1000 });
    now += 400;
    expect(await s.hit('k', 1000)).toEqual({ count: 2, resetMs: 600 });
    expect(await s.peek('k')).toEqual({ count: 2, resetMs: 600 });
    now += 600;
    expect(await s.peek('k')).toEqual({ count: 0, resetMs: 0 });
    expect((await s.hit('k', 1000)).count).toBe(1);
  });
  it('keys are independent; clear removes one key', async () => {
    const s = new MemoryCounterStore();
    await s.hit('a', 60_000); await s.hit('a', 60_000); await s.hit('b', 60_000);
    await s.clear('a');
    expect((await s.peek('a')).count).toBe(0);
    expect((await s.peek('b')).count).toBe(1);
  });
  it('bounds memory: evicts the oldest key beyond maxKeys', async () => {
    const s = new MemoryCounterStore({ maxKeys: 2 });
    await s.hit('1', 60_000); await s.hit('2', 60_000); await s.hit('3', 60_000);
    expect((await s.peek('1')).count).toBe(0);
    expect((await s.peek('3')).count).toBe(1);
  });
});

describe('createCounterStore (startup policy)', () => {
  it('production without REDIS_URL fails fast', () => {
    expect(() => createCounterStore({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });
  it('outside production without REDIS_URL → in-memory store', async () => {
    const { store, close } = createCounterStore({ NODE_ENV: 'development' });
    expect(store).toBeInstanceOf(MemoryCounterStore);
    await close();
  });
});

describe('CounterThrottlerStorage (ThrottlerStorage contract)', () => {
  it('blocks after `limit` hits for blockDuration, reporting seconds to expiry', async () => {
    const t = new CounterThrottlerStorage(new MemoryCounterStore(), 'p:');
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await t.increment('key', 60_000, 3, 30_000, 'default'));
    expect(r.map((x) => x.isBlocked)).toEqual([false, false, false, true]);
    expect(r[0]).toMatchObject({ totalHits: 1, timeToExpire: 60 });
    expect(r[3]!.timeToBlockExpire).toBe(30);
    expect((await t.increment('key', 60_000, 3, 30_000, 'default')).isBlocked).toBe(true);
  });
  it('throttler names do not share counters', async () => {
    const t = new CounterThrottlerStorage(new MemoryCounterStore(), 'p:');
    await t.increment('key', 60_000, 1, 60_000, 'a');
    expect((await t.increment('key', 60_000, 1, 60_000, 'b')).isBlocked).toBe(false);
  });
});

describe('FallbackCounterStore', () => {
  const broken: CounterStore = { hit: async () => { throw new Error('ECONNREFUSED'); }, peek: async () => { throw new Error('ECONNREFUSED'); }, clear: async () => { throw new Error('ECONNREFUSED'); } };
  it('keeps limiting (per pod) when the shared store fails instead of failing every request', async () => {
    const s = new FallbackCounterStore(broken, new MemoryCounterStore());
    expect((await s.hit('k', 60_000)).count).toBe(1);
    expect((await s.hit('k', 60_000)).count).toBe(2);
    expect((await s.peek('k')).count).toBe(2);
    await expect(s.clear('k')).resolves.toBeUndefined();
  });
});

describe.skipIf(!REDIS_URL)('RedisCounterStore (two pods share one Redis)', () => {
  const clients: Redis[] = [];
  const mk = () => { const c = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1 }); clients.push(c); return new RedisCounterStore(c); };
  afterAll(async () => { await Promise.all(clients.map((c) => c.quit())); });

  it('hits from two pods add up on the same key', async () => {
    const [a, b] = [mk(), mk()];
    const k = `test:${randomUUID()}`;
    await a.hit(k, 60_000); await b.hit(k, 60_000);
    const r = await a.hit(k, 60_000);
    expect(r.count).toBe(3);
    expect(r.resetMs).toBeGreaterThan(55_000);
    expect((await b.peek(k)).count).toBe(3);
    await b.clear(k);
    expect(await a.peek(k)).toEqual({ count: 0, resetMs: 0 });
  });
  it('concurrent hits are atomic (no lost increments)', async () => {
    const [a, b] = [mk(), mk()];
    const k = `test:${randomUUID()}`;
    await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).hit(k, 60_000)));
    expect((await a.peek(k)).count).toBe(50);
  });
  it('window expires in Redis (PEXPIRE set on first hit)', async () => {
    const a = mk();
    const k = `test:${randomUUID()}`;
    await a.hit(k, 150);
    await new Promise((r) => setTimeout(r, 250));
    expect((await a.peek(k)).count).toBe(0);
  });
  it('a ThrottlerStorage on each pod enforces one shared limit', async () => {
    const prefix = `test:${randomUUID()}:`;
    const [a, b] = [new CounterThrottlerStorage(mk(), prefix), new CounterThrottlerStorage(mk(), prefix)];
    const blocked = [];
    for (let i = 0; i < 4; i++) blocked.push((await (i % 2 ? a : b).increment('ip', 60_000, 3, 60_000, 'default')).isBlocked);
    expect(blocked).toEqual([false, false, false, true]);
  });
});
