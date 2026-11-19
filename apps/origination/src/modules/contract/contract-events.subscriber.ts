import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { DomainEvent } from '@los/contracts';
import { idempotentHandler, type EventBus } from '@los/database';
import { EVENT_BUS, runWithContext, systemContext } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { ContractSigningEventHandler } from './contract-signing.event-handler';

/**
 * C1: өөрийн consumer group — 'origination' group-ийг notification consumer-тэй хуваалцахад бие биенийхээ event-ийг XACK-аар хаяж байсан.
 * Шинэ group '0'-оос (бүх түүх) эхэлнэ: алдагдсан ContractSigned-ийг нөхнө; handler stale/SIGNED хамгаалалттай тул replay аюулгүй.
 */
export const EVENT_GROUP = 'origination-contract';
/** processed_events.consumer — group солигдсон ч хуучин нэрээр: өмнө боловсруулсан event replay-д давтагдахгүй. */
export const PROCESSED_CONSUMER = 'origination';
const SUBSCRIBED_TYPES: DomainEvent['type'][] = ['ContractSigned', 'ContractSigningFailed'];

/**
 * dms-ийн гарын үсгийн event-үүдийг сонсож `contract` мөрөнд тусгана. `idempotentHandler` нь `processed_events(PROCESSED_CONSUMER, eventId)`-ээр
 * давхар хүргэлтийг хаана (handler нь өөрөө CAS-аар идемпотент тул хоёр давхар хамгаалалт). `EVENT_BUS` нь Redis-гүй орчинд `null`.
 */
@Injectable()
export class ContractEventsSubscriber implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContractEventsSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus | null,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ContractSigningEventHandler) private readonly handler: ContractSigningEventHandler,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bus) {
      this.logger.warn('event bus disabled — contract signing events will not be consumed');
      return;
    }
    // subscribe амжилтгүй бол (Redis хүрэхгүй гэх мэт) зориуд шидэж, сервис асахгүй: чимээгүй алдвал гарын үсэг зурагдсан гэрээ олголтод нээгдэхгүй үлдэнэ.
    // Handler-ийн алдааг барихгүй — bus (at-least-once) дахин хүргэнэ.
    const once = idempotentHandler(this.db, PROCESSED_CONSUMER, async (_tx, event) => this.handler.handle(event));
    await this.bus.subscribe(EVENT_GROUP, SUBSCRIBED_TYPES, (event) => runWithContext(systemContext(event.orgId, event.correlationId), () => once(event)));
    this.logger.log(`subscribed group=${EVENT_GROUP} types=${SUBSCRIBED_TYPES.join(',')}`);
  }
}
