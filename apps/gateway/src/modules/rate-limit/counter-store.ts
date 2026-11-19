import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

// M9 — gateway-ийн rate limit тоолуур. Олон pod: Redis (REDIS_URL) — бүх pod нэг тоолуур. Production-д Redis заавал (fail fast);
// бусад орчинд REDIS_URL байхгүй бол санах ой. Ажиллаж байх үед Redis унавал хүсэлт бүрийг 500 болгохын оронд pod тус бүрийн
// санах ойн тоолуур руу түр шилжинэ (хязгаар × pod-ын тоо болж сулрах ч хязгааргүй болохгүй) — FallbackCounterStore.

export interface CounterState { count: number; resetMs: number }
export interface CounterStore {
  /** Тогтмол цонхонд нэг тоолно; эхний hit цонхыг эхлүүлнэ. */
  hit(key: string, windowMs: number): Promise<CounterState>;
  /** Тоолохгүйгээр одоогийн төлөв (цонх дууссан/байхгүй бол 0). */
  peek(key: string): Promise<CounterState>;
  clear(key: string): Promise<void>;
}

const EMPTY: CounterState = { count: 0, resetMs: 0 };

export class MemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: { now?: () => number; maxKeys?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxKeys = opts.maxKeys ?? 100_000;
  }

  async hit(key: string, windowMs: number): Promise<CounterState> {
    const now = this.now();
    let e = this.live(key, now);
    if (!e) {
      if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value as string);
      e = { count: 0, resetAt: now + windowMs };
    }
    const next = { count: e.count + 1, resetAt: e.resetAt };
    this.entries.set(key, next);
    return { count: next.count, resetMs: next.resetAt - now };
  }

  async peek(key: string): Promise<CounterState> {
    const now = this.now();
    const e = this.live(key, now);
    return e ? { count: e.count, resetMs: e.resetAt - now } : EMPTY;
  }

  async clear(key: string): Promise<void> { this.entries.delete(key); }

  private live(key: string, now: number) {
    const e = this.entries.get(key);
    if (e && e.resetAt <= now) { this.entries.delete(key); return undefined; }
    return e;
  }
}

// INCR + цонх (PEXPIRE) атомар; PTTL < 0 (expire алга) бол дахин тавина.
const HIT_LUA = `local c = redis.call('INCR', KEYS[1])
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;
const PEEK_LUA = `local c = redis.call('GET', KEYS[1])
if not c then return {0, 0} end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then t = 0 end
return {tonumber(c), t}`;

export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowMs: number): Promise<CounterState> {
    const [count, resetMs] = (await this.redis.eval(HIT_LUA, 1, key, String(Math.max(1, Math.ceil(windowMs))))) as [number, number];
    return { count, resetMs };
  }

  async peek(key: string): Promise<CounterState> {
    const [count, resetMs] = (await this.redis.eval(PEEK_LUA, 1, key)) as [number, number];
    return count > 0 ? { count, resetMs } : EMPTY;
  }

  async clear(key: string): Promise<void> { await this.redis.del(key); }
}

/** Үндсэн (Redis) store алдаа өгвөл тухайн дуудлагыг санах ойн store-оор гүйцэтгэнэ; шилжилт бүрийг нэг удаа логлоно. */
export class FallbackCounterStore implements CounterStore {
  private readonly log = new Logger('RateLimitStore');
  private degraded = false;

  constructor(private readonly primary: CounterStore, private readonly fallback: CounterStore) {}

  hit(key: string, windowMs: number) { return this.run((s) => s.hit(key, windowMs)); }
  peek(key: string) { return this.run((s) => s.peek(key)); }
  clear(key: string) { return this.run((s) => s.clear(key)); }

  private async run<T>(op: (s: CounterStore) => Promise<T>): Promise<T> {
    try {
      const r = await op(this.primary);
      if (this.degraded) { this.degraded = false; this.log.log('shared rate-limit store recovered'); }
      return r;
    } catch (e) {
      if (!this.degraded) {
        this.degraded = true;
        this.log.error(`shared rate-limit store unavailable, using per-pod memory: ${e instanceof Error ? e.message : String(e)}`);
      }
      return op(this.fallback);
    }
  }
}

export interface CounterStoreHandle { store: CounterStore; close(): Promise<void> }

/** Эхлэх үеийн бодлого: production + REDIS_URL байхгүй → алдаа; бусад орчинд REDIS_URL байхгүй → санах ой. */
export function createCounterStore(env: NodeJS.ProcessEnv = process.env): CounterStoreHandle {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    if (env.NODE_ENV === 'production') {
      throw new Error('REDIS_URL is required in production: gateway rate limits must be shared across pods (M9)');
    }
    return { store: new MemoryCounterStore(), close: async () => undefined };
  }
  // offline queue унтраалттай: Redis тасарсан үед команд хүлээлгүй шууд алдаа өгч fallback руу шилжинэ
  const redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  redis.on('error', () => undefined); // FallbackCounterStore логлоно
  return {
    store: new FallbackCounterStore(new RedisCounterStore(redis), new MemoryCounterStore()),
    close: async () => { await redis.quit().catch(() => redis.disconnect()); },
  };
}
