// Redis Streams (XADD/XREADGROUP) дээр суурилсан event bus. consumer group = сервисийн нэр; at-least-once; idempotency eventId-аар.
import type { DomainEvent } from '@los/contracts';
export interface EventBus { publish(e: DomainEvent): Promise<void>; subscribe(group: string, types: DomainEvent['type'][], handler: (e: DomainEvent) => Promise<void>): Promise<void>; }
export function createRedisEventBus(_url: string): EventBus { throw new Error('TODO(M00)'); }
