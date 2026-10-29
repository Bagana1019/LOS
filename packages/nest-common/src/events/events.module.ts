import { type DynamicModule, Logger, Module, type InjectionToken, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { OutboxRelay, createRedisEventBus, type EventBus, type OutboxRelayOptions } from '@los/database';

/** Redis Streams event bus (`REDIS_URL` байхгүй эсвэл `OUTBOX_RELAY=off` бол `null` — unit тест, redis-гүй орчин). Consumer-ууд `subscribe`-ийг өөрсдөө дуудна. */
export const EVENT_BUS = Symbol('EVENT_BUS');

/** CLAUDE.md §3.2.4: `outbox` хүснэгтийг сервис тутамд нэг relay-ээр Redis Stream руу гаргана (FOR UPDATE SKIP LOCKED тул олон instance аюулгүй). */
class OutboxRelayHost implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('OutboxRelay');
  private relay?: OutboxRelay;
  constructor(private readonly db: OutboxRelayOptions['db'], private readonly schema: string, private readonly bus: EventBus | null) {}

  onModuleInit(): void {
    if (!this.bus) { this.log.warn(`event bus disabled (no REDIS_URL / OUTBOX_RELAY=off): ${this.schema}.outbox will not be published`); return; }
    this.relay = new OutboxRelay({ db: this.db, schema: this.schema, bus: this.bus, pollMs: Number(process.env.OUTBOX_POLL_MS ?? 500), log: (level, msg) => (level === 'error' ? this.log.error(msg) : this.log.log(msg)) });
    this.relay.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.relay?.stop();
    await this.bus?.close();
  }
}

@Module({})
export class EventsModule {
  /** `EventsModule.forRoot({ schema: 'kyc', db: PrismaService })` — `db` нь `$transaction` бүхий сервисийн PrismaService. */
  static forRoot(o: { schema: string; db: InjectionToken }): DynamicModule {
    return {
      module: EventsModule,
      global: true,
      providers: [
        { provide: EVENT_BUS, useFactory: (): EventBus | null => (process.env.REDIS_URL && process.env.OUTBOX_RELAY !== 'off' ? createRedisEventBus(process.env.REDIS_URL) : null) },
        { provide: OutboxRelayHost, inject: [o.db, EVENT_BUS], useFactory: (db: OutboxRelayOptions['db'], bus: EventBus | null) => new OutboxRelayHost(db, o.schema, bus) },
      ],
      exports: [EVENT_BUS],
    };
  }
}
