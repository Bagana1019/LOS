import { describe, expect, it } from 'vitest';
import { DomainEvent } from './events';

const base = { eventId: '3f2b8c5e-1111-4222-8333-444455556666', occurredAt: '2026-10-28T10:00:00.000Z', version: 1 as const, orgId: 'o1', actorId: null, correlationId: 'c1' };
describe('event catalog', () => {
  it('accepts SettingsChanged', () => {
    expect(DomainEvent.parse({ ...base, type: 'SettingsChanged', key: 'br1.dti_max', productId: null }).type).toBe('SettingsChanged');
  });
  it('rejects unknown event types and wrong versions', () => {
    expect(DomainEvent.safeParse({ ...base, type: 'Nope' }).success).toBe(false);
    expect(DomainEvent.safeParse({ ...base, version: 2, type: 'SettingsChanged', key: 'k', productId: null }).success).toBe(false);
  });
});
