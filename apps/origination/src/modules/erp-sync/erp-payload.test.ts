import { describe, expect, it } from 'vitest';
import type { ErpEventData } from '@los/contracts';
import { buildErpPayload, contentHashOf, wireIdempotencyKey } from './erp-payload';
import type { ErpEventRecord } from './erp-event.repository';
import type { ErpEventHeader } from './event-plan';

const EVENT_ID = '0b7e3d9e-1c6f-4a2b-8d5e-9f0a1b2c3d4e';

function event(over: Partial<ErpEventRecord> = {}): ErpEventRecord {
  return {
    id: EVENT_ID, seq: 17n, orgId: 'org-1', branchId: 'br-1', idempotencyKey: 'DISBURSEMENT:dr-1', contentHash: 'h'.repeat(64), eventType: 'DISBURSEMENT',
    sourceId: 'dr-1', applicationId: 'app-1', contractNo: 'CN-1', coreLoanId: 'L-1', customerId: 'cu-1', currency: 'MNT', businessDate: '2026-10-28',
    correlationId: 'corr-1', amount: '1000.00', data: { amount: '1000.00' }, status: 'PENDING', attempts: 1,
    nextAttemptAt: new Date('2026-10-28T00:00:00.000Z'), lockedUntil: new Date('2026-10-28T00:01:00.000Z'), lockedBy: 'worker-1', lastErrorCode: null, lastError: null,
    sentAt: null, externalRef: null, target: null, resolutionNote: null, createdAt: new Date('2026-10-28T01:02:03.456Z'), updatedAt: new Date('2026-10-28T02:00:00.000Z'),
    ...over,
  };
}

function zodErrorOf(fn: () => unknown): Error & { issues: Array<{ message: string }> } {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(Error);
    // the relay classifies by name (INVALID_PAYLOAD -> DEAD), so the name is the contract
    expect((e as Error).name, `threw ${(e as Error).name}: ${(e as Error).message}`).toBe('ZodError');
    return e as Error & { issues: Array<{ message: string }> };
  }
  throw new Error('expected function to throw');
}

const repayment = (over: Record<string, string> = {}): ErpEventData => (
  { receivedAmount: '100.00', principal: '60.00', interest: '30.00', penalty: '5.00', fee: '2.00', overpayment: '3.00', ...over }
);
const fees = (): ErpEventData => ({ fees: [{ kind: 'ORIGINATION', amount: '10.00' }, { kind: 'INSURANCE', amount: '5.50', memo: 'жилийн даатгал' }], totalAmount: '15.50' });

describe('wireIdempotencyKey', () => {
  it('prefixes the organisation, because the receiver key space is global while the database uniqueness is per organisation', () => {
    expect(wireIdempotencyKey('org-1', 'REPAYMENT:pay-1')).toBe('org-1:REPAYMENT:pay-1');
    expect(wireIdempotencyKey('org-2', 'REPAYMENT:pay-1')).not.toBe(wireIdempotencyKey('org-1', 'REPAYMENT:pay-1'));
  });

  it('is what the payload carries, so two organisations emitting the same source id never collide at the receiver', () => {
    const a = buildErpPayload(event({ orgId: 'org-1' }));
    const b = buildErpPayload(event({ orgId: 'org-2' }));
    expect([a.idempotencyKey, b.idempotencyKey]).toEqual(['org-1:DISBURSEMENT:dr-1', 'org-2:DISBURSEMENT:dr-1']);
  });
});

