import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

// M10 — iam.audit_log-д бичиж чадаагүй аудитын мөрийг түр хадгалах durable дараалал (Redis list, AOF). AuditService дараа нь DB руу шилжүүлнэ.
// Production-д REDIS_URL заавал (fail fast); бусад орчинд REDIS_URL байхгүй бол санах ой (durable биш — dev/test л).
// Устгал нь ЗӨВХӨН lease (lock token) хүчинтэй БА толгой нь яг peek хийсэн элементүүд байвал (Lua, атомар) — lease дууссан pod
// өөр pod-ын авсан/шинэ мөрийг хэзээ ч устгахгүй. Байнгын алдаатай мөр DLQ руу (хязгаартай), `replayDeadLetters`-ээр буцаана.

export const AUDIT_FALLBACK_QUEUE = Symbol('AUDIT_FALLBACK_QUEUE');
export const AUDIT_FALLBACK_KEY = 'los:gateway:audit:fallback';
export const AUDIT_DLQ_KEY = 'los:gateway:audit:dlq';
export const AUDIT_DLQ_MAX_DEFAULT = 10_000;

/** iam.audit_log-ийн мөр (id, at клиентэд үүснэ — давтан бичилт/drain idempotent). */
export interface AuditRow {
  id: string; orgId: string | null; entity: string; entityId: string; action: string; actorId: string | null; at: Date;
  beforeJson: unknown; afterJson: unknown; applicationId: string | null; correlationId: string | null; ip: string | null; userAgent: string | null;
}
/** `raw` = дараалалд байгаа яг тэр мөр (устгалын харьцуулалтад); `row` = задалсан мөр, эвдэрсэн бол null. */
export interface QueuedItem { raw: string; row: AuditRow | null }
/** DLQ-ийн элемент: `raw` нь аль хэдийн ариутгасан мөр (replay-д хэрэгтэй); `errorClass` нь зөвхөн код (алдааны мессеж/утга биш). */
export interface DeadLetter { raw: string; id: string | null; errorClass: string; failedAt: string }
export interface DeadLetterResult { size: number; capacity: number; trimmed: DeadLetter[] }

export interface AuditFallbackQueue {
  push(row: AuditRow): Promise<void>;
  /** Толгойн n элемент (устгахгүй). */
  peek(n: number): Promise<QueuedItem[]>;
  size(): Promise<number>;
  /** Drain lease (нэг pod). Авч чадаагүй бол null. */
  acquire(ttlMs: number): Promise<string | null>;
  /** Token таарвал TTL-ийг сунгана; lease алдагдсан бол false. */
  renew(token: string, ttlMs: number): Promise<boolean>;
  release(token: string): Promise<void>;
  /** Token хүчинтэй БА толгой нь яг `raws` бол тэдгээрийг устгаад true; эс бөгөөс юу ч устгахгүй, false. */
  removeHead(raws: string[], token: string): Promise<boolean>;
  /** DLQ-д нэмнэ; `dlqMax`-аас хэтэрвэл хамгийн хуучныг тайрч, тайрсан БҮХ элементийг буцаана (дуудагч AUDIT_LOST гэж бүртгэнэ — чимээгүй устгахгүй). */
  deadLetter(d: DeadLetter): Promise<DeadLetterResult>;
  /** Хамгийн хуучнаас n элемент. */
  deadLetters(n: number): Promise<DeadLetter[]>;
  /** DLQ-ийн хамгийн хуучин n элементийг дарааллын сүүлд буцаана (шалтгааныг зассаны дараа). Шилжүүлсэн тоо. */
  replayDeadLetters(n: number): Promise<number>;
  close?(): Promise<void>;
}

