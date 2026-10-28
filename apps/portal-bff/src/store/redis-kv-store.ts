import { Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { type KvStore, StoreUnavailableError } from './kv-store';

const PREFIX = 'portal:';

/** Redis 7 (GETDEL, SET NX EX) дээрх хэрэгжүүлэлт. Бүх түлхүүр `portal:` угтвартай. */
export class RedisKvStore implements KvStore, OnModuleDestroy {
  private readonly logger = new Logger('RedisKvStore');
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 3000 });
    // 'error' үйл явдлыг сонсохгүй бол процесс унана. URL/нууц лог руу орохгүй.
    this.redis.on('error', (err: Error) => this.logger.error(`redis error: ${err.message}`));
  }

  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      throw new StoreUnavailableError((err as Error).message);
    }
  }

  get(key: string) {
    return this.run(() => this.redis.get(PREFIX + key));
  }

  async set(key: string, value: string, ttlSec: number) {
    await this.run(() => this.redis.set(PREFIX + key, value, 'EX', ttlSec));
  }

  async setIfAbsent(key: string, value: string, ttlSec: number) {
    return (await this.run(() => this.redis.set(PREFIX + key, value, 'EX', ttlSec, 'NX'))) === 'OK';
  }

  async del(key: string) {
    await this.run(() => this.redis.del(PREFIX + key));
  }

  getAndDelete(key: string) {
    return this.run(() => this.redis.getdel(PREFIX + key));
  }

  async incr(key: string, ttlSec: number) {
    const k = PREFIX + key;
    return this.run(async () => {
      // Түлхүүрийг TTL-тэй нь эхлээд үүсгэнэ — INCR дангаараа TTL-гүй түлхүүр үлдээж болзошгүй.
      await this.redis.set(k, 0, 'EX', ttlSec, 'NX');
      return this.redis.incr(k);
    });
  }

  async ttl(key: string) {
    const t = await this.run(() => this.redis.ttl(PREFIX + key));
    return t > 0 ? t : 0;
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
