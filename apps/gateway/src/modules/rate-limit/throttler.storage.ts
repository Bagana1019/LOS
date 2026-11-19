import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { CounterStore } from './counter-store';

/**
 * M9 — @nestjs/throttler-ийн storage-ийг CounterStore (Redis/санах ой) дээр. Тогтмол цонх; `limit` хэтэрвэл `blockDuration` хугацаанд хаана.
 * Хугацааг throttler-ийн гэрээгээр секундээр буцаана.
 */
export class CounterThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly store: CounterStore, private readonly prefix: string) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}t:${throttlerName}:${key}`;
    const block = await this.store.peek(`${base}:b`);
    const hits = await this.store.hit(base, ttl);
    const toSec = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
    if (block.count > 0) return { totalHits: hits.count, timeToExpire: toSec(hits.resetMs), isBlocked: true, timeToBlockExpire: Math.max(1, toSec(block.resetMs)) };
    if (hits.count > limit) {
      const b = await this.store.hit(`${base}:b`, blockDuration);
      return { totalHits: hits.count, timeToExpire: toSec(hits.resetMs), isBlocked: true, timeToBlockExpire: Math.max(1, toSec(b.resetMs)) };
    }
    return { totalHits: hits.count, timeToExpire: toSec(hits.resetMs), isBlocked: false, timeToBlockExpire: 0 };
  }
}
