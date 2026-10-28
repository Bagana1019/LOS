// CLAUDE.md §3.2.6: consumer idempotent — `processed_events(consumer, event_id)` хүснэгтээр давхардлыг хаана.
import type { DomainEvent } from '@los/contracts';

export interface ProcessedEventsTx {
  processedEvent: { create(args: { data: { consumer: string; eventId: string } }): Promise<unknown> };
}
export interface TransactionalDb<Tx extends ProcessedEventsTx> {
  $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === 'P2002';

/**
 * Event-ийг НЭГ удаа боловсруулна: marker бичлэг + handler нэг транзакцид. Handler throw хийвэл marker буцна →
 * bus дахин хүргэнэ. Аль хэдийн боловсруулсан бол `false` буцаана (handler дуудахгүй).
 */
export async function consumeOnce<Tx extends ProcessedEventsTx>(db: TransactionalDb<Tx>, consumer: string, event: DomainEvent, handler: (tx: Tx) => Promise<void>): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { consumer, eventId: event.eventId } });
      await handler(tx);
      return true;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/** `bus.subscribe(group, types, idempotentHandler(db, group, (tx, e) => ...))` */
export const idempotentHandler = <Tx extends ProcessedEventsTx>(db: TransactionalDb<Tx>, consumer: string, handler: (tx: Tx, event: DomainEvent) => Promise<void>) =>
  async (event: DomainEvent): Promise<void> => { await consumeOnce(db, consumer, event, (tx) => handler(tx, event)); };
