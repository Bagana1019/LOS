import { Global, Module } from '@nestjs/common';
import { CLOCK, type Clock, SystemClock } from '../common/clock';
import { PORTAL_CONFIG, type PortalConfig } from '../config/portal.config';
import { KV_STORE, type KvStore } from './kv-store';
import { MemoryKvStore } from './memory-kv-store';
import { RedisKvStore } from './redis-kv-store';

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: KV_STORE,
      inject: [PORTAL_CONFIG, CLOCK],
      useFactory: (cfg: PortalConfig, clock: Clock): KvStore =>
        cfg.store.kind === 'redis' ? new RedisKvStore(cfg.store.redisUrl as string) : new MemoryKvStore(clock),
    },
  ],
  exports: [CLOCK, KV_STORE],
})
export class StoreModule {}
