// NFR-3 / FR-11.4 — public e-sign замын түр rate limiter. ХЯЗГААРЛАЛТ: процессын санах ойд тоолно (олон instance ажиллуулбал instance бүр тусдаа тоолно).
// Gateway-ийн нэгдсэн rate limiter (NFR, auth/rate-limit модуль) ороход энэ файлыг түүгээр сольж, ProxyModule дахь RATE_LIMITER provider-ийг шинэчилнэ.

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export interface RateLimiterOptions {
  windowMs: number;
  /** Нэгэн зэрэг хадгалах түлхүүрийн дээд тоо — санах ойн хязгаар */
  maxKeys: number;
  /** Монотон цаг (мс). Тестэд солино; өгөөгүй бол `performance.now()` — системийн цагийн үсрэлтэд нөлөөлөгддөггүй */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Хориглосон үед дахин оролдох хүртэлх секунд (>= 1); зөвшөөрсөн үед 0 */
  retryAfterSec: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Тогтмол цонхтой (fixed window) тоолуур. Түлхүүр бүрийн цонх анх орсон мөчөөс эхэлдэг тул Map-ын оруулах дараалал нь `resetAt`-аар эрэмбэлэгдсэн
 * байдаг: дууссан түлхүүрүүдийг урд талаас нь л цэвэрлэнэ (хүсэлт бүрт O(1) амортизацтай, таймергүй). Санах ой `maxKeys`-ээр хязгаарлагдана;
 * дүүрсэн үед хамгийн хуучин түлхүүрийг гаргана (олон мянган өөр IP-ээр дүүргэж эхлэгчийн өөрийн тоолуурууд л унана).
 */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys;
    this.now = options.now ?? (() => performance.now());
  }

  /** Түлхүүрт нэг хүсэлт тоолно. `limit` — тухайн цонхонд зөвшөөрөх дээд тоо. */
  consume(key: string, limit: number): RateLimitDecision {
    const now = this.now();
    this.evictExpired(now);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) this.evictOldest();
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) {
      return { allowed: false, limit, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    entry.count += 1;
    return { allowed: true, limit, remaining: limit - entry.count, retryAfterSec: 0 };
  }

  /** Хадгалагдаж буй түлхүүрийн тоо (тест/мониторинг). */
  get size(): number {
    return this.entries.size;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt > now) break;
      this.entries.delete(key);
    }
  }

  private evictOldest(): void {
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}
