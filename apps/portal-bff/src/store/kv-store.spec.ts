import { describe, expect, it } from 'vitest';
import { FakeClock } from '../testing/test-app';
import type { KvStore } from './kv-store';
import { MemoryKvStore } from './memory-kv-store';
import { RedisKvStore } from './redis-kv-store';

const TTL = 2; // секунд (Redis-д жинхэнэ цаг хүлээнэ)

/** Нэг гэрээ (contract) тест: Memory болон (TEST_REDIS_URL өгвөл) Redis хэрэгжүүлэлтэд адил биеэ авч явна. */
function contract(make: () => { store: KvStore; wait: (sec: number) => Promise<void>; close?: () => Promise<void> }) {
  const key = () => `t:${Math.random().toString(36).slice(2)}`;

  it('get/set/del with TTL', async () => {
    const { store, wait } = make();
    const k = key();
    expect(await store.get(k)).toBeNull();
    await store.set(k, 'v', TTL);
    expect(await store.get(k)).toBe('v');
    await wait(TTL + 0.3);
    expect(await store.get(k)).toBeNull();
    await store.set(k, 'v', 60);
    await store.del(k);
    expect(await store.get(k)).toBeNull();
  });

  it('setIfAbsent only creates once', async () => {
    const { store, wait } = make();
    const k = key();
    expect(await store.setIfAbsent(k, 'a', TTL)).toBe(true);
    expect(await store.setIfAbsent(k, 'b', TTL)).toBe(false);
    expect(await store.get(k)).toBe('a');
    await wait(TTL + 0.3);
    expect(await store.setIfAbsent(k, 'c', TTL)).toBe(true);
  });

  it('getAndDelete is single-use even under concurrency', async () => {
    const { store } = make();
    const k = key();
    await store.set(k, 'once', 60);
    const results = await Promise.all([store.getAndDelete(k), store.getAndDelete(k), store.getAndDelete(k)]);
    expect(results.filter((r) => r === 'once')).toHaveLength(1);
    expect(await store.get(k)).toBeNull();
  });

  it('incr is atomic and the window TTL is set at creation only', async () => {
    const { store, wait } = make();
    const k = key();
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.incr(k, TTL)));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await wait(1.2);
    expect(await store.incr(k, TTL)).toBe(21); // хугацаа сунгагдаагүй
    await wait(1.0); // нийт 2.2с > TTL
    expect(await store.incr(k, TTL)).toBe(1); // шинэ цонх
  });

  it('ttl reports remaining seconds, 0 when missing', async () => {
    const { store, wait } = make();
    const k = key();
    expect(await store.ttl(k)).toBe(0);
    await store.set(k, 'x', 30);
    const t = await store.ttl(k);
    expect(t).toBeGreaterThan(25);
    expect(t).toBeLessThanOrEqual(30);
    await store.set(k, 'x', TTL);
    await wait(TTL + 0.3);
    expect(await store.ttl(k)).toBe(0);
  });
}

describe('MemoryKvStore', () => {
  contract(() => {
    const clock = new FakeClock(new Date('2026-10-28T00:00:00Z'));
    return { store: new MemoryKvStore(clock), wait: async (sec) => clock.advance(sec * 1000) };
  });
});

const redisUrl = process.env.TEST_REDIS_URL;
describe.skipIf(!redisUrl)('RedisKvStore (TEST_REDIS_URL)', () => {
  contract(() => ({ store: new RedisKvStore(redisUrl as string), wait: (sec) => new Promise((r) => setTimeout(r, sec * 1000)) }));
});
