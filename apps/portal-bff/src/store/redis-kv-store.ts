import { Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { type KvStore, StoreUnavailableError } from './kv-store';

const PREFIX = 'portal:';

const INCR_WITH_TTL = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c`;

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

  async setIfExists(key: string, value: string, ttlSec: number) {
    return (await this.run(() => this.redis.set(PREFIX + key, value, 'EX', ttlSec, 'XX'))) === 'OK';
  }

  async del(key: string) {
    await this.run(() => this.redis.del(PREFIX + key));
  }

  getAndDelete(key: string) {
    return this.run(() => this.redis.getdel(PREFIX + key));
  }

  async incr(key: string, ttlSec: number) {
    // Нэг атомар Lua: INCR ба TTL тохируулалт хоёрын завсар түлхүүр дуусвал TTL-гүй (хэзээ ч шинэчлэгдэхгүй)
    // тоолуур үлдэх эрсдэлийг арилгана. TTL алга (-1) байвал өөрөө засна.
    const n = await this.run(() => this.redis.eval(INCR_WITH_TTL, 1, PREFIX + key, ttlSec));
    return Number(n);
  }

  async ttl(key: string) {
    const t = await this.run(() => this.redis.ttl(PREFIX + key));
    return t > 0 ? t : 0;
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