const serialize = (row: AuditRow): string => JSON.stringify(row);
export function parseQueued(raw: string): AuditRow | null {
  try {
    const o = JSON.parse(raw) as AuditRow & { at: string };
    if (!o || typeof o.id !== 'string' || typeof o.action !== 'string' || typeof o.entity !== 'string') return null;
    const at = new Date(o.at);
    return Number.isNaN(at.getTime()) ? null : { ...o, at };
  } catch {
    return null;
  }
}
const item = (raw: string): QueuedItem => ({ raw, row: parseQueued(raw) });
function parseDead(raw: string): DeadLetter {
  try { return JSON.parse(raw) as DeadLetter; } catch { return { raw, id: null, errorClass: 'CORRUPT', failedAt: '' }; }
}

export interface MemoryQueueOptions { now?: () => number; dlqMax?: number }

export class MemoryAuditQueue implements AuditFallbackQueue {
  private items: string[] = [];
  private dead: string[] = [];
  private lease: { token: string; expiresAt: number } | null = null;
  private readonly now: () => number;
  private readonly dlqMax: number;
  constructor(o: MemoryQueueOptions = {}) { this.now = o.now ?? Date.now; this.dlqMax = o.dlqMax ?? AUDIT_DLQ_MAX_DEFAULT; }

