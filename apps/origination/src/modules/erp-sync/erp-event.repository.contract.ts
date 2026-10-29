// Behavioural contract shared by every ErpEventRepository implementation: the in-memory test double and the Prisma/PostgreSQL repository.
// Not a test file itself; memory-erp-event.repository.test.ts and erp-event.prisma-repository.pg.test.ts call runErpEventRepositoryContract().
// Every instant is injected (T0 + offset), so nothing in here depends on the wall clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ErpEventData, ErpEventType } from '@los/contracts';
import { IdempotencyConflictError, ErpEventNotFoundError, ErpEventStateError } from './erp-sync.errors';
import type { Completion, ErpEventDraft, ErpEventDetail, ErpEventRecord, ErpEventRepository } from './erp-event.repository';
import type { ErpEventHeader } from './event-plan';

export interface ContractHarness {
  repo: ErpEventRepository;
  reset(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- shared fixtures (also used by the Prisma-only specs)
export const T0 = new Date('2026-10-28T03:00:00.000Z');
export const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
export const LEASE_MS = 60_000;

export interface DraftOptions {
  id?: string; orgId?: string; applicationId?: string; key?: string; hash?: string; eventType?: ErpEventType; sourceId?: string;
  now?: Date; correlationId?: string; amount?: string; data?: ErpEventData; header?: Partial<ErpEventHeader>;
}
export type DraftBuilder = (o?: DraftOptions) => ErpEventDraft;

// Deterministic draft factory: n-th draft gets a unique id, idempotency key, source and application unless the test pins them.
export function createDraftBuilder(): DraftBuilder {
  let n = 0;
  return (o = {}) => {
    n += 1;
    const eventType = o.eventType ?? 'DISBURSEMENT';
    const data: ErpEventData = o.data ?? { amount: o.amount ?? '1500.50' };
    const sourceId = o.sourceId ?? `src-${n}`;
    return {
      id: o.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      idempotencyKey: o.key ?? `${eventType}:${sourceId}`,
      contentHash: o.hash ?? `hash-${n}`,
      eventType, sourceId,
      header: {
        orgId: o.orgId ?? 'org-1', branchId: 'br-1', applicationId: o.applicationId ?? `app-${n}`, contractNo: `CN-${n}`, coreLoanId: `L-${n}`,
        customerId: `cu-${n}`, currency: 'MNT', businessDate: '2026-10-28', actorId: 'user-1', ...o.header,
      },
      correlationId: o.correlationId ?? `corr-${n}`, amount: o.amount ?? '1500.50', data, now: o.now ?? T0,
    };
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the promise to reject');
}

const SENT: Completion = { outcome: 'SENT', externalRef: 'GL-1', duplicate: false };
const retryAt = (nextAttemptAt: Date): Completion => ({ outcome: 'RETRY', nextAttemptAt, errorCode: 'SERVER_ERROR', errorMessage: 'ERP responded 503', httpStatus: 503 });
const DEAD: Completion = { outcome: 'DEAD', errorCode: 'REJECTED', errorMessage: 'ERP responded 422', httpStatus: 422 };

// ---------------------------------------------------------------- the contract
export function runErpEventRepositoryContract(label: string, factory: () => Promise<ContractHarness>): void {
  describe(`ErpEventRepository contract (${label})`, () => {
    let harness: ContractHarness;
    let repo: ErpEventRepository;
    let mk: DraftBuilder;

    beforeAll(async () => { harness = await factory(); repo = harness.repo; });
    afterAll(async () => { await harness.close(); });
    beforeEach(async () => { await harness.reset(); mk = createDraftBuilder(); });

    // ---- helpers bound to the repository under test
    const insert = async (o: DraftOptions = {}): Promise<ErpEventRecord> => (await repo.insert(mk(o))).event;
    const detail = async (id: string): Promise<ErpEventDetail> => {
      const d = await repo.getById(id);
      if (!d) throw new Error(`entry ${id} not found`);
      return d;
    };
    const claim = (now: Date, workerId = 'w1', leaseMs = LEASE_MS) => repo.claimNext({ now, leaseMs, workerId });
    async function claimOrFail(now: Date, workerId = 'w1', leaseMs = LEASE_MS): Promise<ErpEventRecord> {
      const e = await claim(now, workerId, leaseMs);
      if (!e) throw new Error(`expected an entry to be claimable at ${now.toISOString()} for ${workerId}`);
      return e;
    }
    const finish = (e: ErpEventRecord, completion: Completion, o: { workerId?: string; target?: string; startedAt?: Date; finishedAt?: Date } = {}) => {
      const startedAt = o.startedAt ?? at(1_000);
      return repo.complete({
        id: e.id, workerId: o.workerId ?? e.lockedBy ?? 'w1', attemptNo: e.attempts, completion, target: o.target ?? 'mock',
        startedAt, finishedAt: o.finishedAt ?? new Date(startedAt.getTime() + 250),
      });
    };
    // claim the lowest-seq claimable entry and complete it
    async function deliver(completion: Completion, now: Date = T0): Promise<ErpEventRecord> {
      const e = await claimOrFail(now);
      expect(await finish(e, completion, { startedAt: now, finishedAt: new Date(now.getTime() + 100) })).toBe(true);
      return e;
    }
    const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

    // ================================================================ insert
    describe('insert', () => {
      it('creates a PENDING entry carrying every header field and its event data, with no delivery history', async () => {
        const d = mk({ key: 'DISBURSEMENT:dr-1', sourceId: 'dr-1', hash: 'h-1', correlationId: 'corr-1', now: at(5_000) });
        const res = await repo.insert(d);
        expect(res.created).toBe(true);
        expect(typeof res.event.seq).toBe('bigint');
        expect(res.event).toEqual({
          id: d.id, seq: res.event.seq, orgId: 'org-1', branchId: 'br-1', idempotencyKey: 'DISBURSEMENT:dr-1', contentHash: 'h-1',
          eventType: 'DISBURSEMENT', sourceId: 'dr-1', applicationId: d.header.applicationId, contractNo: d.header.contractNo,
          coreLoanId: d.header.coreLoanId, customerId: d.header.customerId, currency: 'MNT', businessDate: '2026-10-28',
          correlationId: 'corr-1', amount: '1500.50', data: { amount: '1500.50' }, status: 'PENDING', attempts: 0,
          nextAttemptAt: at(5_000), lockedUntil: null, lockedBy: null, lastErrorCode: null, lastError: null, sentAt: null, externalRef: null,
          target: null, resolutionNote: null, createdAt: at(5_000), updatedAt: at(5_000),
        });
        expect(await repo.getById(d.id)).toEqual({ ...res.event, deliveries: [] });
      });

      it('round-trips the event data of every event type, including the fee list order and optional memos', async () => {
        const fees: ErpEventData = {
          fees: [{ kind: 'ORIGINATION', amount: '600.50', memo: 'Зээл олгох шимтгэл' }, { kind: 'INSURANCE', amount: '399.50' }, { kind: 'SERVICE', amount: '0.01' }],
          totalAmount: '1000.01',
        };
        const repayment: ErpEventData = { receivedAmount: '100.00', principal: '60.00', interest: '30.00', penalty: '5.00', fee: '2.00', overpayment: '3.00' };
        for (const [eventType, data, amount] of [['FEE_DEDUCTION', fees, '1000.01'], ['REPAYMENT', repayment, '100.00']] as const) {
          const { id } = await insert({ eventType, data, amount });
          expect((await detail(id)).data).toEqual(data);
          expect((await detail(id)).amount).toBe(amount);
          expect((await claimOrFail(T0, `w-${eventType}`)).data).toEqual(data);
        }
      });

      it('round-trips optional header fields as null', async () => {
        const { event: entry } = await repo.insert(mk({ header: { branchId: null, contractNo: null, coreLoanId: null, customerId: null, actorId: null } }));
        expect(entry).toMatchObject({ branchId: null, contractNo: null, coreLoanId: null, customerId: null });
        expect(await detail(entry.id)).toMatchObject({ branchId: null, contractNo: null, coreLoanId: null, customerId: null });
      });

      it('assigns a strictly increasing seq in insertion order', async () => {
        const entries: ErpEventRecord[] = [];
        for (let i = 0; i < 5; i++) entries.push(await insert());
        for (let i = 1; i < entries.length; i++) expect(entries[i]!.seq > entries[i - 1]!.seq).toBe(true);
        expect(new Set(entries.map((e) => e.seq)).size).toBe(5);
        expect(ids((await repo.list({ limit: 10 })).items)).toEqual(ids(entries).reverse());
      });

      it('is idempotent: re-inserting the same key and content returns the existing entry with created=false', async () => {
        const first = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-same', correlationId: 'corr-original', now: T0 }));
        // a retry carries a fresh id, clock reading and correlation id; only key and content hash identify it
        const again = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-same', correlationId: 'corr-retry', now: at(9_000) }));
        expect(first.created).toBe(true);
        expect(again.created).toBe(false);
        expect(again.event).toEqual(first.event);
        expect(again.event.correlationId).toBe('corr-original');
        const all = await repo.list({ limit: 10 });
        expect(all.items).toHaveLength(1);
        expect(all.items[0]?.data).toEqual({ amount: '1500.50' });
        expect((await repo.stats()).counts.PENDING).toBe(1);
      });

      it('reports the current state of the existing entry when it is re-inserted after delivery', async () => {
        const first = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-same' }));
        await deliver(SENT);
        const again = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-same', now: at(60_000) }));
        expect(again.created).toBe(false);
        expect(again.event.id).toBe(first.event.id);
        expect(again.event.status).toBe('SENT');
        expect(again.event.attempts).toBe(1);
      });

      it('rejects the same key with a different contentHash as IdempotencyConflictError and leaves the original untouched', async () => {
        const first = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-a', amount: '1500.50' }));
        const conflicting = mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-b', amount: '999.00' });
        const err = await errorOf(repo.insert(conflicting));
        expect(err).toBeInstanceOf(IdempotencyConflictError);
        expect((err as IdempotencyConflictError).idempotencyKey).toBe('DISBURSEMENT:dr-1');
        expect(await detail(first.event.id)).toEqual({ ...first.event, deliveries: [] });
        expect((await repo.list({ limit: 10 })).items).toHaveLength(1);
        expect(await repo.getById(conflicting.id)).toBeNull();
      });

      it('still reports a conflict once the existing entry has been delivered', async () => {
        await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-a' }));
        await deliver(SENT);
        expect(await errorOf(repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-b', now: at(60_000) })))).toBeInstanceOf(IdempotencyConflictError);
      });

      it('treats the same idempotency key in a different org as a different entry, even with different content', async () => {
        const a = await repo.insert(mk({ orgId: 'org-1', key: 'DISBURSEMENT:dr-1', hash: 'h-a' }));
        const b = await repo.insert(mk({ orgId: 'org-2', key: 'DISBURSEMENT:dr-1', hash: 'h-b' }));
        expect(a.created).toBe(true);
        expect(b.created).toBe(true);
        expect(b.event.id).not.toBe(a.event.id);
        expect(b.event.orgId).toBe('org-2');
        expect(b.event.seq > a.event.seq).toBe(true);
        // each org sees its own entry when re-inserting
        expect((await repo.insert(mk({ orgId: 'org-2', key: 'DISBURSEMENT:dr-1', hash: 'h-b' }))).event.id).toBe(b.event.id);
        expect((await repo.insert(mk({ orgId: 'org-1', key: 'DISBURSEMENT:dr-1', hash: 'h-a' }))).event.id).toBe(a.event.id);
      });

      it('does not treat equal content under a different key as a duplicate', async () => {
        const a = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-same' }));
        const b = await repo.insert(mk({ key: 'DISBURSEMENT:dr-2', hash: 'h-same' }));
        expect(b.created).toBe(true);
        expect(b.event.id).not.toBe(a.event.id);
      });

      it('returns detached copies: mutating a returned or drafted object does not change what is stored', async () => {
        const d = mk();
        const { event: entry } = await repo.insert(d);
        entry.status = 'SENT'; entry.attempts = 99; (entry.data as { amount: string }).amount = '0.02';
        (d.data as { amount: string }).amount = '0.01';
        const stored = await detail(entry.id);
        expect(stored.status).toBe('PENDING');
        expect(stored.attempts).toBe(0);
        expect(stored.data).toEqual({ amount: '1500.50' });

        const claimed = await claimOrFail(T0);
        claimed.lockedBy = 'tampered'; (claimed.data as { amount: string }).amount = '0.03';
        const again = await detail(entry.id);
        expect(again.lockedBy).toBe('w1');
        expect(again.data).toEqual({ amount: '1500.50' });
      });
    });

    // ================================================================ claimNext
    describe('claimNext', () => {
      it('returns null when there are no entries', async () => {
        expect(await claim(T0)).toBeNull();
      });

      it('leases a due entry: attempts+1, lockedBy, lockedUntil = now + leaseMs, still PENDING, data included', async () => {
        const e = await insert({ now: T0 });
        const c = await claimOrFail(at(5_000), 'worker-a', 30_000);
        expect(c).toMatchObject({ id: e.id, status: 'PENDING', attempts: 1, lockedBy: 'worker-a', lockedUntil: at(35_000), updatedAt: at(5_000), nextAttemptAt: T0 });
        expect(c.data).toEqual(e.data);
        expect(await detail(e.id)).toMatchObject({ attempts: 1, lockedBy: 'worker-a', lockedUntil: at(35_000), status: 'PENDING' });
      });

      it('claims an entry exactly at its nextAttemptAt but not a millisecond earlier', async () => {
        await insert({ now: at(60_000) });
        expect(await claim(at(59_999))).toBeNull();
        expect(await claim(at(60_000))).not.toBeNull();
      });

      it('does not claim an entry before its backoff elapses and claims it again once due, counting attempts', async () => {
        const e = await insert();
        const first = await claimOrFail(T0);
        expect(await finish(first, retryAt(at(30_000)))).toBe(true);
        expect(await claim(at(10_000))).toBeNull();
        expect(await claim(at(29_999))).toBeNull();
        const second = await claimOrFail(at(30_000), 'w2');
        expect(second).toMatchObject({ id: e.id, attempts: 2, lockedBy: 'w2', lockedUntil: at(90_000) });
      });

      it('does not hand out a leased entry while its lease is running, not even to the same worker', async () => {
        await insert();
        await claimOrFail(T0, 'w1', 60_000);
        expect(await claim(at(1), 'w2')).toBeNull();
        expect(await claim(at(30_000), 'w1')).toBeNull();
        expect(await claim(at(59_999), 'w2')).toBeNull();
      });

      it('hands out an entry again after its lease expired, keeping the attempts counter running', async () => {
        const e = await insert();
        expect((await claimOrFail(T0, 'w1', 60_000)).attempts).toBe(1);
        const second = await claimOrFail(at(60_001), 'w2', 10_000);
        expect(second).toMatchObject({ id: e.id, attempts: 2, lockedBy: 'w2', lockedUntil: at(70_001) });
        const third = await claimOrFail(at(70_002), 'w3', 10_000);
        expect(third).toMatchObject({ id: e.id, attempts: 3, lockedBy: 'w3' });
        expect(await detail(e.id)).toMatchObject({ attempts: 3, lockedBy: 'w3', status: 'PENDING' });
      });

      it('claims entries in seq order, skipping entries that are not due yet', async () => {
        const e1 = await insert({ now: T0 });
        const e2 = await insert({ now: at(60_000) }); // lower seq than e3 but not due
        const e3 = await insert({ now: T0 });
        const e4 = await insert({ now: T0 });
        expect((await claimOrFail(at(1_000))).id).toBe(e1.id);
        expect((await claimOrFail(at(1_000))).id).toBe(e3.id);
        expect((await claimOrFail(at(1_000))).id).toBe(e4.id);
        expect(await claim(at(1_000))).toBeNull();
        expect((await claimOrFail(at(60_000))).id).toBe(e2.id);
      });

      it('claims the entry that has waited longest first (nextAttemptAt, then seq), so a backed-off entry does not jump the queue', async () => {
        const older = await insert({ now: T0 });
        const newer = await insert({ now: T0 });
        const later = await insert({ now: at(1_000) });
        expect(await finish(await claimOrFail(at(1_000)), retryAt(at(5_000)))).toBe(true); // older -> due again at +5s
        expect((await claimOrFail(at(6_000))).id).toBe(newer.id); // due since T0
        expect((await claimOrFail(at(6_000))).id).toBe(later.id); // due since +1s
        expect((await claimOrFail(at(6_000))).id).toBe(older.id); // due since +5s
      });

      it('never claims SENT, DEAD or CANCELLED entries', async () => {
        await insert(); await insert(); await insert();
        await deliver(SENT);
        await deliver(DEAD);
        const third = (await repo.list({ limit: 10, status: 'PENDING' })).items[0]!;
        await repo.cancel(third.id, 'u', 'not needed', T0);
        expect(await claim(at(10 * 24 * 3_600_000))).toBeNull();
        expect((await repo.stats()).counts).toEqual({ PENDING: 0, SENT: 1, DEAD: 1, CANCELLED: 1 });
      });

      describe('per-application FIFO', () => {
        it('does not claim a later entry of an application while the earlier one is leased; other applications are unaffected', async () => {
          const a1 = await insert({ applicationId: 'app-A', eventType: 'DISBURSEMENT' });
          const a2 = await insert({ applicationId: 'app-A', eventType: 'FEE_DEDUCTION' });
          const b1 = await insert({ applicationId: 'app-B', eventType: 'DISBURSEMENT' });
          expect((await claimOrFail(T0)).id).toBe(a1.id);
          expect((await claimOrFail(at(1))).id).toBe(b1.id);
          expect(await claim(at(2))).toBeNull();
          expect((await detail(a2.id)).attempts).toBe(0);
        });

        it('does not claim a later entry while the earlier one is backing off after a failed attempt', async () => {
          const a1 = await insert({ applicationId: 'app-A' });
          const a2 = await insert({ applicationId: 'app-A' });
          const b1 = await insert({ applicationId: 'app-B' });
          expect(await finish(await claimOrFail(T0), retryAt(at(30_000)))).toBe(true);
          expect((await claimOrFail(at(10_000))).id).toBe(b1.id);
          expect(await claim(at(20_000))).toBeNull();
          const retried = await claimOrFail(at(30_000));
          expect(retried).toMatchObject({ id: a1.id, attempts: 2 });
          expect(await finish(retried, SENT, { startedAt: at(30_000) })).toBe(true);
          expect((await claimOrFail(at(30_001))).id).toBe(a2.id);
        });

        it('does not claim a later due entry while the earlier one is not due yet', async () => {
          const a1 = await insert({ applicationId: 'app-A', now: at(60_000) });
          const a2 = await insert({ applicationId: 'app-A', now: T0 });
          expect(await claim(at(1_000))).toBeNull();
          expect((await claimOrFail(at(60_000))).id).toBe(a1.id);
          expect(await claim(at(60_001))).toBeNull();
          expect((await detail(a2.id)).attempts).toBe(0);
        });

        it('hands out the earlier entry again after its lease expired instead of jumping to the later one', async () => {
          const a1 = await insert({ applicationId: 'app-A' });
          await insert({ applicationId: 'app-A' });
          await claimOrFail(T0, 'w1', 60_000);
          const again = await claimOrFail(at(60_001), 'w2');
          expect(again).toMatchObject({ id: a1.id, attempts: 2, lockedBy: 'w2' });
        });

        it('blocks the later entries behind a DEAD one until it is requeued and delivered', async () => {
          const a1 = await insert({ applicationId: 'app-A' });
          const a2 = await insert({ applicationId: 'app-A' });
          await deliver(DEAD);
          expect(await claim(at(3_600_000))).toBeNull();

          await repo.requeue(a1.id, 'ops-1', 'fixed in ERP', at(7_200_000));
          const retried = await claimOrFail(at(7_200_000));
          expect(retried.id).toBe(a1.id);
          expect(await claim(at(7_200_001), 'w2')).toBeNull();
          expect(await finish(retried, SENT, { startedAt: at(7_200_000) })).toBe(true);
          expect((await claimOrFail(at(7_200_002))).id).toBe(a2.id);
        });

        it('releases the later entry once the earlier one is SENT, immediately', async () => {
          const a1 = await insert({ applicationId: 'app-A' });
          const a2 = await insert({ applicationId: 'app-A' });
          expect((await deliver(SENT)).id).toBe(a1.id);
          expect((await claimOrFail(T0)).id).toBe(a2.id);
        });

        it('releases the later entry once the earlier PENDING one is CANCELLED', async () => {
          const a1 = await insert({ applicationId: 'app-A' });
          const a2 = await insert({ applicationId: 'app-A' });
          expect(await claim(T0)).toMatchObject({ id: a1.id }); // a1 is the head: a2 waits for it
          await repo.cancel(a1.id, 'ops-1', 'booked manually', at(LEASE_MS + 1)); // lease expired by now
          expect((await claimOrFail(at(LEASE_MS + 2))).id).toBe(a2.id);
        });

        it('releases the later entry once the earlier DEAD one is CANCELLED', async () => {
          const a1 = await insert({ applicationId: 'app-A' });
          const a2 = await insert({ applicationId: 'app-A' });
          await deliver(DEAD);
          expect(await claim(at(1_000))).toBeNull();
          await repo.cancel(a1.id, 'ops-1', 'booked manually in ERP', at(2_000));
          expect((await claimOrFail(at(2_001))).id).toBe(a2.id);
        });

        it('keeps a dead application stuck without starving other applications', async () => {
          await insert({ applicationId: 'app-A' });
          const a2 = await insert({ applicationId: 'app-A' });
          const b1 = await insert({ applicationId: 'app-B' });
          const c1 = await insert({ applicationId: 'app-C' });
          const c2 = await insert({ applicationId: 'app-C' });
          await deliver(DEAD); // a1
          const claimed: string[] = [];
          for (let i = 0; i < 3; i++) {
            const e = await claimOrFail(at(1_000 + i));
            claimed.push(e.id);
            await finish(e, SENT, { startedAt: at(1_000 + i) });
          }
          expect(claimed).toEqual([b1.id, c1.id, c2.id]);
          expect(await claim(at(10_000))).toBeNull();
          expect((await detail(a2.id)).attempts).toBe(0);
        });

        it('delivers the disbursement, fee deduction and repayment of one application strictly in seq order', async () => {
          const d = await insert({ applicationId: 'app-A', eventType: 'DISBURSEMENT' });
          const f = await insert({ applicationId: 'app-A', eventType: 'FEE_DEDUCTION' });
          const r = await insert({ applicationId: 'app-A', eventType: 'REPAYMENT' });
          const order: string[] = [];
          for (let i = 0; i < 3; i++) {
            const e = await claimOrFail(at(i));
            order.push(e.id);
            expect(await claim(at(i))).toBeNull();
            expect(await finish(e, SENT, { startedAt: at(i) })).toBe(true);
          }
          expect(order).toEqual([d.id, f.id, r.id]);
        });
      });
    });

    // ================================================================ complete
    describe('complete', () => {
      it('SENT: marks the entry SENT, stores reference, sentAt and target, clears the lease and writes a SENT attempt', async () => {
        const e = await insert();
        const c = await claimOrFail(T0);
        expect(await finish(c, { outcome: 'SENT', externalRef: 'GL-77', duplicate: false }, { target: 'webhook', startedAt: at(1_000), finishedAt: at(1_250) })).toBe(true);
        const d = await detail(e.id);
        expect(d).toMatchObject({
          status: 'SENT', attempts: 1, sentAt: at(1_250), externalRef: 'GL-77', target: 'webhook', lockedBy: null, lockedUntil: null,
          lastError: null, lastErrorCode: null, nextAttemptAt: T0,
        });
        expect(d.deliveries).toEqual([{
          attemptNo: 1, outcome: 'SENT', errorCode: null, errorMessage: null, httpStatus: null, durationMs: 250, externalRef: 'GL-77',
          target: 'webhook', actorId: null, note: null, startedAt: at(1_000), finishedAt: at(1_250),
        }]);
      });

      it('SENT without an external reference stores null', async () => {
        const e = await insert();
        expect(await finish(await claimOrFail(T0), { outcome: 'SENT', externalRef: null, duplicate: false })).toBe(true);
        const d = await detail(e.id);
        expect(d.status).toBe('SENT');
        expect(d.externalRef).toBeNull();
        expect(d.deliveries[0]?.externalRef).toBeNull();
      });

      it('SENT with duplicate=true is still SENT but the attempt outcome is DUPLICATE', async () => {
        const e = await insert();
        expect(await finish(await claimOrFail(T0), { outcome: 'SENT', externalRef: 'GL-1', duplicate: true })).toBe(true);
        const d = await detail(e.id);
        expect(d).toMatchObject({ status: 'SENT', externalRef: 'GL-1' });
        expect(d.deliveries).toHaveLength(1);
        expect(d.deliveries[0]).toMatchObject({ outcome: 'DUPLICATE', attemptNo: 1, externalRef: 'GL-1', errorCode: null });
      });

      it('RETRY: stays PENDING with the new nextAttemptAt and last error, clears the lease and writes a RETRY attempt', async () => {
        const e = await insert();
        const c = await claimOrFail(T0);
        expect(await finish(c, retryAt(at(30_000)), { target: 'webhook', startedAt: at(1_000), finishedAt: at(1_400) })).toBe(true);
        const d = await detail(e.id);
        expect(d).toMatchObject({
          status: 'PENDING', attempts: 1, nextAttemptAt: at(30_000), lastErrorCode: 'SERVER_ERROR', lastError: 'ERP responded 503',
          lockedBy: null, lockedUntil: null, sentAt: null, externalRef: null, target: 'webhook',
        });
        expect(d.deliveries).toEqual([{
          attemptNo: 1, outcome: 'RETRY', errorCode: 'SERVER_ERROR', errorMessage: 'ERP responded 503', httpStatus: 503, durationMs: 400,
          externalRef: null, target: 'webhook', actorId: null, note: null, startedAt: at(1_000), finishedAt: at(1_400),
        }]);
      });

      it('RETRY without an HTTP status records a null status', async () => {
        const e = await insert();
        const c = await claimOrFail(T0);
        expect(await finish(c, { outcome: 'RETRY', nextAttemptAt: at(5_000), errorCode: 'TIMEOUT', errorMessage: 'timed out' })).toBe(true);
        expect((await detail(e.id)).deliveries[0]).toMatchObject({ outcome: 'RETRY', errorCode: 'TIMEOUT', httpStatus: null });
      });

      it('DEAD: marks the entry DEAD with the error, clears the lease, writes a DEAD attempt and is never claimed again', async () => {
        const e = await insert();
        const c = await claimOrFail(T0);
        expect(await finish(c, DEAD, { startedAt: at(1_000), finishedAt: at(1_100) })).toBe(true);
        const d = await detail(e.id);
        expect(d).toMatchObject({
          status: 'DEAD', attempts: 1, lastErrorCode: 'REJECTED', lastError: 'ERP responded 422', lockedBy: null, lockedUntil: null,
          sentAt: null, externalRef: null, nextAttemptAt: T0, target: 'mock',
        });
        expect(d.deliveries).toEqual([{
          attemptNo: 1, outcome: 'DEAD', errorCode: 'REJECTED', errorMessage: 'ERP responded 422', httpStatus: 422, durationMs: 100,
          externalRef: null, target: 'mock', actorId: null, note: null, startedAt: at(1_000), finishedAt: at(1_100),
        }]);
        expect(await claim(at(365 * 24 * 3_600_000))).toBeNull();
      });

      it('a SENT after earlier failures clears the stored error and keeps one attempt row per try in chronological order', async () => {
        const e = await insert();
        expect(await finish(await claimOrFail(T0), retryAt(at(30_000)), { startedAt: at(1_000) })).toBe(true);
        const second = await claimOrFail(at(30_000), 'w2');
        expect(await finish(second, { outcome: 'SENT', externalRef: 'GL-9', duplicate: false }, { startedAt: at(31_000), finishedAt: at(31_200) })).toBe(true);
        const d = await detail(e.id);
        expect(d).toMatchObject({ status: 'SENT', attempts: 2, lastError: null, lastErrorCode: null, externalRef: 'GL-9', sentAt: at(31_200), lockedBy: null });
        expect(d.deliveries.map((x) => [x.attemptNo, x.outcome])).toEqual([[1, 'RETRY'], [2, 'SENT']]);
      });

      it('returns false and changes nothing when another worker holds the lease', async () => {
        const e = await insert();
        await claimOrFail(T0, 'w1');
        const before = await detail(e.id);
        expect(await finish({ ...before, lockedBy: 'w1' }, SENT, { workerId: 'w-other' })).toBe(false);
        expect(await detail(e.id)).toEqual(before);
        expect(before.deliveries).toEqual([]);
      });

      it('returns false for a worker whose lease expired and was taken over, and the new owner can still complete', async () => {
        const e = await insert();
        const stale = await claimOrFail(T0, 'w1', 60_000);
        const fresh = await claimOrFail(at(61_000), 'w2', 60_000);
        expect(fresh.attempts).toBe(2);
        expect(await finish(stale, SENT, { workerId: 'w1' })).toBe(false);
        const mid = await detail(e.id);
        expect(mid).toMatchObject({ status: 'PENDING', attempts: 2, lockedBy: 'w2', sentAt: null });
        expect(mid.deliveries).toEqual([]);
        expect(await finish(fresh, SENT, { workerId: 'w2', startedAt: at(62_000) })).toBe(true);
        const done = await detail(e.id);
        expect(done.status).toBe('SENT');
        expect(done.deliveries).toHaveLength(1);
        expect(done.deliveries[0]?.attemptNo).toBe(2);
      });

      it('returns false when the entry was never claimed', async () => {
        const e = await insert();
        const before = await detail(e.id);
        expect(await finish(before, SENT, { workerId: 'w1' })).toBe(false);
        expect(await detail(e.id)).toEqual(before);
      });

      it('returns false for an unknown entry id', async () => {
        const ghost = { ...(await insert()), id: '99999999-9999-4999-8999-999999999999' };
        expect(await finish(ghost, SENT, { workerId: 'w1' })).toBe(false);
      });

      it('returns false the second time: a completed entry is neither re-completed nor given a second attempt row', async () => {
        const e = await insert();
        const c = await claimOrFail(T0);
        expect(await finish(c, SENT)).toBe(true);
        const after = await detail(e.id);
        expect(await finish(c, DEAD)).toBe(false);
        expect(await finish(c, SENT, { finishedAt: at(9_000) })).toBe(false);
        expect(await detail(e.id)).toEqual(after);
      });

      it('returns false for an entry that is DEAD or was rescheduled by RETRY (the lease was released)', async () => {
        const dead = await insert({ applicationId: 'app-A' });
        const retry = await insert({ applicationId: 'app-B' });
        const c1 = await claimOrFail(T0);
        const c2 = await claimOrFail(T0);
        expect(await finish(c1, DEAD)).toBe(true);
        expect(await finish(c2, retryAt(at(30_000)))).toBe(true);
        expect(await finish(c1, SENT)).toBe(false);
        expect(await finish(c2, SENT)).toBe(false);
        expect((await detail(dead.id)).status).toBe('DEAD');
        expect(await detail(retry.id)).toMatchObject({ status: 'PENDING', nextAttemptAt: at(30_000) });
        expect((await detail(dead.id)).deliveries).toHaveLength(1);
        expect((await detail(retry.id)).deliveries).toHaveLength(1);
      });

      it('returns false when the entry was cancelled after its lease expired, leaving it CANCELLED', async () => {
        const e = await insert();
        const c = await claimOrFail(T0, 'w1', 10_000);
        await repo.cancel(e.id, 'ops-1', 'booked manually', at(10_001));
        expect(await finish(c, SENT, { workerId: 'w1' })).toBe(false);
        const d = await detail(e.id);
        expect(d.status).toBe('CANCELLED');
        expect(d.deliveries.map((x) => x.outcome)).toEqual(['CANCELLED']);
      });

      it('only touches the completed entry', async () => {
        const a = await insert({ applicationId: 'app-A' });
        const b = await insert({ applicationId: 'app-B' });
        const ca = await claimOrFail(T0, 'w1');
        const cb = await claimOrFail(T0, 'w2');
        const bBefore = await detail(b.id);
        expect(await finish(ca, SENT, { workerId: 'w1' })).toBe(true);
        expect(await detail(b.id)).toEqual(bBefore);
        expect(cb.id).toBe(b.id);
        expect((await detail(a.id)).status).toBe('SENT');
      });
    });

    // ================================================================ getById
    describe('getById', () => {
      it('returns null for an unknown id', async () => {
        expect(await repo.getById('99999999-9999-4999-8999-999999999999')).toBeNull();
      });

      it('returns the entry with its data and its delivery history oldest first', async () => {
        const e = await insert();
        expect(await finish(await claimOrFail(T0), retryAt(at(30_000)), { startedAt: at(1_000) })).toBe(true);
        expect(await finish(await claimOrFail(at(30_000)), DEAD, { startedAt: at(31_000) })).toBe(true);
        await repo.requeue(e.id, 'ops-1', 'retry after fix', at(40_000));
        const d = await detail(e.id);
        expect(d.data).toEqual(e.data);
        expect(d.deliveries.map((x) => x.outcome)).toEqual(['RETRY', 'DEAD', 'REQUEUED']);
        expect(d.deliveries.map((x) => x.startedAt)).toEqual([at(1_000), at(31_000), at(40_000)]);
      });
    });

    // ================================================================ list
    describe('list', () => {
      it('returns an empty page when there are no entries', async () => {
        expect(await repo.list({ limit: 10 })).toEqual({ items: [], nextCursor: null });
      });

      it('returns newest first (seq descending) with data, and no cursor when everything fits', async () => {
        const a = await insert(); const b = await insert(); const c = await insert();
        const page = await repo.list({ limit: 10 });
        expect(ids(page.items)).toEqual([c.id, b.id, a.id]);
        expect(page.nextCursor).toBeNull();
        expect(page.items[0]?.data).toEqual(c.data);
        expect(page.items[0]).toEqual(c);
      });

      it('pages through all entries with the cursor, without gaps or overlap', async () => {
        const all: ErpEventRecord[] = [];
        for (let i = 0; i < 7; i++) all.push(await insert());
        const expected = ids(all).reverse();
        const seen: string[] = [];
        const sizes: number[] = [];
        let cursor: string | undefined;
        do {
          const page = await repo.list({ limit: 3, cursor });
          seen.push(...ids(page.items));
          sizes.push(page.items.length);
          if (page.nextCursor !== null) {
            expect(page.nextCursor).toMatch(/^\d+$/);
            expect(page.nextCursor).toBe(page.items[page.items.length - 1]!.seq.toString());
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(seen).toEqual(expected);
        expect(sizes).toEqual([3, 3, 1]);
      });

      it('returns no next cursor on the last page when the entry count is an exact multiple of the limit', async () => {
        for (let i = 0; i < 6; i++) await insert();
        const first = await repo.list({ limit: 3 });
        expect(first.items).toHaveLength(3);
        expect(first.nextCursor).not.toBeNull();
        const second = await repo.list({ limit: 3, cursor: first.nextCursor! });
        expect(second.items).toHaveLength(3);
        expect(second.nextCursor).toBeNull();
        expect((await repo.list({ limit: 6 })).nextCursor).toBeNull();
        expect((await repo.list({ limit: 5 })).nextCursor).not.toBeNull();
      });

      it('keeps a stable position when newer entries arrive between pages', async () => {
        const all: ErpEventRecord[] = [];
        for (let i = 0; i < 4; i++) all.push(await insert());
        const first = await repo.list({ limit: 2 });
        expect(ids(first.items)).toEqual([all[3]!.id, all[2]!.id]);
        await insert(); await insert();
        const second = await repo.list({ limit: 2, cursor: first.nextCursor! });
        expect(ids(second.items)).toEqual([all[1]!.id, all[0]!.id]);
        expect(second.nextCursor).toBeNull();
      });

      describe('filters', () => {
        let e: Record<'dis1' | 'fee1' | 'rep1' | 'dis2' | 'rep2', ErpEventRecord>;
        beforeEach(async () => {
          e = {
            dis1: await insert({ applicationId: 'app-1', eventType: 'DISBURSEMENT' }),
            fee1: await insert({ applicationId: 'app-1', eventType: 'FEE_DEDUCTION' }),
            rep1: await insert({ applicationId: 'app-1', eventType: 'REPAYMENT' }),
            dis2: await insert({ applicationId: 'app-2', eventType: 'DISBURSEMENT' }),
            rep2: await insert({ applicationId: 'app-2', eventType: 'REPAYMENT' }),
          };
          await deliver(SENT); // dis1 -> SENT
          await deliver(DEAD, at(1)); // fee1 -> DEAD (rep1 stays blocked behind it)
          await repo.cancel(e.rep2.id, 'ops-1', 'not needed', at(2)); // rep2 -> CANCELLED
          // dis2 is claimable but left PENDING
        });

        it('by orgId', async () => {
          const other = await insert({ orgId: 'org-2', applicationId: 'app-x' });
          expect(ids((await repo.list({ limit: 10, orgId: 'org-2' })).items)).toEqual([other.id]);
          expect((await repo.list({ limit: 10, orgId: 'org-1' })).items).toHaveLength(5);
          expect((await repo.list({ limit: 10, orgId: 'org-3' })).items).toEqual([]);
          expect((await repo.list({ limit: 10 })).items).toHaveLength(6);
        });

        it('by status', async () => {
          expect(ids((await repo.list({ limit: 10, status: 'PENDING' })).items)).toEqual([e.dis2.id, e.rep1.id]);
          expect(ids((await repo.list({ limit: 10, status: 'SENT' })).items)).toEqual([e.dis1.id]);
          expect(ids((await repo.list({ limit: 10, status: 'DEAD' })).items)).toEqual([e.fee1.id]);
          expect(ids((await repo.list({ limit: 10, status: 'CANCELLED' })).items)).toEqual([e.rep2.id]);
        });

        it('by eventType', async () => {
          expect(ids((await repo.list({ limit: 10, eventType: 'DISBURSEMENT' })).items)).toEqual([e.dis2.id, e.dis1.id]);
          expect(ids((await repo.list({ limit: 10, eventType: 'FEE_DEDUCTION' })).items)).toEqual([e.fee1.id]);
          expect(ids((await repo.list({ limit: 10, eventType: 'REPAYMENT' })).items)).toEqual([e.rep2.id, e.rep1.id]);
        });

        it('by applicationId', async () => {
          expect(ids((await repo.list({ limit: 10, applicationId: 'app-1' })).items)).toEqual([e.rep1.id, e.fee1.id, e.dis1.id]);
          expect(ids((await repo.list({ limit: 10, applicationId: 'app-2' })).items)).toEqual([e.rep2.id, e.dis2.id]);
          expect((await repo.list({ limit: 10, applicationId: 'app-unknown' })).items).toEqual([]);
        });

        it('by errorCode, the code of the last error', async () => {
          expect(ids((await repo.list({ limit: 10, errorCode: 'REJECTED' })).items)).toEqual([e.fee1.id]);
          expect((await repo.list({ limit: 10, errorCode: 'SERVER_ERROR' })).items).toEqual([]);
          expect(ids((await repo.list({ limit: 10, errorCode: 'REJECTED', status: 'DEAD' })).items)).toEqual([e.fee1.id]);
          expect((await repo.list({ limit: 10, errorCode: 'REJECTED', status: 'PENDING' })).items).toEqual([]);
        });

        it('with several filters combined (AND)', async () => {
          expect(ids((await repo.list({ limit: 10, applicationId: 'app-1', status: 'PENDING' })).items)).toEqual([e.rep1.id]);
          expect(ids((await repo.list({ limit: 10, eventType: 'REPAYMENT', status: 'CANCELLED' })).items)).toEqual([e.rep2.id]);
          expect(ids((await repo.list({ limit: 10, applicationId: 'app-2', eventType: 'DISBURSEMENT', status: 'PENDING' })).items)).toEqual([e.dis2.id]);
          expect((await repo.list({ limit: 10, applicationId: 'app-2', status: 'DEAD' })).items).toEqual([]);
        });

        it('together with pagination', async () => {
          const first = await repo.list({ limit: 1, applicationId: 'app-1' });
          expect(ids(first.items)).toEqual([e.rep1.id]);
          const second = await repo.list({ limit: 1, applicationId: 'app-1', cursor: first.nextCursor! });
          expect(ids(second.items)).toEqual([e.fee1.id]);
          const third = await repo.list({ limit: 1, applicationId: 'app-1', cursor: second.nextCursor! });
          expect(ids(third.items)).toEqual([e.dis1.id]);
          expect(third.nextCursor).toBeNull();
        });

        it('reflects the current state of each entry', async () => {
          const sent = (await repo.list({ limit: 10, status: 'SENT' })).items[0]!;
          expect(sent).toMatchObject({ id: e.dis1.id, status: 'SENT', externalRef: 'GL-1', attempts: 1 });
          const dead = (await repo.list({ limit: 10, status: 'DEAD' })).items[0]!;
          expect(dead).toMatchObject({ id: e.fee1.id, lastErrorCode: 'REJECTED' });
          const cancelled = (await repo.list({ limit: 10, status: 'CANCELLED' })).items[0]!;
          expect(cancelled).toMatchObject({ id: e.rep2.id, resolutionNote: 'not needed' });
        });
      });
    });

    // ================================================================ stats
    describe('stats', () => {
      it('is all zeros with no dates when there are no entries', async () => {
        expect(await repo.stats()).toEqual({ counts: { PENDING: 0, SENT: 0, DEAD: 0, CANCELLED: 0 }, oldestPendingAt: null, nextAttemptAt: null });
      });

      it('counts entries per status and takes the oldest creation and earliest next attempt from PENDING entries only', async () => {
        const c = await insert({ applicationId: 'app-c', now: at(1_000) }); // -> SENT
        await insert({ applicationId: 'app-d', now: at(1_000) }); // -> DEAD
        const e = await insert({ applicationId: 'app-e', now: at(1_000) }); // -> CANCELLED
        await insert({ applicationId: 'app-a', now: at(5_000) }); // PENDING, later backs off until +90s
        await insert({ applicationId: 'app-b', now: at(20_000) }); // PENDING, due +20s
        await repo.cancel(e.id, 'ops-1', 'not needed', at(2_000));
        expect((await deliver(SENT, at(6_000))).id).toBe(c.id);
        await deliver(DEAD, at(6_000));
        await finish(await claimOrFail(at(6_000)), retryAt(at(90_000)), { startedAt: at(6_000) });

        expect(await repo.stats()).toEqual({
          counts: { PENDING: 2, SENT: 1, DEAD: 1, CANCELLED: 1 },
          oldestPendingAt: at(5_000), // app-a (the earliest created of the two PENDING entries)
          nextAttemptAt: at(20_000), // app-b (app-a backs off until +90s)
        });
      });

      it('reports no PENDING dates once everything is finished', async () => {
        await insert();
        await deliver(SENT);
        expect(await repo.stats()).toEqual({ counts: { PENDING: 0, SENT: 1, DEAD: 0, CANCELLED: 0 }, oldestPendingAt: null, nextAttemptAt: null });
      });

      it('still counts a leased entry as PENDING', async () => {
        await insert();
        await claimOrFail(T0);
        expect((await repo.stats()).counts.PENDING).toBe(1);
      });

      it('counts only the given organization when orgId is passed', async () => {
        await insert({ orgId: 'org-1', now: at(1_000) });
        await insert({ orgId: 'org-1', now: at(2_000) });
        await insert({ orgId: 'org-2', now: at(500) });
        expect(await repo.stats('org-1')).toEqual({ counts: { PENDING: 2, SENT: 0, DEAD: 0, CANCELLED: 0 }, oldestPendingAt: at(1_000), nextAttemptAt: at(1_000) });
        expect((await repo.stats('org-2')).oldestPendingAt).toEqual(at(500));
        expect(await repo.stats('org-3')).toEqual({ counts: { PENDING: 0, SENT: 0, DEAD: 0, CANCELLED: 0 }, oldestPendingAt: null, nextAttemptAt: null });
        expect((await repo.stats()).counts.PENDING).toBe(3);
      });
    });

    // ================================================================ requeue
    describe('requeue', () => {
      it('DEAD -> PENDING: resets attempts, becomes due at the supplied time, clears the lease and writes a REQUEUED attempt with actor and note', async () => {
        const e = await insert();
        await deliver(DEAD);
        const out = await repo.requeue(e.id, 'ops-1', 'ERP fixed', at(10_000));
        expect(out).toMatchObject({ id: e.id, status: 'PENDING', attempts: 0, nextAttemptAt: at(10_000), lockedBy: null, lockedUntil: null });
        expect(out.data).toEqual(e.data);
        expect(await detail(e.id)).toMatchObject({ status: 'PENDING', attempts: 0, nextAttemptAt: at(10_000) });
        const d = await detail(e.id);
        expect(d.deliveries).toHaveLength(2);
        expect(d.deliveries[1]).toMatchObject({
          outcome: 'REQUEUED', actorId: 'ops-1', note: 'ERP fixed', startedAt: at(10_000), finishedAt: at(10_000),
          errorCode: null, errorMessage: null, httpStatus: null, externalRef: null,
        });
        expect(await claim(at(9_999))).toBeNull();
        expect(await claimOrFail(at(10_000))).toMatchObject({ id: e.id, attempts: 1 });
      });

      it('DEAD -> PENDING: the REQUEUED audit row records the attempt counter the entry had before the reset', async () => {
        const e = await insert();
        expect(await finish(await claimOrFail(T0), retryAt(at(1_000)))).toBe(true);
        expect(await finish(await claimOrFail(at(1_000)), DEAD, { startedAt: at(2_000) })).toBe(true);
        expect((await detail(e.id)).attempts).toBe(2);
        await repo.requeue(e.id, 'ops-1', null, at(10_000));
        const rows = (await detail(e.id)).deliveries;
        expect(rows[rows.length - 1]).toMatchObject({ outcome: 'REQUEUED', attemptNo: 2 });
      });

      it('PENDING: makes a backing-off entry due now and keeps its attempts', async () => {
        const e = await insert();
        expect(await finish(await claimOrFail(T0), retryAt(at(3_600_000)))).toBe(true);
        const out = await repo.requeue(e.id, 'ops-1', null, at(10_000));
        expect(out).toMatchObject({ status: 'PENDING', attempts: 1, nextAttemptAt: at(10_000), lockedBy: null, lockedUntil: null });
        expect(await claim(at(9_999))).toBeNull();
        expect(await claimOrFail(at(10_000))).toMatchObject({ id: e.id, attempts: 2 });
        expect((await detail(e.id)).deliveries.map((x) => x.outcome)).toEqual(['RETRY', 'REQUEUED']);
      });

      it('rejects an entry that is being sent right now, and accepts it once the lease has expired', async () => {
        const e = await insert();
        await claimOrFail(T0, 'w1', 60_000);
        const before = await detail(e.id);
        expect(await errorOf(repo.requeue(e.id, 'ops-1', null, at(1_000)))).toBeInstanceOf(ErpEventStateError);
        expect(await detail(e.id)).toEqual(before);
        expect(await repo.requeue(e.id, 'ops-1', null, at(60_000))).toMatchObject({ status: 'PENDING', lockedBy: null, lockedUntil: null });
      });

      it('takes no amendments: amount, data, business date and identity stay exactly as inserted', async () => {
        const e = await insert({ data: { amount: '1500.50' } });
        await deliver(DEAD);
        const out = await repo.requeue(e.id, 'ops-1', 'ERP fixed', at(10_000));
        expect(out).toMatchObject({
          status: 'PENDING', attempts: 0, businessDate: e.businessDate, amount: e.amount, data: e.data, idempotencyKey: e.idempotencyKey, contentHash: e.contentHash,
        });
      });

      it('accepts a missing actor and note and stores them as null', async () => {
        const e = await insert();
        await deliver(DEAD);
        await repo.requeue(e.id, null, null, at(10_000));
        const rows = (await detail(e.id)).deliveries;
        expect(rows[rows.length - 1]).toMatchObject({ outcome: 'REQUEUED', actorId: null, note: null });
      });

      it('rejects a SENT entry with ErpEventStateError and changes nothing', async () => {
        const e = await insert();
        await deliver(SENT);
        const before = await detail(e.id);
        expect(await errorOf(repo.requeue(e.id, 'ops-1', 'again', at(10_000)))).toBeInstanceOf(ErpEventStateError);
        expect(await detail(e.id)).toEqual(before);
      });

      it('rejects a CANCELLED entry with ErpEventStateError and changes nothing', async () => {
        const e = await insert();
        await repo.cancel(e.id, 'ops-1', 'not needed', at(1_000));
        const before = await detail(e.id);
        expect(await errorOf(repo.requeue(e.id, 'ops-1', 'again', at(10_000)))).toBeInstanceOf(ErpEventStateError);
        expect(await detail(e.id)).toEqual(before);
      });

      it('rejects an unknown id with ErpEventNotFoundError', async () => {
        const err = await errorOf(repo.requeue('99999999-9999-4999-8999-999999999999', 'ops-1', null, at(1_000)));
        expect(err).toBeInstanceOf(ErpEventNotFoundError);
        expect((err as ErpEventNotFoundError).id).toBe('99999999-9999-4999-8999-999999999999');
      });
    });

    // ================================================================ cancel
    describe('cancel', () => {
      it('PENDING -> CANCELLED: stores the resolution note, clears the lease and writes a CANCELLED attempt with actor and note', async () => {
        const e = await insert();
        const out = await repo.cancel(e.id, 'ops-1', 'booked manually in ERP', at(10_000));
        expect(out).toMatchObject({ id: e.id, status: 'CANCELLED', resolutionNote: 'booked manually in ERP', lockedBy: null, lockedUntil: null, attempts: 0 });
        expect(out.data).toEqual(e.data);
        const d = await detail(e.id);
        expect(d).toMatchObject({ status: 'CANCELLED', resolutionNote: 'booked manually in ERP' });
        expect(d.deliveries).toHaveLength(1);
        expect(d.deliveries[0]).toMatchObject({
          outcome: 'CANCELLED', actorId: 'ops-1', note: 'booked manually in ERP', startedAt: at(10_000), finishedAt: at(10_000),
          errorCode: null, errorMessage: null, httpStatus: null, externalRef: null,
        });
        expect(await claim(at(20_000))).toBeNull();
      });

      it('DEAD -> CANCELLED', async () => {
        const e = await insert();
        await deliver(DEAD);
        const out = await repo.cancel(e.id, 'ops-1', 'rejected by finance', at(10_000));
        expect(out).toMatchObject({ status: 'CANCELLED', resolutionNote: 'rejected by finance', attempts: 1 });
        expect((await detail(e.id)).deliveries.map((x) => x.outcome)).toEqual(['DEAD', 'CANCELLED']);
      });

      it('accepts a missing actor and stores it as null', async () => {
        const e = await insert();
        await repo.cancel(e.id, null, 'closed by the system', at(1_000));
        expect((await detail(e.id)).deliveries[0]).toMatchObject({ outcome: 'CANCELLED', actorId: null, note: 'closed by the system' });
      });

      it('rejects a SENT entry with ErpEventStateError and changes nothing', async () => {
        const e = await insert();
        await deliver(SENT);
        const before = await detail(e.id);
        expect(await errorOf(repo.cancel(e.id, 'ops-1', 'too late', at(10_000)))).toBeInstanceOf(ErpEventStateError);
        expect(await detail(e.id)).toEqual(before);
      });

      it('rejects an already CANCELLED entry with ErpEventStateError and keeps the first resolution note', async () => {
        const e = await insert();
        await repo.cancel(e.id, 'ops-1', 'first note', at(1_000));
        const before = await detail(e.id);
        expect(await errorOf(repo.cancel(e.id, 'ops-2', 'second note', at(2_000)))).toBeInstanceOf(ErpEventStateError);
        expect(await detail(e.id)).toEqual(before);
        expect(before.resolutionNote).toBe('first note');
      });

      it('rejects an entry that is leased right now with ErpEventStateError, and the lease holder can still complete it', async () => {
        const e = await insert();
        const c = await claimOrFail(T0, 'w1', 60_000);
        const before = await detail(e.id);
        expect(await errorOf(repo.cancel(e.id, 'ops-1', 'cancel while sending', at(30_000)))).toBeInstanceOf(ErpEventStateError);
        expect(await detail(e.id)).toEqual(before);
        expect(before).toMatchObject({ status: 'PENDING', lockedBy: 'w1', lockedUntil: at(60_000) });
        expect(await finish(c, SENT, { workerId: 'w1' })).toBe(true);
        expect((await detail(e.id)).status).toBe('SENT');
      });

      it('cancels an entry whose lease has expired and clears the stale lease', async () => {
        const e = await insert();
        await claimOrFail(T0, 'w1', 60_000);
        const out = await repo.cancel(e.id, 'ops-1', 'worker crashed', at(60_001));
        expect(out).toMatchObject({ status: 'CANCELLED', lockedBy: null, lockedUntil: null, attempts: 1 });
        expect(await detail(e.id)).toMatchObject({ status: 'CANCELLED', lockedBy: null, lockedUntil: null });
      });

      it('rejects an unknown id with ErpEventNotFoundError', async () => {
        const err = await errorOf(repo.cancel('99999999-9999-4999-8999-999999999999', 'ops-1', 'whatever', at(1_000)));
        expect(err).toBeInstanceOf(ErpEventNotFoundError);
        expect((err as ErpEventNotFoundError).id).toBe('99999999-9999-4999-8999-999999999999');
      });
    });

    // ================================================================ timestamps come from the caller
    describe('timestamps', () => {
      it('stamps updatedAt with the supplied time on insert and claim', async () => {
        const e = await insert({ now: at(2_000) });
        expect(e.updatedAt).toEqual(at(2_000));
        expect((await claimOrFail(at(5_000))).updatedAt).toEqual(at(5_000));
        expect((await detail(e.id)).updatedAt).toEqual(at(5_000));
      });

      it('stamps updatedAt with the supplied finish time on complete, not with the wall clock', async () => {
        const e = await insert();
        const c = await claimOrFail(T0);
        expect(await finish(c, SENT, { startedAt: at(1_000), finishedAt: at(1_500) })).toBe(true);
        expect((await detail(e.id)).updatedAt).toEqual(at(1_500));
      });

      it('stamps updatedAt with the supplied time on requeue, not with the wall clock', async () => {
        const e = await insert();
        await deliver(DEAD);
        expect((await repo.requeue(e.id, 'ops-1', null, at(10_000))).updatedAt).toEqual(at(10_000));
        expect((await detail(e.id)).updatedAt).toEqual(at(10_000));
      });

      it('stamps updatedAt with the supplied time on cancel, not with the wall clock', async () => {
        const e = await insert();
        expect((await repo.cancel(e.id, 'ops-1', 'not needed', at(12_000))).updatedAt).toEqual(at(12_000));
        expect((await detail(e.id)).updatedAt).toEqual(at(12_000));
      });
    });
  });
}
