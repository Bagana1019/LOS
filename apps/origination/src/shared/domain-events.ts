import { Injectable } from '@nestjs/common';
import type { DomainEvent, RequestContext } from '@los/contracts';
import { buildEvent, enqueueOutbox, type OutboxTx } from '@los/database';
import { Clock } from '@los/nest-common';

type Envelope = 'eventId' | 'occurredAt' | 'version' | 'orgId' | 'actorId' | 'correlationId';
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<DomainEvent, Envelope>;

/** CLAUDE.md §3.2.4: event-ийг бизнес транзакцтай нэг tx-д outbox-д бичнэ (шууд publish хийхгүй). Цагийг `Clock`-оос авна (тестэд тогтмол). */
@Injectable()
export class DomainEvents {
  constructor(private readonly clock: Clock) {}

  async publish(tx: unknown, input: EventInput, ctx: Pick<RequestContext, 'orgId' | 'userId' | 'correlationId'>): Promise<DomainEvent> {
    const { type, ...fields } = input;
    const event = buildEvent(ctx, type, fields as never, this.clock.now()) as DomainEvent;
    await enqueueOutbox(tx as OutboxTx, event);
    return event;
  }
}
