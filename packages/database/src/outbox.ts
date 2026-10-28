// Transactional outbox: domain event-ийг бизнес мөртэй нэг транзакцид `outbox` хүснэгтэд бичиж, relay worker Redis Streams руу гаргана.
// Сервис бүрийн schema-д `outbox` хүснэгт байна (init/00-schemas.sql).
import type { DomainEvent } from '@los/contracts';
export interface OutboxRow { id: string; type: string; payload: DomainEvent; createdAt: Date; publishedAt: Date|null; }
export async function enqueueOutbox(_tx: unknown, _event: DomainEvent): Promise<void> { throw new Error('TODO(M00)'); }
