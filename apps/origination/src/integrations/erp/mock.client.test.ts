import { describe, expect, it } from 'vitest';
import type { ErpEventPayload } from '@los/contracts';
import { ErpPostError } from './erp.interface';
import { MockErpClient } from './mock.client';

const CTX = { correlationId: 'corr-1', attemptNo: 1 };

function payload(over: Partial<ErpEventPayload> = {}): ErpEventPayload {
  return {
    schemaVersion: 1,
    eventId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'DISBURSEMENT:req-1',
    eventType: 'DISBURSEMENT',
    orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'C-2026-0001', coreLoanId: null, customerId: 'cus-1',
    businessDate: '2026-10-28', currency: 'MNT',
    data: { amount: '10000000.00' },
    correlationId: 'corr-1', createdAt: '2026-10-28T01:00:00.000Z',
    ...over,
  };
}

async function failureOf(p: Promise<unknown>): Promise<ErpPostError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ErpPostError); return e as ErpPostError; }
  throw new Error('expected the call to reject');
}

describe('MockErpClient', () => {
  it('identifies itself as the mock gateway', () => {
    expect(new MockErpClient().name).toBe('mock');
  });

  describe('externalRef', () => {
    it('returns a MOCK- reference derived from the idempotency key on first post', async () => {
      const res = await new MockErpClient().post(payload(), CTX);
      expect(res.duplicate).toBe(false);
      expect(res.externalRef).toMatch(/^MOCK-[0-9A-F]{12}$/);
    });

    it('is deterministic across independent client instances', async () => {
      const a = await new MockErpClient().post(payload(), CTX);
      const b = await new MockErpClient().post(payload(), { correlationId: 'other', attemptNo: 7 });
      expect(b.externalRef).toBe(a.externalRef);
    });

    it('does not depend on the payload content, only on the idempotency key', async () => {
      const a = await new MockErpClient().post(payload(), CTX);
      const b = await new MockErpClient().post(payload({ businessDate: '2027-01-01', currency: 'USD' }), CTX);
      expect(b.externalRef).toBe(a.externalRef);
    });

    it('differs between idempotency keys', async () => {
      const client = new MockErpClient();
      const a = await client.post(payload({ idempotencyKey: 'DISBURSEMENT:req-1' }), CTX);
      const b = await client.post(payload({ idempotencyKey: 'DISBURSEMENT:req-2' }), CTX);
      expect(a.externalRef).not.toBe(b.externalRef);
      expect(b.duplicate).toBe(false);
    });
  });

  describe('idempotent replay', () => {
    it('returns duplicate=true with the same externalRef when the same key and content are posted again', async () => {
      const client = new MockErpClient();
      const first = await client.post(payload(), CTX);
      const second = await client.post(payload(), { correlationId: 'corr-1', attemptNo: 2 });
      const third = await client.post(payload(), { correlationId: 'corr-1', attemptNo: 3 });
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ externalRef: first.externalRef, duplicate: true });
      expect(third).toEqual({ externalRef: first.externalRef, duplicate: true });
    });

    it('treats a replay with a different eventId, createdAt or correlationId as the same event', async () => {
      const client = new MockErpClient();
      const first = await client.post(payload(), CTX);
      const replay = await client.post(payload({
        eventId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-29T09:00:00.000Z', correlationId: 'another',
      }), CTX);
      expect(replay).toEqual({ externalRef: first.externalRef, duplicate: true });
    });

    it('exactly one of several concurrent posts of the same entry is not a duplicate', async () => {
      const client = new MockErpClient();
      const results = await Promise.all(Array.from({ length: 5 }, () => client.post(payload(), CTX)));
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(new Set(results.map((r) => r.externalRef)).size).toBe(1);
      expect(client.postedKeys).toEqual(['DISBURSEMENT:req-1']);
    });

    it('keeps separate state per client instance', async () => {
      const a = new MockErpClient();
      const b = new MockErpClient();
      await a.post(payload(), CTX);
      expect((await b.post(payload(), CTX)).duplicate).toBe(false);
    });
  });

  describe('idempotency conflict', () => {
    const variants: Array<[string, Record<string, unknown>]> = [
      ['an amount', { data: { amount: '10000000.01' } }],
      ['the event type with matching data', { eventType: 'FEE_DEDUCTION', data: { fees: [{ kind: 'ORIGINATION', amount: '10000000.00' }], totalAmount: '10000000.00' } }],
      ['the business date', { businessDate: '2026-10-29' }],
      ['the currency', { currency: 'USD' }],
    ];

    it.each(variants)('rejects the same key with a different %s as a PERMANENT IDEMPOTENCY_CONFLICT', async (_label, over) => {
      const client = new MockErpClient();
      await client.post(payload(), CTX);
      const err = await failureOf(client.post(payload(over as Partial<ErpEventPayload>), CTX));
      expect(err.kind).toBe('PERMANENT');
      expect(err.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(err.httpStatus).toBe(409);
      expect(err.message).toMatch(/idempotency key/i);
    });

    it('does not overwrite the originally stored entry after a conflict', async () => {
      const client = new MockErpClient();
      const first = await client.post(payload(), CTX);
      await failureOf(client.post(payload({ businessDate: '2026-10-29' }), CTX));
      expect(await client.post(payload(), CTX)).toEqual({ externalRef: first.externalRef, duplicate: true });
      expect(client.postedKeys).toEqual(['DISBURSEMENT:req-1']);
    });
  });

  describe('postedKeys', () => {
    it('lists accepted idempotency keys in first-seen order, without repeats', async () => {
      const client = new MockErpClient();
      expect(client.postedKeys).toEqual([]);
      await client.post(payload({ idempotencyKey: 'K-b' }), CTX);
      await client.post(payload({ idempotencyKey: 'K-a' }), CTX);
      await client.post(payload({ idempotencyKey: 'K-b' }), CTX);
      expect(client.postedKeys).toEqual(['K-b', 'K-a']);
    });

    it('returns a copy that cannot mutate the internal state', async () => {
      const client = new MockErpClient();
      await client.post(payload(), CTX);
      client.postedKeys.push('tampered');
      expect(client.postedKeys).toEqual(['DISBURSEMENT:req-1']);
    });
  });

  describe('scriptResults failure injection', () => {
    const retryable = () => new ErpPostError('boom', 'RETRYABLE', 'SERVER_ERROR', 503, 1500);
    const permanent = () => new ErpPostError('nope', 'PERMANENT', 'REJECTED', 422);

    it('consumes scripted results strictly in order, one per call', async () => {
      const client = new MockErpClient();
      const e1 = retryable();
      const e2 = permanent();
      client.scriptResults([e1, null, e2]);

      expect(await failureOf(client.post(payload(), CTX))).toBe(e1);
      const ok = await client.post(payload(), CTX); // null = succeed
      expect(ok.duplicate).toBe(false);
      expect(await failureOf(client.post(payload({ idempotencyKey: 'K-2' }), CTX))).toBe(e2);
      // script exhausted -> normal behaviour (replay of the key accepted by the null step)
      expect(await client.post(payload(), CTX)).toEqual({ externalRef: ok.externalRef, duplicate: true });
    });

    it('does not record a key for a call that was scripted to fail', async () => {
      const client = new MockErpClient();
      client.scriptResults([retryable()]);
      await failureOf(client.post(payload(), CTX));
      expect(client.postedKeys).toEqual([]);
      expect((await client.post(payload(), CTX)).duplicate).toBe(false);
    });

    it('uses a null entry as a normal (non-failing) call that still consumes one slot', async () => {
      const client = new MockErpClient();
      const e = retryable();
      client.scriptResults([null, e]);
      expect((await client.post(payload({ idempotencyKey: 'K-1' }), CTX)).duplicate).toBe(false);
      expect(await failureOf(client.post(payload({ idempotencyKey: 'K-2' }), CTX))).toBe(e);
      expect(client.postedKeys).toEqual(['K-1']);
    });

    it('applies the script before any idempotency check, even for an already posted key', async () => {
      const client = new MockErpClient();
      await client.post(payload(), CTX);
      const e = retryable();
      client.scriptResults([e]);
      expect(await failureOf(client.post(payload(), CTX))).toBe(e);
      expect((await client.post(payload(), CTX)).duplicate).toBe(true);
    });

    it('replaces any previously scripted results', async () => {
      const client = new MockErpClient();
      client.scriptResults([retryable(), retryable()]);
      const e = permanent();
      client.scriptResults([e]);
      expect(await failureOf(client.post(payload(), CTX))).toBe(e);
      expect((await client.post(payload({ idempotencyKey: 'K-2' }), CTX)).duplicate).toBe(false);
    });

    it('clears the script when given an empty list', async () => {
      const client = new MockErpClient();
      client.scriptResults([retryable()]);
      client.scriptResults([]);
      expect((await client.post(payload(), CTX)).duplicate).toBe(false);
    });

    it('copies the supplied array so later mutation by the caller has no effect', async () => {
      const client = new MockErpClient();
      const script: Array<ErpPostError | null> = [retryable()];
      client.scriptResults(script);
      script.length = 0;
      await failureOf(client.post(payload(), CTX));
    });

    it('preserves the kind, code, status and retryAfterMs of the injected error', async () => {
      const client = new MockErpClient();
      client.scriptResults([retryable()]);
      const err = await failureOf(client.post(payload(), CTX));
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ErpPostError');
      expect([err.kind, err.code, err.httpStatus, err.retryAfterMs]).toEqual(['RETRYABLE', 'SERVER_ERROR', 503, 1500]);
    });
  });
});
