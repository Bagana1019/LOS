import { Global, Inject, INestApplication, Injectable, Module, ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { DomainEvent } from '@los/contracts';
import { OutboxRelay, type EventBus } from '@los/database';
import { Clock, CommonModule, EVENT_BUS, FixedClock as BaseFixedClock } from '@los/nest-common';
import { PrismaModule, PrismaService } from '../prisma.service';
import { SharedModule } from '../shared/shared.module';

/** `@los/nest-common` FixedClock + тестэд хэрэгтэй `set(string)`, `advanceMs`. */
export class FixedClock extends BaseFixedClock {
  private current: Date;
  constructor(at: Date) { super(at); this.current = new Date(at); }
  override now(): Date { return new Date(this.current); }
  override set(d: Date | string): void { this.current = new Date(d); super.set(this.current); }
  advanceMs(ms: number): void { this.set(new Date(this.current.getTime() + ms)); }
}

/** Нэг процесс доторх bus: publish хийхэд тохирох handler-үүдийг шууд дуудна (Redis-гүй тест). */
export function createInMemoryEventBus(): EventBus & { published: DomainEvent[] } {
  const published: DomainEvent[] = [];
  const handlers: Array<{ types: Set<string>; handler: (e: DomainEvent) => Promise<void> }> = [];
  return {
    published,
    async publish(e) {
      const event = DomainEvent.parse(e);
      published.push(event);
      for (const h of handlers) if (h.types.has(event.type)) await h.handler(event);
    },
    async subscribe(_group, types, handler) { handlers.push({ types: new Set(types), handler }); },
    async close() { handlers.length = 0; },
  };
}

/** Тестэд outbox → bus relay-г гараар (`relayOnce()`) ажиллуулна; Module 0-ийн `OutboxRelay`-г ашиглана. */
@Injectable()
export class OutboxRelayService {
  private readonly relay: OutboxRelay;
  constructor(prisma: PrismaService, @Inject(EVENT_BUS) bus: EventBus) {
    this.relay = new OutboxRelay({ db: prisma as never, schema: 'origination', bus });
  }
  relayOnce(): Promise<number> { return this.relay.relayOnce(); }
}

@Global()
@Module({ providers: [OutboxRelayService], exports: [OutboxRelayService] })
class TestMessagingModule {}

export interface TestApp { app: INestApplication; prisma: PrismaService; clock: FixedClock; bus: ReturnType<typeof createInMemoryEventBus>; close(): Promise<void>; }

/**
 * Нэг модулийг (эсвэл хэд хэдийг) Module 0-ийн `CommonModule` (guard, error filter, Clock), `PrismaModule`, `SharedModule`-ийн хамт босгоно.
 * `EventsModule` (Redis relay) орохгүй — `EVENT_BUS` нь in-memory bus. Хэрэгтэй provider-ийг `customize`-аар солино.
 */
export async function createTestApp(imports: ModuleMetadata['imports'], customize?: (b: TestingModuleBuilder) => TestingModuleBuilder, now = '2026-10-28T02:00:00Z'): Promise<TestApp> {
  const clock = new FixedClock(new Date(now));
  const bus = createInMemoryEventBus();
  const eventBus = { provide: EVENT_BUS, useValue: bus };
  @Global()
  @Module({ providers: [eventBus], exports: [EVENT_BUS] })
  class BusModule {}
  let builder = Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule.forRoot(), PrismaModule, SharedModule, BusModule, TestMessagingModule, ...(imports ?? [])] })
    .overrideProvider(Clock).useValue(clock);
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return { app, prisma: moduleRef.get(PrismaService), clock, bus, close: () => app.close() };
}
