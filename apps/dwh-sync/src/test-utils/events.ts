import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '@los/contracts';

type Of<T extends DomainEvent['type']> = Extract<DomainEvent, { type: T }>;
type Body<T extends DomainEvent['type']> = Omit<Of<T>, 'eventId' | 'occurredAt' | 'version' | 'orgId' | 'actorId' | 'correlationId' | 'type'>;

/** Valid v1 event with fresh eventId; `at` = occurredAt (ISO). */
export function ev<T extends DomainEvent['type']>(type: T, body: Body<T>, at = '2026-11-02T03:00:00.000Z', orgId = 'org-1'): Of<T> {
  return { eventId: randomUUID(), occurredAt: at, version: 1, orgId, actorId: 'u-1', correlationId: 'corr-1', type, ...body } as unknown as Of<T>;
}