describe('buildErpPayload', () => {
  it('maps the outbox row onto the wire format (schemaVersion 1)', () => {
    expect(buildErpPayload(event())).toEqual({
      schemaVersion: 1, eventId: EVENT_ID, idempotencyKey: 'org-1:DISBURSEMENT:dr-1', eventType: 'DISBURSEMENT',
      orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'CN-1', coreLoanId: 'L-1', customerId: 'cu-1',
      businessDate: '2026-10-28', currency: 'MNT', data: { amount: '1000.00' }, correlationId: 'corr-1', createdAt: '2026-10-28T01:02:03.456Z',
    });
  });

  it('exposes exactly the wire fields and nothing internal (no seq, status, lease or hash) and no ledger concepts', () => {
    const keys = Object.keys(buildErpPayload(event())).sort();
    expect(keys).toEqual([
      'applicationId', 'branchId', 'businessDate', 'contractNo', 'coreLoanId', 'correlationId', 'createdAt', 'currency', 'customerId', 'data', 'eventId',
      'eventType', 'idempotencyKey', 'orgId', 'schemaVersion',
    ]);
  });

  it('passes null header fields through as null', () => {
    const p = buildErpPayload(event({ branchId: null, contractNo: null, coreLoanId: null, customerId: null }));
    expect(p).toMatchObject({ branchId: null, contractNo: null, coreLoanId: null, customerId: null });
  });

  it('serialises createdAt as an ISO-8601 UTC string', () => {
    expect(buildErpPayload(event({ createdAt: new Date('2026-01-02T03:04:05.000Z') })).createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('carries the data of every event type through unchanged', () => {
    expect(buildErpPayload(event({ eventType: 'FEE_DEDUCTION', data: fees() })).data).toEqual(fees());
    expect(buildErpPayload(event({ eventType: 'REPAYMENT', data: repayment() })).data).toEqual(repayment());
  });

  describe('determinism', () => {
    it('returns byte-identical JSON on every attempt', () => {
      const e = event({ eventType: 'REPAYMENT', data: repayment() });
      const first = JSON.stringify(buildErpPayload(e));
      for (let i = 0; i < 5; i++) expect(JSON.stringify(buildErpPayload(e))).toBe(first);
    });

    it('does not depend on mutable row state such as attempts, status or lease', () => {
      const a = buildErpPayload(event({ attempts: 1, status: 'PENDING', lockedBy: 'w1' }));
      const b = buildErpPayload(event({ attempts: 9, status: 'DEAD', lockedBy: null, lastError: 'boom', lastErrorCode: 'X', updatedAt: new Date(0) }));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('does not mutate the stored row', () => {
      const e = event({ eventType: 'FEE_DEDUCTION', data: fees() });
      const before = structuredClone(e);
      buildErpPayload(e);
      expect(e).toEqual(before);
    });
  });

  describe('invalid rows raise ZodError', () => {
    it('rejects a repayment whose allocation does not equal the received amount', () => {
      const e = zodErrorOf(() => buildErpPayload(event({ eventType: 'REPAYMENT', data: repayment({ overpayment: '2.99' }) })));
      expect(e.issues.map((i) => i.message)).toContain('allocation does not equal receivedAmount');
    });

    it('rejects data that belongs to another event type, or no data', () => {
      zodErrorOf(() => buildErpPayload(event({ eventType: 'REPAYMENT', data: { amount: '1.00' } })));
      zodErrorOf(() => buildErpPayload(event({ eventType: 'DISBURSEMENT', data: fees() })));
      zodErrorOf(() => buildErpPayload(event({ data: null as never })));
    });

    it('rejects an event id that is not a UUID', () => {
      zodErrorOf(() => buildErpPayload(event({ id: 'not-a-uuid' })));
    });

    it('rejects a malformed currency or business date', () => {
      zodErrorOf(() => buildErpPayload(event({ currency: 'mnt' })));
      zodErrorOf(() => buildErpPayload(event({ businessDate: '28/10/2026' })));
    });

    it('rejects an unknown event type', () => {
      zodErrorOf(() => buildErpPayload(event({ eventType: 'REVERSAL' as 'REPAYMENT' })));
    });

    it.each(['1.5', '100', '', '-5.00', '1e2', '10000000000000000.00'])(
      'raises ZodError (so the relay marks it INVALID_PAYLOAD instead of retrying) for the malformed amount %j', (amount) => {
        zodErrorOf(() => buildErpPayload(event({ data: { amount } })));
      });
  });
});

describe('contentHashOf', () => {
  const header = (over: Partial<ErpEventHeader> = {}): ErpEventHeader => ({
    orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'CN-1', coreLoanId: 'L-1', customerId: 'cu-1', currency: 'MNT',
    businessDate: '2026-10-28', correlationId: 'corr-1', actorId: 'u-1', ...over,
  });
  const hash = (h: ErpEventHeader = header(), data: ErpEventData = { amount: '1000.00' }, type = 'DISBURSEMENT', source = 'dr-1') => contentHashOf(type, source, h, data);

  it('returns a lowercase hex sha-256 digest', () => {
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and independent of object identity or key order', () => {
    expect(hash()).toBe(hash());
    expect(hash(header(), repayment())).toBe(hash({ ...header() }, structuredClone(repayment())));
    const shuffled = Object.fromEntries(Object.entries(repayment()).reverse()) as ErpEventData;
    expect(hash(header(), shuffled)).toBe(hash(header(), repayment()));
  });

  describe('changes when the business content changes', () => {
    const baseline = hash();

    it.each([
      ['event type', () => hash(header(), { amount: '1000.00' }, 'REPAYMENT')],
      ['source id', () => hash(header(), { amount: '1000.00' }, 'DISBURSEMENT', 'dr-2')],
      ['application id', () => hash(header({ applicationId: 'app-2' }))],
      ['currency', () => hash(header({ currency: 'USD' }))],
      ['amount', () => hash(header(), { amount: '1000.01' })],
    ])('%s', (_name, changed) => {
      expect(changed()).not.toBe(baseline);
    });

    it('detects a different repayment allocation even when the received amount is the same', () => {
      expect(hash(header(), repayment(), 'REPAYMENT')).not.toBe(hash(header(), repayment({ principal: '59.00', interest: '31.00' }), 'REPAYMENT'));
    });

    it('detects a different fee kind, amount, count or order', () => {
      const base = hash(header(), fees(), 'FEE_DEDUCTION');
      const f = fees() as { fees: Array<{ kind: string; amount: string; memo?: string }>; totalAmount: string };
      expect(hash(header(), { ...f, fees: [{ ...f.fees[0]!, kind: 'SERVICE' }, f.fees[1]!] } as ErpEventData, 'FEE_DEDUCTION')).not.toBe(base);
      expect(hash(header(), { ...f, fees: [{ ...f.fees[0]!, amount: '10.01' }, f.fees[1]!] } as ErpEventData, 'FEE_DEDUCTION')).not.toBe(base);
      expect(hash(header(), { ...f, fees: [f.fees[0]!] } as ErpEventData, 'FEE_DEDUCTION')).not.toBe(base);
      expect(hash(header(), { ...f, fees: [f.fees[1]!, f.fees[0]!] } as ErpEventData, 'FEE_DEDUCTION')).not.toBe(base);
    });

    it('produces a distinct hash for every one of the variants above (no accidental collisions)', () => {
      const variants = [baseline, hash(header({ applicationId: 'app-2' })), hash(header({ currency: 'USD' })), hash(header(), { amount: '1000.00' }, 'REPAYMENT'), hash(header(), { amount: '1000.00' }, 'DISBURSEMENT', 'dr-2')];
      expect(new Set(variants).size).toBe(variants.length);
    });
  });

  describe('is stable when only presentation or tracing data changes', () => {
    const baseline = hash();

    // Дахин оролдлого/replay үед өөр байж болох талбарууд: дуудагч өөр өдөр дахин дамжуулахад давхардал хэвээр танигдана
    it.each([
      ['org id (already part of the unique key)', () => hash(header({ orgId: 'org-2' }))],
      ['branch id', () => hash(header({ branchId: 'br-2' }))],
      ['contract no', () => hash(header({ contractNo: 'CN-2' }))],
      ['core loan id', () => hash(header({ coreLoanId: 'L-2' }))],
      ['customer id', () => hash(header({ customerId: null }))],
      ['business date', () => hash(header({ businessDate: '2026-10-29' }))],
    ])('ignores the %s', (_name, changed) => {
      expect(changed()).toBe(baseline);
    });

    it('ignores fee memos', () => {
      const f = fees() as { fees: Array<{ kind: string; amount: string; memo?: string }>; totalAmount: string };
      const noMemo = { ...f, fees: f.fees.map(({ memo: _memo, ...rest }) => rest) } as ErpEventData;
      const otherMemo = { ...f, fees: f.fees.map((x) => ({ ...x, memo: 'өөр тайлбар' })) } as ErpEventData;
      expect(hash(header(), noMemo, 'FEE_DEDUCTION')).toBe(hash(header(), fees(), 'FEE_DEDUCTION'));
      expect(hash(header(), otherMemo, 'FEE_DEDUCTION')).toBe(hash(header(), fees(), 'FEE_DEDUCTION'));
    });

    it('ignores the correlation id (a retry from another request carries a new one)', () => {
      expect(hash(header({ correlationId: 'another-corr' }))).toBe(baseline);
      expect(hash(header({ correlationId: undefined }))).toBe(baseline);
    });

    it('ignores the actor id', () => {
      expect(hash(header({ actorId: 'someone-else' }))).toBe(baseline);
      expect(hash(header({ actorId: null }))).toBe(baseline);
    });
  });

  it('cannot be fooled by moving characters between neighbouring fields', () => {
    const a = contentHashOf('DISBURSEMENT', 'ab', header({ applicationId: 'c' }), { amount: '1.00' });
    const b = contentHashOf('DISBURSEMENT', 'a', header({ applicationId: 'bc' }), { amount: '1.00' });
    expect(a).not.toBe(b);
    expect(contentHashOf('A', 'BC', header(), { amount: '1.00' })).not.toBe(contentHashOf('AB', 'C', header(), { amount: '1.00' }));
  });
});
