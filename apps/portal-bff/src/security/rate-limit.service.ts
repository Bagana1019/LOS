import { Inject, Injectable } from '@nestjs/common';
import { PortalError } from '../common/portal-error';
import { KV_STORE, type KvStore } from '../store/kv-store';

export interface RateRule {
  /** Bucket-ийн нэр (түлхүүрийн хэсэг + аудит). */
  name: string;
  limit: number;
  windowSec: number;
}

/** Тогтмол цонхтой (fixed window) тоолуур. Цонхны захад 2× burst гарч болох ч энгийн, атомар. */
@Injectable()
export class RateLimitService {
  constructor(@Inject(KV_STORE) private readonly store: KvStore) {}

  /** Хязгаар хэтэрвэл `RATE_LIMITED` + Retry-After. `subject` нь IP / customerId / HMAC хэш — plain PII биш. */
  async enforce(rule: RateRule, subject: string): Promise<void> {
    const key = `rl:${rule.name}:${subject}`;
    const count = await this.store.incr(key, rule.windowSec);
    if (count > rule.limit) {
      const retryAfter = Math.max(1, await this.store.ttl(key));
      throw new PortalError('RATE_LIMITED', undefined, { 'Retry-After': String(retryAfter) });
    }
  }
}
