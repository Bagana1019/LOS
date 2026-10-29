import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { DomainEvent } from '@los/contracts';
import { idempotentHandler, type EventBus } from '@los/database';
import { EVENT_BUS, runWithContext, systemContext } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { ApplicationDocumentService } from './document.service';

/**
 * Consumer group. CLAUDE.md §3.1 "consumer group = сервисийн нэр" гэдгээс ЗОРИУД ялгаатай: `createRedisEventBus.subscribe` нь өөрт хамааралгүй
 * төрлийн мессежийг баталгаажуулж (XACK) устгадаг тул НЭГ group-д хоёр subscriber (`origination` — гэрээ, барьцаа) байвал бие биенийхээ event-ийг залгина.
 * Тусдаа group тус бүр stream-ийн бүх мессежийг хүлээн авна. `processed_events.consumer` мөн энэ нэрээр.
 */
export const EVENT_GROUP = 'origination-documents';
export const SUBSCRIBED_TYPES: DomainEvent['type'][] = ['DocumentUploaded', 'DocumentRemoved'];

/**
 * dms-ийн `DocumentUploaded` / `DocumentRemoved`-ийг сонсож хүсэлтийн 8-р алхмыг (`document`) dms-ийн ШИНЭ жагсаалтаар дахин тооцно
 * (FR-9.2). origination өөрийн attach/remove-д аль хэдийн дахин тооцдог тул энэ нь нөөц: дунд нь унасан, эсвэл өөр эх сурвалжаас (dms-д шууд) орсон баримтыг барина.
 * `idempotentHandler` нь `processed_events(consumer, eventId)`-ээр давхар хүргэлтийг хаана. `EVENT_BUS` нь Redis-гүй орчинд `null` — тэр үед алгасна
 * (contract-events.subscriber.ts-тэй адил). Handler-ийн алдааг барихгүй — bus (at-least-once) дахин хүргэнэ.
 */
@Injectable()
export class DocumentEventsSubscriber implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentEventsSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus | null,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(ApplicationDocumentService) private readonly documents: ApplicationDocumentService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.bus) {
      this.logger.warn('event bus disabled — document events will not be consumed');
      return;
    }
    const once = idempotentHandler(this.db, EVENT_GROUP, async (_tx, event) => {
      if (event.type === 'DocumentUploaded' || event.type === 'DocumentRemoved') await this.documents.recomputeFromEvent(event);
    });
    await this.bus.subscribe(EVENT_GROUP, SUBSCRIBED_TYPES, (event) => runWithContext(systemContext(event.orgId, event.correlationId), () => once(event)));
    this.logger.log(`subscribed group=${EVENT_GROUP} types=${SUBSCRIBED_TYPES.join(',')}`);
  }
}
