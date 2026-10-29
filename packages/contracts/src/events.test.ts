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
  it('Module 6/9: ValuationCompleted and DocumentUploaded keep their original shape and accept the new optional fields', () => {
    expect(DomainEvent.parse({ ...base, type: 'ValuationCompleted', collateralId: 'c', applicationId: 'a', marketValue: 30_000_000, collateralValue: 21_000_000 }).type).toBe('ValuationCompleted');
    const full = DomainEvent.parse({ ...base, type: 'ValuationCompleted', collateralId: 'c', applicationId: 'a', marketValue: 30_000_000, collateralValue: 21_000_000, valuationId: 'v1', assetType: 'VEHICLE', source: 'INTERNAL', haircutRate: 0.7, valuedAt: '2026-10-29T10:00:00.000Z', validUntil: null, externalRequired: false });
    expect(full.type === 'ValuationCompleted' && full.valuationId).toBe('v1');
    expect(DomainEvent.parse({ ...base, type: 'DocumentUploaded', documentId: 'd', applicationId: null, kind: 'id_card' }).type).toBe('DocumentUploaded');
    expect(DomainEvent.parse({ ...base, type: 'DocumentUploaded', documentId: 'd', applicationId: 'a', kind: 'id_card', relatedEntity: 'APPLICATION', relatedId: null, checklistKey: 'id_card', fileId: 'f' }).type).toBe('DocumentUploaded');
  });
  it('Module 6/9: DocumentRemoved and CollateralChanged', () => {
    expect(DomainEvent.parse({ ...base, type: 'DocumentRemoved', documentId: 'd', applicationId: 'a', kind: 'id_card', checklistKey: 'id_card' }).type).toBe('DocumentRemoved');
    expect(DomainEvent.parse({ ...base, type: 'CollateralChanged', applicationId: 'a', collateralId: 'c', assetType: 'VEHICLE', change: 'VALUED' }).type).toBe('CollateralChanged');
    expect(DomainEvent.safeParse({ ...base, type: 'CollateralChanged', applicationId: 'a', collateralId: 'c', assetType: 'VEHICLE', change: 'EXPLODED' }).success).toBe(false);
  });
});
