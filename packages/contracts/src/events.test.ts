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
  describe('N4: DWH fact dimensions are additive optional fields (old stream payloads still parse)', () => {
    const cases = [
      { type: 'ApplicationSubmitted', old: { applicationId: 'a', amount: 5_000_000, productId: 'p' },
        extra: { branchId: 'b1', officerId: 'u1', customerId: 'c1', interestRatePercent: 23.99, termMonths: 12 } },
      { type: 'DisbursementApproved', old: { applicationId: 'a', amount: 5_000_000, coreLoanId: null },
        extra: { branchId: 'b1', productId: 'p', customerId: 'c1' } },
      { type: 'ScoringCompleted', old: { applicationId: 'a', selectedMethod: 'A_SALARY', soscoScore: null, dtiPercent: 41.5 },
        extra: { dscr: 1.31, ltv: 0.62 } },
      { type: 'StatementImported', old: { analysisId: 'an', applicationId: 'a', rows: 12, status: 'COMPLETED' },
        extra: { customerId: 'c1', periodMonths: 6, monthlyIncome: 3_200_000, netCashFlowMonthly: 900_000, dtiPercent: 38.2, dtiLevel: 'MEDIUM', pendingSuspiciousCount: 2 } },
    ] as const;
    it.each(cases)('$type: v1 payload without the new fields still parses', ({ type, old }) => {
      expect(DomainEvent.safeParse({ ...base, type, ...old }).success).toBe(true);
    });
    it.each(cases)('$type: enriched payload parses and keeps every new field', ({ type, old, extra }) => {
      expect(DomainEvent.parse({ ...base, type, ...old, ...extra })).toMatchObject(extra);
    });
    it('nullable dimensions/metrics: officer (system), rate/term, dscr/ltv may be null', () => {
      expect(DomainEvent.safeParse({ ...base, type: 'ApplicationSubmitted', ...cases[0].old, branchId: 'b1', officerId: null, customerId: null, interestRatePercent: null, termMonths: null }).success).toBe(true);
      expect(DomainEvent.safeParse({ ...base, type: 'ScoringCompleted', ...cases[2].old, dscr: null, ltv: null }).success).toBe(true);
    });
    it('rejects wrong types for the new fields', () => {
      expect(DomainEvent.safeParse({ ...base, type: 'ApplicationSubmitted', ...cases[0].old, termMonths: 12.5 }).success).toBe(false);
      expect(DomainEvent.safeParse({ ...base, type: 'ApplicationSubmitted', ...cases[0].old, interestRatePercent: '24' }).success).toBe(false);
      expect(DomainEvent.safeParse({ ...base, type: 'StatementImported', ...cases[3].old, dtiLevel: 'EXTREME' }).success).toBe(false);
      expect(DomainEvent.safeParse({ ...base, type: 'StatementImported', ...cases[3].old, pendingSuspiciousCount: -1 }).success).toBe(false);
    });
    it('PII guard: unknown fields such as a register number are stripped, never carried to consumers', () => {
      const parsed = DomainEvent.parse({ ...base, type: 'ApplicationSubmitted', ...cases[0].old, registerNo: 'УБ99112233' });
      expect(parsed).not.toHaveProperty('registerNo');
    });
  });
});
