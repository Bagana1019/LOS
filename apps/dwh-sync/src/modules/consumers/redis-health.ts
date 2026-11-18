import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

/** Readiness probe for the Redis that carries `los:events` (separate connection from the bus readers, which block on XREADGROUP). */
@Injectable()
export class RedisHealth implements OnApplicationShutdown {
  private readonly client = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;

  async ping(): Promise<void> {
    if (!this.client) throw new Error('REDIS_URL not set');
    await this.client.ping();
  }
  onApplicationShutdown(): void { this.client?.disconnect(); }
}
