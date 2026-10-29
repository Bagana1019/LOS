import { DomainEvent } from '@los/contracts';
import { enqueueOutbox, type OutboxTx } from '@los/database';

// Transactional outbox (CLAUDE.md §3.2.4): event-ийг бизнес бичлэгтэй НЭГ транзакцид `outbox` хүснэгтэд бичнэ, relay worker (EventsModule) дараа нь Redis Streams руу гаргана.
// Бичилтийг Module 0-ийн @los/database `enqueueOutbox` хийнэ; энэ функц нь зөвхөн багц + PII-аас хамгаалсан алдааны мессеж нэмнэ.

export type { OutboxTx };

/**
 * Event бүрийг @los/contracts-ийн zod схемээр шалгаж (үл мэдэгдэх талбарыг хасна: PII гоожихоос хамгаална) `enqueueOutbox`-оор бичнэ.
 * Давхар eventId → Prisma P2002 (тухайн транзакц бүхлээрээ буцна). Алдааны мессежид event-ийн утга оруулахгүй (ZodError-ийн `received` утга PII агуулж болзошгүй).
 */
export async function writeOutbox(tx: OutboxTx, events: readonly DomainEvent[]): Promise<void> {
  const valid = events.map((event) => {
    const parsed = DomainEvent.safeParse(event);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      throw new Error(`Invalid domain event "${String((event as { type?: unknown }).type)}" for outbox: ${paths}`);
    }
    return parsed.data;
  });
  for (const event of valid) await enqueueOutbox(tx, event);
}
