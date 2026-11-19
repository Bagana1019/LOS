import { Module } from '@nestjs/common';
import { createRedisEventBus, type EventBus } from '@los/database';
import { ConsumerStatusRegistry } from './consumer-status';
import { ConsumersController } from './consumers.controller';
import { DwhConsumersService } from './dwh-consumers.service';
import { DwhProjector } from './dwh-projector';
import { RedisHealth } from './redis-health';
import { DWH_EVENT_BUS } from './tokens';

export { DWH_EVENT_BUS } from './tokens';

/** CLAUDE.md §3.3 events → DWH (subscribe only; dwh-sync publishes nothing and never touches the operational DB). */
@Module({
  controllers: [ConsumersController],
  providers: [
    { provide: DWH_EVENT_BUS, useFactory: (): EventBus | null => (process.env.REDIS_URL ? createRedisEventBus(process.env.REDIS_URL) : null) },
    ConsumerStatusRegistry,
    DwhProjector,
    RedisHealth,
    DwhConsumersService,
  ],
  exports: [ConsumerStatusRegistry, RedisHealth],
})
export class ConsumersModule {}