  async push(row: AuditRow): Promise<void> { await this.pushRaw(serialize(row)); }
  /** Тестэд: эвдэрсэн элемент оруулах. */
  async pushRaw(raw: string): Promise<void> { this.items = [...this.items, raw]; }
  async peek(n: number): Promise<QueuedItem[]> { return this.items.slice(0, n).map(item); }
  async size(): Promise<number> { return this.items.length; }
  async acquire(ttlMs: number): Promise<string | null> {
    if (this.owner()) return null;
    this.lease = { token: randomUUID(), expiresAt: this.now() + ttlMs };
    return this.lease.token;
  }
  async renew(token: string, ttlMs: number): Promise<boolean> {
    if (this.owner() !== token) return false;
    this.lease = { token, expiresAt: this.now() + ttlMs };
    return true;
  }
  async release(token: string): Promise<void> { if (this.owner() === token) this.lease = null; }
  async removeHead(raws: string[], token: string): Promise<boolean> {
    if (this.owner() !== token || raws.some((r, i) => this.items[i] !== r)) return false;
    this.items = this.items.slice(raws.length);
    return true;
  }
  async deadLetter(d: DeadLetter): Promise<DeadLetterResult> {
    const all = [...this.dead, JSON.stringify(d)];
    const over = Math.max(0, all.length - this.dlqMax);
    this.dead = all.slice(over);
    return { size: this.dead.length, capacity: this.dlqMax, trimmed: all.slice(0, over).map(parseDead) };
  }
  async deadLetters(n: number): Promise<DeadLetter[]> { return this.dead.slice(0, n).map(parseDead); }
  async replayDeadLetters(n: number): Promise<number> {
    const moved = this.dead.slice(0, n);
    this.dead = this.dead.slice(moved.length);
    this.items = [...this.items, ...moved.map((d) => parseDead(d).raw)];
    return moved.length;
  }
  private owner(): string | null { return this.lease && this.lease.expiresAt > this.now() ? this.lease.token : null; }
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
// KEYS[1]=list, KEYS[2]=lock; ARGV[1]=token, ARGV[2..]=яг устгах толгойн элементүүд
const REMOVE_HEAD = `
if redis.call('get', KEYS[2]) ~= ARGV[1] then return 0 end
local n = #ARGV - 1
for i = 1, n do
  if redis.call('lindex', KEYS[1], i - 1) ~= ARGV[i + 1] then return 0 end
end
redis.call('ltrim', KEYS[1], n, -1)
return 1`;
// KEYS[1]=dlq; ARGV[1]=entry, ARGV[2]=max → {шинэ урт, тайрсан элементүүд...} (атомар: тайрсныг заавал буцаана)
const DEAD_LETTER = `
redis.call('rpush', KEYS[1], ARGV[1])
local out = {}
while redis.call('llen', KEYS[1]) > tonumber(ARGV[2]) do
  out[#out + 1] = redis.call('lpop', KEYS[1])
end
table.insert(out, 1, redis.call('llen', KEYS[1]))
return out`;
// KEYS[1]=dlq, KEYS[2]=list; ARGV[1]=n
const REPLAY = `
local moved = 0
for i = 1, tonumber(ARGV[1]) do
  local v = redis.call('lpop', KEYS[1])
  if not v then break end
  local ok, d = pcall(cjson.decode, v)
  redis.call('rpush', KEYS[2], (ok and type(d) == 'table' and d.raw) or v)
  moved = moved + 1
end
return moved`;

export interface RedisQueueOptions { key?: string; dlqKey?: string; dlqMax?: number }

export class RedisAuditQueue implements AuditFallbackQueue {
  private readonly key: string;
  private readonly lockKey: string;
  private readonly dlqKey: string;
  private readonly dlqMax: number;
  constructor(private readonly redis: Redis, o: RedisQueueOptions = {}) {
    this.key = o.key ?? AUDIT_FALLBACK_KEY;
    this.lockKey = `${this.key}:drain-lock`;
    this.dlqKey = o.dlqKey ?? AUDIT_DLQ_KEY;
    this.dlqMax = o.dlqMax ?? AUDIT_DLQ_MAX_DEFAULT;
  }
  async push(row: AuditRow): Promise<void> { await this.redis.rpush(this.key, serialize(row)); }
  async peek(n: number): Promise<QueuedItem[]> { return (await this.redis.lrange(this.key, 0, n - 1)).map(item); }
  async size(): Promise<number> { return this.redis.llen(this.key); }
  async acquire(ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    return (await this.redis.set(this.lockKey, token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null;
  }
  async renew(token: string, ttlMs: number): Promise<boolean> { return (await this.redis.eval(RENEW, 1, this.lockKey, token, ttlMs)) === 1; }
  async release(token: string): Promise<void> { await this.redis.eval(RELEASE, 1, this.lockKey, token); }
  async removeHead(raws: string[], token: string): Promise<boolean> {
    if (raws.length === 0) return true;
    return (await this.redis.eval(REMOVE_HEAD, 2, this.key, this.lockKey, token, ...raws)) === 1;
  }
  async deadLetter(d: DeadLetter): Promise<DeadLetterResult> {
    const [size, ...popped] = (await this.redis.eval(DEAD_LETTER, 1, this.dlqKey, JSON.stringify(d), this.dlqMax)) as [number, ...string[]];
    return { size: Number(size), capacity: this.dlqMax, trimmed: popped.map(parseDead) };
  }
  async deadLetters(n: number): Promise<DeadLetter[]> { return (await this.redis.lrange(this.dlqKey, 0, n - 1)).map(parseDead); }
  async replayDeadLetters(n: number): Promise<number> { return Number(await this.redis.eval(REPLAY, 2, this.dlqKey, this.key, n)); }
  async close(): Promise<void> { this.redis.disconnect(); }
}

/** Эхлэх үеийн бодлого (rate-limit-ийн M9-тэй ижил): production + REDIS_URL байхгүй → алдаа; бусад орчинд → санах ой. */
export function createAuditFallbackQueue(env: NodeJS.ProcessEnv = process.env): AuditFallbackQueue {
  const url = env.REDIS_URL?.trim();
  const dlqMax = Number(env.AUDIT_DLQ_MAX) > 0 ? Number(env.AUDIT_DLQ_MAX) : AUDIT_DLQ_MAX_DEFAULT;
  if (!url) {
    if (env.NODE_ENV === 'production') throw new Error('REDIS_URL is required in production: the gateway audit fallback queue must be durable (M10)');
    return new MemoryAuditQueue({ dlqMax });
  }
  return new RedisAuditQueue(new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000 }), { dlqMax });
}
