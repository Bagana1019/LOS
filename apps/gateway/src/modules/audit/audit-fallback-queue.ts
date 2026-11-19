import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

// M10 — iam.audit_log-д бичиж чадаагүй аудитын мөрийг түр хадгалах durable дараалал (Redis list, AOF). AuditService дараа нь DB руу шилжүүлнэ.
// Production-д REDIS_URL заавал (fail fast); бусад орчинд REDIS_URL байхгүй бол санах ой (durable биш — dev/test л).

export const AUDIT_FALLBACK_QUEUE = Symbol('AUDIT_FALLBACK_QUEUE');
export const AUDIT_FALLBACK_KEY = 'los:gateway:audit:fallback';
const LOCK_TTL_MS = 30_000;

/** iam.audit_log-ийн мөр (id, at клиентэд үүснэ — давтан бичилт/drain idempotent). */
export interface AuditRow {
  id: string; orgId: string | null; entity: string; entityId: string; action: string; actorId: string | null; at: Date;
  beforeJson: unknown; afterJson: unknown; applicationId: string | null; correlationId: string | null; ip: string | null; userAgent: string | null;
}

export interface AuditFallbackQueue {
  push(row: AuditRow): Promise<void>;
  /** Толгойн n элемент (устгахгүй). Задрахгүй (эвдэрсэн) элемент `null` — тоонд орно, drop-оор арилна. */
  peek(n: number): Promise<(AuditRow | null)[]>;
  /** Толгойн n элементийг устгана (peek → DB-д бичсэний дараа). */
  drop(n: number): Promise<void>;
  size(): Promise<number>;
  /** Нэг л drainer (олон pod) — түгжээ авч чадаагүй бол null. */
  withLock<T>(fn: () => Promise<T>): Promise<T | null>;
  close?(): Promise<void>;
}

const serialize = (row: AuditRow): string => JSON.stringify(row);
function parse(raw: string): AuditRow | null {
  try {
    const o = JSON.parse(raw) as AuditRow & { at: string };
    if (!o || typeof o.id !== 'string' || typeof o.action !== 'string') return null;
    return { ...o, at: new Date(o.at) };
  } catch {
    return null;
  }
}

export class MemoryAuditQueue implements AuditFallbackQueue {
  private items: string[] = [];
  private locked = false;
  async push(row: AuditRow): Promise<void> { this.items = [...this.items, serialize(row)]; }
  async peek(n: number): Promise<(AuditRow | null)[]> { return this.items.slice(0, n).map(parse); }
  async drop(n: number): Promise<void> { this.items = this.items.slice(n); }
  async size(): Promise<number> { return this.items.length; }
  async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.locked) return null;
    this.locked = true;
    try { return await fn(); } finally { this.locked = false; }
  }
}

const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class RedisAuditQueue implements AuditFallbackQueue {
  constructor(private readonly redis: Redis, private readonly key = AUDIT_FALLBACK_KEY) {}
  async push(row: AuditRow): Promise<void> { await this.redis.rpush(this.key, serialize(row)); }
  async peek(n: number): Promise<(AuditRow | null)[]> { return (await this.redis.lrange(this.key, 0, n - 1)).map(parse); }
  async drop(n: number): Promise<void> { await this.redis.ltrim(this.key, n, -1); }
  async size(): Promise<number> { return this.redis.llen(this.key); }
  async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const lockKey = `${this.key}:drain-lock`;
    const token = randomUUID();
    if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') return null;
    try { return await fn(); } finally { await this.redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined); }
  }
  async close(): Promise<void> { this.redis.disconnect(); }
}

/** Эхлэх үеийн бодлого (rate-limit-ийн M9-тэй ижил): production + REDIS_URL байхгүй → алдаа; бусад орчинд → санах ой. */
export function createAuditFallbackQueue(env: NodeJS.ProcessEnv = process.env): AuditFallbackQueue {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    if (env.NODE_ENV === 'production') throw new Error('REDIS_URL is required in production: the gateway audit fallback queue must be durable (M10)');
    return new MemoryAuditQueue();
  }
  return new RedisAuditQueue(new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000 }));
}
