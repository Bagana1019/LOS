import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, HealthModule, envFilePaths } from '@los/nest-common';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
import { EtlModule } from './modules/etl/etl.module';
import { ConsumersModule } from './modules/consumers/consumers.module';
import { ConsumerStatusRegistry } from './modules/consumers/consumer-status';
import { DWH_SUBSCRIPTIONS } from './modules/consumers/decode';
import { RedisHealth } from './modules/consumers/redis-health';
import { DWH_DATABASE, type DwhDatabase } from './modules/etl/dwh-database';
import { DwhSchemaService } from './modules/etl/dwh-schema';

// dwh-sync нь HTTP-ээр өгөгдөл хүлээн авдаггүй (event; CDC хийгдээгүй) — health + /api/consumers/status (мэдээлэл).
// /api/health/ready: DWH, DWH schema (startup DDL), Redis, consumer group бүр (subscribe хийсэн эсэх; DLQ readiness-д нөлөөлөхгүй).
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    HealthModule.forServiceAsync({
      service: 'dwh-sync',
      imports: [ConsumersModule],
      inject: [DWH_DATABASE, DwhSchemaService, RedisHealth, ConsumerStatusRegistry],
      useFactory: (db: DwhDatabase, schema: DwhSchemaService, redis: RedisHealth, status: ConsumerStatusRegistry) => ({
        dwh: () => db.ping(),
        'dwh-schema': async () => schema.assertReady(),
        redis: () => redis.ping(),
        ...Object.fromEntries(DWH_SUBSCRIPTIONS.map((s) => [`consumer:${s.group}`, async () => status.assertHealthy(s.group)])),
      }),
    }),
    EtlModule,
    ConsumersModule,
  ],
})
export class AppModule {}
