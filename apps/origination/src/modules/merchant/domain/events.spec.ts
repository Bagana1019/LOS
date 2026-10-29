import { DomainEvent } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../testing/fake-clock';
import { makeLeaseRecord } from '../testing/records';
import { SequentialIdGenerator } from '../testing/sequential-id';
import { leaseRef, merchantStatusChanged, posLeaseAccepted, posLeaseCancelled, posLeaseDecided, posLeaseDelivered, posLeaseSettled } from './events';

const env = { ids: new SequentialIdGenerator(), clock: new FakeClock('2026-10-28T04:00:00.000Z') };
const meta = { orgId: 'org-test', actorId: 'staff-1', correlationId: 'corr-1' };
const lease = makeLeaseRecord();
const ref = leaseRef(lease);

describe('event factories', () => {
  it('build schema-valid events with the common envelope', () => {
    const events = [
      posLeaseDecided(env, meta, { ...ref, decision: 'APPROVE', decidedBy: 'SYSTEM', financedAmount: 2_400_000, decisionSeconds: 12.5 }),
      posLeaseAccepted(env, meta, { ...ref, financedAmount: 2_400_000, principal: 2_424_000, termMonths: 12, annualRate: 0.24, monthlyPayment: 229_212.46 }),
      posLeaseDelivered(env, meta, { ...ref, netAmount: 2_328_000, commissionAmount: 72_000 }),
      posLeaseSettled(env, meta, { ...ref, netAmount: 2_328_000, settlementRef: 'PAY-1' }),
      posLeaseCancelled(env, meta, { ...ref, fromStatus: 'APPROVED', reason: 'Customer changed mind' }),
      merchantStatusChanged(env, meta, { merchantId: lease.merchantId, from: 'PENDING', to: 'ACTIVE', reason: 'Contract signed' }),
    ];
    expect(events.map((e) => e.type)).toEqual(['PosLeaseDecided', 'PosLeaseAccepted', 'PosLeaseDelivered', 'PosLeaseSettled', 'PosLeaseCancelled', 'MerchantStatusChanged']);
    for (const e of events) {
      expect(DomainEvent.safeParse(e).success).toBe(true);
      expect(e).toMatchObject({ version: 1, orgId: 'org-test', actorId: 'staff-1', correlationId: 'corr-1', occurredAt: '2026-10-28T04:00:00.000Z' });
    }
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });
  it('allows a null actor (system events)', () => {
    const e = posLeaseCancelled(env, { ...meta, actorId: null }, { ...ref, fromStatus: 'DRAFT', reason: 'EXPIRED' });
    expect(e.actorId).toBeNull();
  });
  it('strips fields that are not in the schema, so PII cannot leak into an event', () => {
    const dirty = { ...ref, netAmount: 1, commissionAmount: 2, buyerRegister: 'УЕ12345601', buyerPhone: '99112212' } as unknown as Parameters<typeof posLeaseDelivered>[2];
    const json = JSON.stringify(posLeaseDelivered(env, meta, dirty));
    expect(json).not.toContain('УЕ12345601');
    expect(json).not.toContain('99112212');
    expect(json).not.toContain('buyer');
  });
  it('rejects invalid payloads', () => {
    expect(() => posLeaseDecided(env, meta, { ...ref, decision: 'MAYBE', decidedBy: 'SYSTEM', financedAmount: 1, decisionSeconds: 1 } as never)).toThrow();
  });
  it('leaseRef extracts only identifiers', () => {
    expect(ref).toEqual({ leaseId: lease.id, leaseNo: lease.leaseNo, merchantId: lease.merchantId });
  });
});
