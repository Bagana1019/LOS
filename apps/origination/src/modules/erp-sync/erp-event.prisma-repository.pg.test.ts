// Integration spec for PrismaErpEventRepository against a real PostgreSQL (schema "origination" must already exist).
// Runs only when TEST_DATABASE_URL is set, e.g. TEST_DATABASE_URL=postgresql://los@127.0.0.1:55432/los_test (the foundation global-setup migrates it)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { IdempotencyConflictError } from './erp-sync.errors';
import { PrismaErpEventRepository } from './erp-event.prisma-repository';
import type { ErpEventRecord } from './erp-event.repository';
import { LEASE_MS, T0, at, createDraftBuilder, runErpEventRepositoryContract, type DraftBuilder } from './erp-event.repository.contract';

const dbUrl = (): string => process.env.TEST_DATABASE_URL as string;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Resolves with 'BLOCKED' when the promise is still pending after ms (only reached when the code under test hangs on a lock)
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'BLOCKED'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<'BLOCKED'>((resolve) => { timer = setTimeout(() => resolve('BLOCKED'), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Same database, optionally with extra connection-string parameters (connection_limit etc.)
function clientFor(params: Record<string, string> = {}): PrismaService {
  const u = new URL(dbUrl());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new PrismaService({ datasources: { db: { url: u.toString() } } });
}

async function wipe(db: PrismaService): Promise<void> {
  await db.$executeRaw`DELETE FROM origination.erp_delivery_attempt`;
  await db.$executeRaw`DELETE FROM origination.erp_event`;
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('PrismaErpEventRepository (PostgreSQL)', () => {
  // ---- the same contract the in-memory double satisfies
  runErpEventRepositoryContract('PrismaErpEventRepository', async () => {
    const db = new PrismaService({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
    await db.$connect();
    return { repo: new PrismaErpEventRepository(db), reset: () => wipe(db), close: async () => { await wipe(db); await db.$disconnect(); } };
  });

  // ---- behaviour that only exists with a real database
  describe('PostgreSQL specifics', () => {
    let db: PrismaService;
    let repo: PrismaErpEventRepository;
    let mk: DraftBuilder;
    const opened: PrismaService[] = []; // extra clients created by a test; closed after it

    beforeAll(async () => {
      db = new PrismaService({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
      await db.$connect();
      repo = new PrismaErpEventRepository(db);
    });
    afterAll(async () => { await wipe(db); await db.$disconnect(); });
    beforeEach(async () => { await wipe(db); mk = createDraftBuilder(); });
    afterEach(async () => { await Promise.all(opened.splice(0).map((c) => c.$disconnect())); });

    async function open(params: Record<string, string> = {}): Promise<PrismaService> {
      const c = clientFor(params);
      opened.push(c);
      await c.$connect();
      return c;
    }

    // ============================================================ (1) insert inside the caller's transaction
    describe('insert inside a caller transaction', () => {
      class BusinessRuleFailed extends Error {}

      it('leaves no ERP event rows behind when the caller rolls back', async () => {
        const d = mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' });
        const err = await db.$transaction(async (tx) => {
          const res = await repo.insert(d, tx);
          expect(res.created).toBe(true);
          expect(await tx.erpEvent.count()).toBe(1);
          throw new BusinessRuleFailed('disbursement failed after the ERP event was written');
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(BusinessRuleFailed);
        expect(await db.erpEvent.count()).toBe(0);
        expect(await db.erpDeliveryAttempt.count()).toBe(0);
        expect(await repo.getById(d.id)).toBeNull();
        // the idempotency key is free again, so the business operation can be retried
        const retry = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' }));
        expect(retry.created).toBe(true);
      });

      it('is invisible to other connections and not claimable until the caller commits, then fully visible', async () => {
        const d = mk();
        await db.$transaction(async (tx) => {
          const res = await repo.insert(d, tx);
          expect(res.created).toBe(true);
          expect(await tx.erpEvent.count()).toBe(1);
          // seen from outside the transaction (another pooled connection)
          expect(await repo.getById(d.id)).toBeNull();
          expect((await repo.list({ limit: 10 })).items).toEqual([]);
          expect(await repo.claimNext({ now: T0, leaseMs: LEASE_MS, workerId: 'w1' })).toBeNull();
        });
        const stored = await repo.getById(d.id);
        expect(stored).not.toBeNull();
        expect(stored).toMatchObject({ status: 'PENDING', attempts: 0, applicationId: d.header.applicationId });
        expect(stored?.data).toEqual(d.data);
        expect(await repo.claimNext({ now: T0, leaseMs: LEASE_MS, workerId: 'w1' })).toMatchObject({ id: d.id, attempts: 1 });
      });

      it('commits the ERP event together with the caller: several inserts in one transaction all appear', async () => {
        const [a, b, c] = [mk({ applicationId: 'app-A' }), mk({ applicationId: 'app-A' }), mk({ applicationId: 'app-B' })];
        await db.$transaction(async (tx) => {
          for (const d of [a, b, c]) expect((await repo.insert(d, tx)).created).toBe(true);
        });
        const page = await repo.list({ limit: 10 });
        expect(page.items.map((x) => x.id)).toEqual([c.id, b.id, a.id]);
      });

      it('does not abort the caller transaction when the insert is a duplicate or a conflict', async () => {
        const first = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' })); // committed earlier
        await db.$transaction(async (tx) => {
          const dup = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' }), tx);
          expect(dup.created).toBe(false);
          expect(dup.event.id).toBe(first.event.id);

          // same key, different content: reported as a JS error, but the SQL transaction must stay usable
          const conflict = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-2' }), tx).catch((e: unknown) => e);
          expect(conflict).toBeInstanceOf(IdempotencyConflictError);

          // would fail with "current transaction is aborted" (25P02) if a unique violation had poisoned it
          expect(await tx.erpEvent.count()).toBe(1);
          const next = await repo.insert(mk({ key: 'DISBURSEMENT:dr-2', hash: 'h-3' }), tx);
          expect(next.created).toBe(true);
          expect(await tx.erpEvent.count()).toBe(2);
        });
        // the caller's transaction committed: the new entry persisted, the duplicate did not add rows
        expect(await db.erpEvent.count()).toBe(2);
        expect(await db.erpEvent.count({ where: { idempotencyKey: 'DISBURSEMENT:dr-2' } })).toBe(1);
      });

      it('treats a second insert of the same key inside the same transaction as a duplicate', async () => {
        await db.$transaction(async (tx) => {
          const first = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' }), tx);
          const again = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' }), tx);
          expect(first.created).toBe(true);
          expect(again.created).toBe(false);
          expect(again.event.id).toBe(first.event.id);
          expect(again.event.data).toEqual(first.event.data);
          expect(await tx.erpEvent.count()).toBe(1);
        });
        expect(await db.erpEvent.count()).toBe(1);
      });

      it('sees a duplicate that another connection committed after the caller transaction began', async () => {
        await db.$transaction(async (tx) => {
          expect(await tx.erpEvent.count()).toBe(0);
          const other = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' })); // separate connection, commits at once
          const dup = await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' }), tx);
          expect(dup.created).toBe(false);
          expect(dup.event.id).toBe(other.event.id);
        });
        expect(await db.erpEvent.count()).toBe(1);
      });

      it('is atomic: when the row cannot be stored nothing is left behind and the key stays reusable', async () => {
        const bad = mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1', amount: '10000000000000000.00' }); // 17 integer digits > numeric(18,2)
        await expect(repo.insert(bad)).rejects.toThrow();
        expect(await db.erpEvent.count()).toBe(0);
        expect(await repo.getById(bad.id)).toBeNull();
        expect((await repo.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-1' }))).created).toBe(true);
      });
    });

    // ============================================================ (2) real concurrency
    describe('concurrent relays', () => {
      const CLAIM_NOW = at(60_000); // every claimer uses the same instant: nothing can expire or become due mid-test
      const APPS = 10;
      const PER_APP = 3;
      const CLAIMERS = 6;
      const EVENT_ORDER = ['DISBURSEMENT', 'FEE_DEDUCTION', 'REPAYMENT'] as const;

      it('delivers 30 entries across 10 applications exactly once each, in per-application order, with 6 claimers on separate connections', async () => {
        const inserted: ErpEventRecord[] = [];
        for (let round = 0; round < PER_APP; round++) {
          for (let a = 0; a < APPS; a++) inserted.push((await repo.insert(mk({ applicationId: `app-${a}`, eventType: EVENT_ORDER[round] }))).event);
        }
        const total = inserted.length;
        expect(total).toBe(30);
        const appOf = new Map(inserted.map((e) => [e.id, e.applicationId]));

        const claimers: PrismaErpEventRepository[] = [];
        for (let i = 0; i < CLAIMERS; i++) claimers.push(new PrismaErpEventRepository(await open({ connection_limit: '2' })));

        const claimLog: Array<{ worker: string; id: string; seq: bigint }> = [];
        const lostLease: string[] = [];
        let clock = 0; // logical finish time: each completion gets a distinct, increasing instant that is taken after its claim
        let done = 0;
        let aborted = false;
        const deadline = Date.now() + 40_000; // safety net only: a hang becomes a failure instead of a stuck run

        // all claimers hold their first lease at the same moment (proves the claims really overlap)
        let firstRound = 0;
        let leasesAtBarrier = 0;
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
        const arrive = () => {
          if (++firstRound === CLAIMERS) { leasesAtBarrier = claimLog.length; releaseBarrier(); }
        };

        const worker = async (i: number): Promise<void> => {
          const workerId = `claimer-${i}`;
          const mine = claimers[i]!;
          let first = true;
          try {
            while (!aborted && done < total) {
              if (Date.now() > deadline) throw new Error(`timed out with ${done}/${total} delivered`);
              const e = await mine.claimNext({ now: CLAIM_NOW, leaseMs: LEASE_MS, workerId });
              if (e) claimLog.push({ worker: workerId, id: e.id, seq: e.seq });
              if (first) { first = false; arrive(); await barrier; }
              if (!e) { await sleep(2); continue; }
              await sleep((i % 3) * 2); // simulated delivery latency
              const finishedAt = at(100_000 + ++clock);
              const ok = await mine.complete({
                id: e.id, workerId, attemptNo: e.attempts, target: 'mock', startedAt: finishedAt, finishedAt,
                completion: { outcome: 'SENT', externalRef: `GL-${e.id}`, duplicate: false },
              });
              if (ok) done++; else lostLease.push(e.id);
            }
          } catch (err) {
            aborted = true;
            releaseBarrier();
            throw err;
          }
        };
        const results = await Promise.allSettled(Array.from({ length: CLAIMERS }, (_, i) => worker(i)));

        // no deadlocks, serialization or connection errors
        expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
        expect(lostLease).toEqual([]);
        expect(leasesAtBarrier).toBeGreaterThanOrEqual(2);

        // every entry claimed exactly once
        expect(claimLog).toHaveLength(total);
        expect(new Set(claimLog.map((c) => c.id))).toEqual(new Set(inserted.map((e) => e.id)));

        // database state: every entry SENT after exactly one attempt, with exactly one SENT delivery row
        const rows = await db.erpEvent.findMany({ include: { deliveries: true }, orderBy: { seq: 'asc' } });
        expect(rows).toHaveLength(total);
        for (const r of rows) {
          expect(r.status, r.id).toBe('SENT');
          expect(r.attempts, r.id).toBe(1);
          expect(r.lockedBy, r.id).toBeNull();
          expect(r.lockedUntil, r.id).toBeNull();
          expect(r.deliveries.map((d) => d.outcome), r.id).toEqual(['SENT']);
        }
        expect(await db.erpDeliveryAttempt.count()).toBe(total);

        // per-application order: claims and completions both follow seq within an application
        for (let a = 0; a < APPS; a++) {
          const app = `app-${a}`;
          const appRows = rows.filter((r) => r.applicationId === app);
          expect(appRows).toHaveLength(PER_APP);
          const sentAt = appRows.map((r) => r.sentAt!.getTime());
          expect(sentAt, `completion order of ${app}`).toEqual([...sentAt].sort((x, y) => x - y));
          expect(new Set(sentAt).size).toBe(PER_APP);
          const claimedSeqs = claimLog.filter((c) => appOf.get(c.id) === app).map((c) => c.seq);
          expect(claimedSeqs, `claim order of ${app}`).toEqual(appRows.map((r) => r.seq));
        }
      }, 60_000);

      it('hands a single entry to exactly one of six simultaneous claimers, round after round', async () => {
        const claimers: PrismaErpEventRepository[] = [];
        for (let i = 0; i < CLAIMERS; i++) claimers.push(new PrismaErpEventRepository(await open({ connection_limit: '2' })));
        for (let round = 0; round < 8; round++) {
          const e = (await repo.insert(mk())).event;
          const results = await Promise.all(claimers.map((c, i) => c.claimNext({ now: CLAIM_NOW, leaseMs: LEASE_MS, workerId: `claimer-${i}` })));
          const winners = results.filter((r): r is ErpEventRecord => r !== null);
          expect(winners.map((w) => w.id), `round ${round}`).toEqual([e.id]);
          const stored = await repo.getById(e.id);
          expect(stored?.attempts).toBe(1);
          expect(stored?.lockedBy).toBe(winners[0]?.lockedBy);
        }
      }, 30_000);

      it('lets the same idempotency key be inserted by eight simultaneous connections: one creates, the others see it', async () => {
        const writers: PrismaErpEventRepository[] = [];
        for (let i = 0; i < 8; i++) writers.push(new PrismaErpEventRepository(await open({ connection_limit: '2' })));
        const results = await Promise.all(writers.map((w) => w.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: 'h-same' }))));
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
        expect(await db.erpEvent.count()).toBe(1);
        for (const r of results) expect(r.event.data).toEqual({ amount: '1500.50' });
      }, 30_000);

      it('under a simultaneous race one writer wins and every writer with different content gets a conflict', async () => {
        const writers: PrismaErpEventRepository[] = [];
        for (let i = 0; i < 8; i++) writers.push(new PrismaErpEventRepository(await open({ connection_limit: '2' })));
        const outcomes = await Promise.all(writers.map((w, i) => w.insert(mk({ key: 'DISBURSEMENT:dr-1', hash: i % 2 === 0 ? 'h-even' : 'h-odd' })).then(
          (r) => (r.created ? 'created' : 'duplicate'), (e: unknown) => (e instanceof IdempotencyConflictError ? 'conflict' : `error: ${String(e)}`),
        )));
        expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(3); // the other writers that share the winner's hash
        expect(outcomes.filter((o) => o === 'conflict')).toHaveLength(4); // the four writers with the other hash
        expect(await db.erpEvent.count()).toBe(1);
      }, 30_000);

      it('skips an entry whose row is locked by another transaction instead of waiting for it', async () => {
        const a1 = (await repo.insert(mk({ applicationId: 'app-A' }))).event;
        const a2 = (await repo.insert(mk({ applicationId: 'app-A' }))).event;
        const b1 = (await repo.insert(mk({ applicationId: 'app-B' }))).event;
        const claimer = new PrismaErpEventRepository(await open({ connection_limit: '2' }));

        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM origination.erp_event WHERE id = ${a1.id} FOR UPDATE`; // held until this transaction ends
          const claimed = await withTimeout(claimer.claimNext({ now: CLAIM_NOW, leaseMs: LEASE_MS, workerId: 'w1' }), 5_000);
          // a1 is locked (skipped) and a2 must not overtake it, so the only claimable entry is the other application's b1
          expect(claimed).not.toBe('BLOCKED');
          expect((claimed as ErpEventRecord | null)?.id).toBe(b1.id);
          const second = await withTimeout(claimer.claimNext({ now: CLAIM_NOW, leaseMs: LEASE_MS, workerId: 'w1' }), 5_000);
          expect(second).toBeNull();
        }, { timeout: 20_000 });

        expect((await repo.getById(a2.id))?.attempts).toBe(0);
        expect((await claimer.claimNext({ now: CLAIM_NOW, leaseMs: LEASE_MS, workerId: 'w1' }))?.id).toBe(a1.id); // lock released: head of app-A is claimable
      }, 30_000);
    });

    // ============================================================ (3) timestamptz / date / numeric round trips
    describe('time zones, dates and amounts', () => {
      const originalTZ = process.env.TZ;
      afterEach(() => {
        if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
      });

      const ZONES = ['UTC', 'Asia/Ulaanbaatar', 'America/Los_Angeles', 'Pacific/Kiritimati'];
      // 00:30 on 28 Oct in Ulaanbaatar, 09:30 on 27 Oct in Los Angeles, 06:30 on 28 Oct in Kiritimati
      const NOW_A = new Date('2026-10-27T16:30:00.000Z');
      // 07:59:59.999 on 29 Oct in Ulaanbaatar
      const NOW_B = new Date('2026-10-28T23:59:59.999Z');

      // A client whose only connection runs in the given session time zone, with the Node process in the same zone
      async function inZone(zone: string): Promise<{ tzDb: PrismaService; tzRepo: PrismaErpEventRepository }> {
        process.env.TZ = zone;
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
        const tzDb = await open({ connection_limit: '1' });
        await tzDb.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
        const shown = await tzDb.$queryRaw<Array<{ TimeZone: string }>>`SHOW TIME ZONE`;
        expect(shown[0]?.TimeZone).toBe(zone);
        return { tzDb, tzRepo: new PrismaErpEventRepository(tzDb) };
      }

      it.each(ZONES)('keeps businessDate as a calendar date and instants as instants with session and process time zone %s', async (zone) => {
        const { tzDb, tzRepo } = await inZone(zone);
        const dates = ['2026-10-28', '2026-12-31', '2027-01-01', '2024-02-29', '2026-03-29'];
        const drafts = dates.map((businessDate, i) => mk({ header: { businessDate }, now: i % 2 === 0 ? NOW_A : NOW_B }));

        const created: ErpEventRecord[] = [];
        for (const d of drafts) created.push((await tzRepo.insert(d)).event);
        expect(created.map((e) => e.businessDate)).toEqual(dates);
        expect(created.map((e) => e.createdAt.getTime())).toEqual(drafts.map((d) => d.now.getTime()));

        // what is physically stored
        const raw = await tzDb.$queryRaw<Array<{ pd: string; next_ms: string; created_ms: string }>>`
          SELECT business_date::text AS pd, (EXTRACT(EPOCH FROM next_attempt_at) * 1000)::bigint::text AS next_ms,
                 (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ms
          FROM origination.erp_event ORDER BY seq`;
        expect(raw.map((r) => r.pd)).toEqual(dates);
        expect(raw.map((r) => Number(r.next_ms))).toEqual(drafts.map((d) => d.now.getTime()));
        expect(raw.map((r) => Number(r.created_ms))).toEqual(drafts.map((d) => d.now.getTime()));

        // the same rows read back through a client in a different (UTC) session
        const viaUtc = (await repo.list({ limit: 10 })).items.reverse();
        expect(viaUtc.map((e) => e.businessDate)).toEqual(dates);
        expect(viaUtc.map((e) => e.nextAttemptAt.getTime())).toEqual(drafts.map((d) => d.now.getTime()));
        expect(viaUtc.map((e) => e.createdAt.getTime())).toEqual(drafts.map((d) => d.now.getTime()));
        const viaId = await tzRepo.getById(created[0]!.id);
        expect(viaId?.businessDate).toBe('2026-10-28');

        // business date survives being claimed too
        const claimed = await tzRepo.claimNext({ now: NOW_B, leaseMs: LEASE_MS, workerId: 'w1' });
        expect(claimed?.businessDate).toBe('2026-10-28');
      });

      it.each(ZONES)('compares nextAttemptAt and the lease in UTC with session and process time zone %s', async (zone) => {
        const { tzRepo } = await inZone(zone);
        // 2026-11-01 09:00Z is when Los Angeles falls back from PDT to PST: 08:30Z and 09:30Z are both 01:30 on the wall clock there
        const before = new Date('2026-11-01T08:30:00.000Z');
        const after = new Date('2026-11-01T09:30:00.000Z');
        const LEASE = 2 * 3_600_000; // spans the repeated hour
        const plus = (ms: number, d: Date) => new Date(d.getTime() + ms);
        const claim = (now: Date, workerId = 'w1') => tzRepo.claimNext({ now, leaseMs: LEASE, workerId });
        const e1 = (await tzRepo.insert(mk({ now: before }))).event;
        const e2 = (await tzRepo.insert(mk({ now: after }))).event;

        expect(await claim(plus(-1, before))).toBeNull();
        const c1 = await claim(before);
        expect(c1?.id).toBe(e1.id);
        expect(c1?.lockedUntil?.toISOString()).toBe('2026-11-01T10:30:00.000Z');
        expect(await claim(plus(-1, after))).toBeNull(); // e2 is a millisecond away from due, e1 is leased
        const c2 = await claim(after, 'w2');
        expect(c2?.id).toBe(e2.id);

        // e1's lease ends 10:30:00.000Z (e2's at 11:30Z): still held a millisecond before, free a millisecond after
        const e1LeaseEnd = new Date('2026-11-01T10:30:00.000Z');
        expect(await claim(plus(-1, e1LeaseEnd), 'w3')).toBeNull();
        const c3 = await claim(plus(1, e1LeaseEnd), 'w3');
        expect(c3).toMatchObject({ id: e1.id, attempts: 2, lockedBy: 'w3' });

        // read back through the UTC session: the same instants
        const stored = await repo.getById(e1.id);
        expect(stored?.nextAttemptAt.toISOString()).toBe('2026-11-01T08:30:00.000Z');
        expect(stored?.lockedUntil?.toISOString()).toBe('2026-11-01T12:30:00.001Z');
      });

      it.each(ZONES)('round-trips the whole delivery lifecycle instants with session and process time zone %s', async (zone) => {
        const { tzRepo } = await inZone(zone);
        const e = (await tzRepo.insert(mk({ now: NOW_A }))).event;
        const c = await tzRepo.claimNext({ now: NOW_A, leaseMs: LEASE_MS, workerId: 'w1' });
        expect(c?.id).toBe(e.id);
        const startedAt = new Date(NOW_A.getTime() + 5);
        const finishedAt = new Date(NOW_A.getTime() + 80);
        expect(await tzRepo.complete({
          id: e.id, workerId: 'w1', attemptNo: 1, target: 'mock', startedAt, finishedAt,
          completion: { outcome: 'RETRY', nextAttemptAt: NOW_B, errorCode: 'SERVER_ERROR', errorMessage: 'boom', httpStatus: 503 },
        })).toBe(true);

        expect(await tzRepo.claimNext({ now: new Date(NOW_B.getTime() - 1), leaseMs: LEASE_MS, workerId: 'w1' })).toBeNull();
        const again = await tzRepo.claimNext({ now: NOW_B, leaseMs: LEASE_MS, workerId: 'w1' });
        expect(again).toMatchObject({ id: e.id, attempts: 2 });
        const sentAt = new Date(NOW_B.getTime() + 1_000);
        expect(await tzRepo.complete({
          id: e.id, workerId: 'w1', attemptNo: 2, target: 'mock', startedAt: NOW_B, finishedAt: sentAt,
          completion: { outcome: 'SENT', externalRef: 'GL-1', duplicate: false },
        })).toBe(true);

        // read back through the UTC session
        const stored = await repo.getById(e.id);
        expect(stored?.sentAt?.toISOString()).toBe(sentAt.toISOString());
        expect(stored?.nextAttemptAt.toISOString()).toBe(NOW_B.toISOString());
        expect(stored?.deliveries.map((d) => [d.startedAt.toISOString(), d.finishedAt?.toISOString(), d.durationMs])).toEqual([
          [startedAt.toISOString(), finishedAt.toISOString(), 75],
          [NOW_B.toISOString(), sentAt.toISOString(), 1_000],
        ]);

        const cancelAt = new Date('2026-10-28T20:15:00.000Z');
        const dead = (await tzRepo.insert(mk({ now: NOW_A }))).event;
        await tzRepo.cancel(dead.id, 'ops-1', 'time zone check', cancelAt);
        const cancelled = await repo.getById(dead.id);
        expect(cancelled?.deliveries[0]?.startedAt.toISOString()).toBe(cancelAt.toISOString());
      });

      it.each([
        ['9999999999999999.99'], ['0.01'], ['0.10'], ['100.00'], ['1234567890123456.70'], ['10.05'], ['4503599627370496.01'], ['9007199254740993.01'],
      ])('keeps the amount %s exact with two decimals, both in the column and in the JSON data', async (amount) => {
        const d = mk({ amount, data: { amount } });
        const { event } = await repo.insert(d);
        expect(event.amount).toBe(amount);
        expect(event.data).toEqual({ amount });

        const raw = await db.$queryRaw<Array<{ amount: string; json: string }>>`
          SELECT e.amount::text AS amount, e.data->>'amount' AS json FROM origination.erp_event e WHERE e.id = ${d.id}`;
        expect(raw[0]).toEqual({ amount, json: amount });

        expect((await repo.getById(d.id))?.amount).toBe(amount);
        expect((await repo.list({ limit: 1 })).items[0]?.amount).toBe(amount);
        const claimed = await repo.claimNext({ now: T0, leaseMs: LEASE_MS, workerId: 'w1' });
        expect(claimed?.amount).toBe(amount);
        expect(claimed?.data).toEqual({ amount });
      });

      it('rejects an amount that does not fit numeric(18,2) without storing anything', async () => {
        const tooBig = '10000000000000000.00';
        await expect(repo.insert(mk({ amount: tooBig, data: { amount: tooBig } }))).rejects.toThrow();
        expect(await db.erpEvent.count()).toBe(0);
      });
    });
  });
});
