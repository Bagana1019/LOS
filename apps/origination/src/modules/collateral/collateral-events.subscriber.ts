import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { DomainEvent } from '@los/contracts';
import { idempotentHandler, type EventBus } from '@los/database';
import { EVENT_BUS, runWithContext, systemContext } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { CollateralValuationService } from './collateral-valuation.service';

/**
 * Consumer group. CLAUDE.md §3.1 "group = сервисийн нэр"-ээс ЗОРИУД ялгаатай: `createRedisEventBus.subscribe` нь өөрт хамааралгүй төрлийн мессежийг XACK-аар устгадаг тул
 * НЭГ group-д хоёр subscriber (`origination` — гэрээ) байвал бие биенийхээ event-ийг залгина. Тусдаа group тус бүр stream-ийн бүх мессежийг хүлээн авна.
 * `processed_events.consumer` мөн энэ нэрээр.
 */
export const EVENT_GROUP = 'origination-collateral';
export const SUBSCRIBED_TYPES: DomainEvent['type'][] = ['ValuationCompleted'];

/**
 * valuation-ий `ValuationCompleted`-ийг сонсож барьцааны үнэлгээг НӨӨЦӨӨР синк хийнэ (sync хариу алдагдсан тохиолдолд; docs/05 §2).
 * `idempotentHandler` нь `processed_events(origination-collateral, eventId)`-ээр давхар хүргэлтийг хаана; handler өөрөө ч идемпотент (`decideValuationEvent`).
 * `EVENT_BUS` нь Redis-гүй орчинд `null` — тэр үед чимээгүй алгасна (contract-events.subscriber.ts-тэй адил).
 */
@Injectable()
export class CollateralEventsSubscriber implements OnApplicationBootstrap {
  private readonly logger = new Logger(CollateralEventsSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus | null,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(CollateralValuationService) private readonly valuation: CollateralValuationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bus) {
      this.logger.warn('event bus disabled — ValuationCompleted events will not be consumed');
      return;
    }
    // Handler-ийн алдааг барихгүй — bus (at-least-once) дахин хүргэнэ.
    const once = idempotentHandler(this.db, EVENT_GROUP, async (tx, event) => {
      if (event.type === 'ValuationCompleted') await this.valuation.handleValuationCompleted(tx, event);
    });
    await this.bus.subscribe(EVENT_GROUP, SUBSCRIBED_TYPES, (event) => runWithContext(systemContext(event.orgId, event.correlationId), () => once(event)));
    this.logger.log(`subscribed group=${EVENT_GROUP} types=${SUBSCRIBED_TYPES.join(',')}`);
  }
}
