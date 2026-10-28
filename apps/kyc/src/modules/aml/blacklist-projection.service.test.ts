import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@los/contracts';
import { hashRegisterNo } from '@los/database';
import { BlacklistProjectionService } from './blacklist-projection.service';
import { InMemoryAmlRepository } from './repository/in-memory-aml.repository';

const event = (over: Record<string, unknown> = {}): DomainEvent => ({
  type: 'BlacklistEntryChanged', eventId: '00000000-0000-4000-8000-000000000001', occurredAt: '2026-10-28T09:00:00.000Z', version: 1, orgId: 'org-1', actorId: 'user-1',
  correlationId: 'corr-1', entryId: 'entry-1', registerNoHash: hashRegisterNo('УБ12345678'), customerType: 'INDIVIDUAL', name: 'Бат Болд', listType: 'DELINQUENT',
  reasonCode: 'LATE_PAYMENT', isActive: true, changedAt: '2026-10-28T09:00:00.000Z', ...over,
}) as DomainEvent;

describe('BlacklistProjectionService event bus subscription', () => {
  it('subscribes to BlacklistEntryChanged with consumer group "kyc" and applies each delivery to the projection', async () => {
    const repo = new InMemoryAmlRepository();
    const subscribe = vi.fn(async () => undefined);
    const service = new BlacklistProjectionService(repo, { publish: vi.fn(), subscribe, close: vi.fn() });

    await service.onModuleInit();

    expect(subscribe).toHaveBeenCalledOnce();
    const [group, types, handler] = subscribe.mock.calls[0] as unknown as [string, string[], (e: DomainEvent) => Promise<void>];
    expect(group).toBe('kyc');
    expect(types).toEqual(['BlacklistEntryChanged']);
    await handler(event());
    expect(await repo.findBlacklistByRegisterHash('org-1', hashRegisterNo('УБ12345678'))).toHaveLength(1);
    await handler(event({ eventId: '00000000-0000-4000-8000-000000000002', isActive: false, changedAt: '2026-10-28T09:00:01.000Z' }));
    expect(await repo.findBlacklistByRegisterHash('org-1', hashRegisterNo('УБ12345678'))).toHaveLength(0);
  });

  it('does nothing without an event bus (Redis not configured)', async () => {
    await expect(new BlacklistProjectionService(new InMemoryAmlRepository(), null).onModuleInit()).resolves.toBeUndefined();
  });
});
