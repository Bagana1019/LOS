import {
  MerchantStatusChanged, PosLeaseAccepted, PosLeaseCancelled, PosLeaseDecided, PosLeaseDelivered, PosLeaseSettled, type DomainEvent,
} from '@los/contracts';
import type { z } from 'zod';
import type { Clock, IdGenerator } from '../ports';
import type { LeaseRecord } from './records';

// POS-FR-10: event-үүд zod схемээр баталгаажна (parse нь схемд байхгүй талбарыг хасна → PII орох боломжгүй).
// CLAUDE.md §3.2.4: repository-д бизнес бичлэгтэй хамт (нэг tx) дамжуулна.

export interface EventEnv { ids: IdGenerator; clock: Clock }
export interface EventMeta { orgId: string; actorId: string | null; correlationId: string }
type BaseKeys = 'eventId' | 'occurredAt' | 'version' | 'orgId' | 'actorId' | 'correlationId' | 'type';
type Data<S extends z.ZodTypeAny> = Omit<z.input<S>, BaseKeys>;

const base = (env: EventEnv, meta: EventMeta) => ({
  eventId: env.ids.uuid(), occurredAt: env.clock.now().toISOString(), version: 1 as const,
  orgId: meta.orgId, actorId: meta.actorId, correlationId: meta.correlationId,
});

export const leaseRef = (l: Pick<LeaseRecord, 'id' | 'leaseNo' | 'merchantId'>) => ({ leaseId: l.id, leaseNo: l.leaseNo, merchantId: l.merchantId });

export function posLeaseDecided(env: EventEnv, meta: EventMeta, data: Data<typeof PosLeaseDecided>): DomainEvent {
  return PosLeaseDecided.parse({ ...base(env, meta), type: 'PosLeaseDecided', ...data });
}
export function posLeaseAccepted(env: EventEnv, meta: EventMeta, data: Data<typeof PosLeaseAccepted>): DomainEvent {
  return PosLeaseAccepted.parse({ ...base(env, meta), type: 'PosLeaseAccepted', ...data });
}
export function posLeaseDelivered(env: EventEnv, meta: EventMeta, data: Data<typeof PosLeaseDelivered>): DomainEvent {
  return PosLeaseDelivered.parse({ ...base(env, meta), type: 'PosLeaseDelivered', ...data });
}
export function posLeaseSettled(env: EventEnv, meta: EventMeta, data: Data<typeof PosLeaseSettled>): DomainEvent {
  return PosLeaseSettled.parse({ ...base(env, meta), type: 'PosLeaseSettled', ...data });
}
export function posLeaseCancelled(env: EventEnv, meta: EventMeta, data: Data<typeof PosLeaseCancelled>): DomainEvent {
  return PosLeaseCancelled.parse({ ...base(env, meta), type: 'PosLeaseCancelled', ...data });
}
export function merchantStatusChanged(env: EventEnv, meta: EventMeta, data: Data<typeof MerchantStatusChanged>): DomainEvent {
  return MerchantStatusChanged.parse({ ...base(env, meta), type: 'MerchantStatusChanged', ...data });
}
