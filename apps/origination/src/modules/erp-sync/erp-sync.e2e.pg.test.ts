// End-to-end against a real PostgreSQL: TEST_DATABASE_URL=postgresql://los@127.0.0.1:55432/<db> (tables already created in schema "origination").
// Builds the real ErpSyncModule (Prisma repository, mock ERP gateway, controller) and drives it through the facade, the relay and HTTP.
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ERP_GATEWAY, ErpPostError, MockErpClient, type ErpGateway, type ErpPostContext, type ErpPostResult } from '../../integrations/erp';
import type { ErpEventPayload, ErpDisbursementInput, ErpFeeDeductionInput, ErpRepaymentInput } from '@los/contracts';
import { ERP_SYNC_CONFIG, type ErpSyncConfig } from './erp-sync.config';
import { IdempotencyConflictError, InvalidErpEventInputError } from './erp-sync.errors';
import { ErpSyncModule } from './erp-sync.module';
import { CommonModule } from '@los/nest-common';
import { PrismaModule, PrismaService, type Tx } from '../../prisma.service';
import { ErpSyncService, type EmitResult } from './erp-sync.service';
import { ERP_EVENT_REPOSITORY, type ErpEventRepository } from './erp-event.repository';
import { OutboxRelayService } from './outbox-relay.service';

const STANDALONE = { standalone: true } as const;

// ---- minimal typed facade over supertest (the workspace has no @types/supertest)
interface Res { status: number; body: Record<string, unknown>; text: string }
interface Req extends PromiseLike<Res> {
  set(name: string, value: string): Req;
  send(body?: unknown): Req;
}
interface Agent { get(url: string): Req; post(url: string): Req }
const nodeRequire = createRequire(__filename);
const supertest = nodeRequire('supertest') as (server: unknown) => Agent;

const DB_URL = process.env.TEST_DATABASE_URL;
const BASE = '/erp-sync/events';
const ORG = 'org-e2e';
const REPAYMENT_DATA = { receivedAmount: '1000.00', principal: '600.00', interest: '300.00', penalty: '50.00', fee: '25.00', overpayment: '25.00' };
const ADMIN = { 'x-roles': 'ADMIN', 'x-user-id': 'admin-e2e', 'x-org-id': ORG };

const ORG_SECOND = 'org-e2e-second';

// Tracks concurrency per application while "calling the ERP" (a few ms) so interleaving really happens
class SlowGateway implements ErpGateway {
  readonly name = 'slow-mock';
  readonly calls: Array<{ key: string; app: string }> = [];
  maxInFlightPerApp = 0;
  private readonly perApp = new Map<string, number>();
  async post(payload: ErpEventPayload, _ctx: ErpPostContext): Promise<ErpPostResult> {
    this.calls.push({ key: payload.idempotencyKey, app: payload.applicationId });
    const n = (this.perApp.get(payload.applicationId) ?? 0) + 1;
    this.perApp.set(payload.applicationId, n);
    this.maxInFlightPerApp = Math.max(this.maxInFlightPerApp, n);
    try {
      await new Promise((resolve) => setTimeout(resolve, 3));
      return { externalRef: `SLOW-${payload.idempotencyKey}`, duplicate: false };
    } finally {
      this.perApp.set(payload.applicationId, (this.perApp.get(payload.applicationId) ?? 1) - 1);
    }
  }
}

describe.skipIf(!DB_URL)('ERP sync end-to-end (PostgreSQL, real module, mock ERP)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let moduleRef: TestingModule;
  let app: INestApplication;
  let db: PrismaService;
  let erpSync: ErpSyncService;
  let relay: OutboxRelayService;
  let eventRepo: ErpEventRepository;
  let config: ErpSyncConfig;
  let mock: MockErpClient;
  let post: MockInstance<MockErpClient['post']>;
  let counter = 0;

  const uid = (prefix: string) => `${prefix}-${++counter}`;
  // the ERP receives organisation-scoped keys: the DB uniqueness is per organisation, the receiver's key space is global
  const wire = (key: string, org = ORG) => `${org}:${key}`;
  const postedKeys = () => post.mock.calls.map(([payload]) => payload.idempotencyKey);

  const repaymentInput = (sourceId: string, over: Record<string, unknown> = {}) => ({
    orgId: ORG, branchId: 'br-e2e', applicationId: 'app-e2e', contractNo: 'C-E2E-1', coreLoanId: 'L-E2E-1', customerId: 'cu-e2e',
    sourceId, currency: 'MNT', businessDate: '2026-10-28', receivedAmount: '1000.00', principal: '600.00', interest: '300.00', penalty: '50.00', fee: '25.00', overpayment: '25.00', ...over,
  }) as ErpRepaymentInput;
  // same business event, different content: a bigger receipt with a consistent allocation
  const BIGGER_RECEIPT = { receivedAmount: '2000.00', principal: '1600.00' };
  const disbursementInput = (sourceId: string, over: Record<string, unknown> = {}) => ({
    orgId: ORG, branchId: 'br-e2e', applicationId: 'app-e2e', contractNo: 'C-E2E-1', coreLoanId: 'L-E2E-1', customerId: 'cu-e2e',
    sourceId, currency: 'MNT', businessDate: '2026-10-28', amount: '5000000.00', ...over,
  }) as ErpDisbursementInput;
  const feeInput = (sourceId: string, over: Record<string, unknown> = {}) => ({
    orgId: ORG, branchId: 'br-e2e', applicationId: 'app-e2e', contractNo: 'C-E2E-1', coreLoanId: 'L-E2E-1', customerId: 'cu-e2e',
    sourceId, currency: 'MNT', businessDate: '2026-10-28', fees: [{ kind: 'ORIGINATION', amount: '100000.00' }, { kind: 'INSURANCE', amount: '50000.00' }], ...over,
  }) as ErpFeeDeductionInput;

  // A business transaction: writes a business row, then emits the ERP event in the same transaction
  const commit = (record: (tx: Tx) => Promise<EmitResult>) =>
    db.$transaction(async (tx) => {
      await tx.outbox.create({ data: { type: 'E2E_BUSINESS', payload: { n: counter } } });
      return record(tx);
    });
  const eventRow = (id: string) => db.erpEvent.findUniqueOrThrow({ where: { id }, include: { deliveries: { orderBy: { startedAt: 'asc' } } } });

  async function call(method: 'get' | 'post', path: string, o: { headers?: Record<string, string> | null; body?: unknown } = {}): Promise<Res> {
    let req = supertest(app.getHttpServer())[method](path);
    for (const [k, v] of Object.entries(o.headers === undefined ? ADMIN : o.headers ?? {})) req = req.set(k, v);
    if (o.body !== undefined) req = req.send(o.body);
    return req;
  }
  const GET = (path: string, headers?: Record<string, string> | null) => call('get', path, { headers });
  const POST = (path: string, body?: unknown, headers?: Record<string, string> | null) => call('post', path, { body, headers });
  const items = (r: Res) => r.body.items as Array<Record<string, unknown>>;

  beforeAll(async () => {
    for (const k of ['INTEGRATION_MODE', 'ERP_RELAY_ENABLED', 'DATABASE_URL']) savedEnv[k] = process.env[k];
    // module factories read process.env while the module is compiled
    process.env.INTEGRATION_MODE = 'mock';
    process.env.ERP_RELAY_ENABLED = 'false';
    process.env.DATABASE_URL = DB_URL;

    moduleRef = await Test.createTestingModule({ imports: [CommonModule.forRoot(), PrismaModule, ErpSyncModule] }).compile();
    Logger.overrideLogger(false);
    app = moduleRef.createNestApplication();
    await app.init();

    db = moduleRef.get(PrismaService);
    erpSync = moduleRef.get(ErpSyncService);
    relay = moduleRef.get(OutboxRelayService);
    eventRepo = moduleRef.get<ErpEventRepository>(ERP_EVENT_REPOSITORY);
    config = moduleRef.get<ErpSyncConfig>(ERP_SYNC_CONFIG);
    mock = moduleRef.get<MockErpClient>(ERP_GATEWAY);

  });

  afterAll(async () => {
    await db?.$executeRawUnsafe('TRUNCATE origination.erp_event CASCADE');
    await db?.outbox.deleteMany({ where: { type: { startsWith: 'E2E_' } } });
    await app?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE origination.erp_event CASCADE');
    await db.outbox.deleteMany({ where: { type: { startsWith: 'E2E_' } } });
    mock.scriptResults([]);
    post = vi.spyOn(mock, 'post');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // ------------------------------------------------------------ transactional outbox

  describe('transactional outbox', () => {
    it('writes the event in the caller transaction: invisible before commit, visible with its data after', async () => {
      const sourceId = uid('pay');
      const result = await db.$transaction(async (tx) => {
        await tx.outbox.create({ data: { type: 'E2E_BUSINESS', payload: { sourceId } } });
        const r = await erpSync.emitRepayment(repaymentInput(sourceId), { tx });
        expect(await tx.erpEvent.count()).toBe(1);
        expect(await db.erpEvent.count()).toBe(0); // another connection sees nothing yet
        expect(await db.outbox.count({ where: { type: 'E2E_BUSINESS' } })).toBe(0);
        return r;
      });

      expect(result).toEqual({ eventId: expect.any(String), idempotencyKey: `REPAYMENT:${sourceId}`, status: 'PENDING', created: true });
      const row = await eventRow(result.eventId);
      expect(row).toMatchObject({
        orgId: ORG, branchId: 'br-e2e', applicationId: 'app-e2e', contractNo: 'C-E2E-1', coreLoanId: 'L-E2E-1', customerId: 'cu-e2e', currency: 'MNT',
        eventType: 'REPAYMENT', sourceId, status: 'PENDING', attempts: 0, lockedBy: null, lockedUntil: null, sentAt: null, externalRef: null,
      });
      expect(row.amount.toFixed(2)).toBe('1000.00');
      expect(row.businessDate.toISOString().slice(0, 10)).toBe('2026-10-28');
      // the ERP builds the journal itself: LOS stores the business event only, no ledger concepts
      expect(row.data).toEqual(REPAYMENT_DATA);
      expect(await db.outbox.count({ where: { type: 'E2E_BUSINESS' } })).toBe(1);
    });

    it('records nothing when the business transaction rolls back', async () => {
      const sourceId = uid('pay');
      await expect(db.$transaction(async (tx) => {
        await tx.outbox.create({ data: { type: 'E2E_BUSINESS', payload: { sourceId } } });
        await erpSync.emitRepayment(repaymentInput(sourceId), { tx });
        throw new Error('business failure after the event was written');
      })).rejects.toThrow('business failure');

      expect(await db.erpEvent.count()).toBe(0);
      expect(await db.erpDeliveryAttempt.count()).toBe(0);
      expect(await db.outbox.count({ where: { type: 'E2E_BUSINESS' } })).toBe(0);
      // and the event can still be emitted afterwards: the rolled-back attempt left no trace
      const again = await commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }));
      expect(again.created).toBe(true);
    });

    it('rolls the business write back too when the event write fails inside the same transaction', async () => {
      const sourceId = uid('pay');
      await commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }));

      await expect(db.$transaction(async (tx) => {
        await tx.outbox.create({ data: { type: 'E2E_LOSER', payload: { sourceId } } });
        await erpSync.emitRepayment(repaymentInput(sourceId, BIGGER_RECEIPT), { tx });
      })).rejects.toBeInstanceOf(IdempotencyConflictError);

      expect(await db.outbox.count({ where: { type: 'E2E_LOSER' } })).toBe(0);
      expect(await db.erpEvent.count()).toBe(1);
    });

    it('does not poison the caller transaction when a replay conflicts and the caller handles it', async () => {
      const sourceId = uid('pay');
      const first = await commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }));

      await db.$transaction(async (tx) => {
        await expect(erpSync.emitRepayment(repaymentInput(sourceId, BIGGER_RECEIPT), { tx }))
          .rejects.toBeInstanceOf(IdempotencyConflictError);
        await tx.outbox.create({ data: { type: 'E2E_AFTER_CONFLICT', payload: { sourceId } } }); // would fail with "transaction aborted" if poisoned
      });

      expect(await db.outbox.count({ where: { type: 'E2E_AFTER_CONFLICT' } })).toBe(1);
      const row = await eventRow(first.eventId);
      expect(row.amount.toFixed(2)).toBe('1000.00');
      expect(row.data).toEqual(REPAYMENT_DATA);
    });

    it('reports an impossible business date as invalid input and leaves the caller transaction usable', async () => {
      await db.$transaction(async (tx) => {
        const err = await erpSync.emitDisbursement(disbursementInput(uid('dr'), { businessDate: '2026-02-30' }), { tx }).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidErpEventInputError);
        await tx.outbox.create({ data: { type: 'E2E_AFTER_INVALID', payload: {} } }); // fails with "transaction is aborted" if PostgreSQL rejected the date
      });
      expect(await db.outbox.count({ where: { type: 'E2E_AFTER_INVALID' } })).toBe(1);
      expect(await db.erpEvent.count()).toBe(0);
    });

    it('runs without a caller transaction too, in its own transaction', async () => {
      const sourceId = uid('dr');
      const r = await erpSync.emitDisbursement(disbursementInput(sourceId), STANDALONE);
      const row = await eventRow(r.eventId);
      expect([row.eventType, row.amount.toFixed(2), row.data]).toEqual(['DISBURSEMENT', '5000000.00', { amount: '5000000.00' }]);
    });
  });

  // ------------------------------------------------------------ idempotency

  describe('idempotency', () => {
    it('ignores a replay of the same business event, before and after delivery', async () => {
      const sourceId = uid('pay');
      const first = await commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }));
      const replay = await commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }));

      expect(replay).toEqual({ ...first, created: false });
      expect(await db.erpEvent.count()).toBe(1);

      expect(await relay.tick()).toMatchObject({ claimed: 1, sent: 1 });
      const afterSend = await erpSync.emitRepayment(repaymentInput(sourceId), STANDALONE);
      expect(afterSend).toEqual({ ...first, status: 'SENT', created: false });

      expect(await relay.tick()).toMatchObject({ claimed: 0 });
      expect(post).toHaveBeenCalledTimes(1);
      expect(await db.erpEvent.count()).toBe(1);
    });

    it('rejects the same source id with different content and keeps the original', async () => {
      const sourceId = uid('pay');
      const first = await erpSync.emitRepayment(repaymentInput(sourceId), STANDALONE);
      const err = await erpSync.emitRepayment(repaymentInput(sourceId, { receivedAmount: '1001.00', overpayment: '26.00' }), STANDALONE).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(IdempotencyConflictError);
      expect((err as IdempotencyConflictError).idempotencyKey).toBe(`REPAYMENT:${sourceId}`);
      expect((await eventRow(first.eventId)).amount.toFixed(2)).toBe('1000.00');
      expect(await db.erpEvent.count()).toBe(1);
    });

    it('creates exactly one event when the same event is emitted by concurrent transactions', async () => {
      const sourceId = uid('pay');
      const results = await Promise.all(Array.from({ length: 4 }, () => commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }))));

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
      expect(await db.erpEvent.count()).toBe(1);
    });

    it('scopes the idempotency key by organisation and by event type', async () => {
      const sourceId = uid('doc');
      const a = await erpSync.emitRepayment(repaymentInput(sourceId), STANDALONE);
      const b = await erpSync.emitRepayment(repaymentInput(sourceId, { orgId: ORG_SECOND }), STANDALONE);
      const c = await erpSync.emitDisbursement(disbursementInput(sourceId), STANDALONE);
      expect([a.created, b.created, c.created]).toEqual([true, true, true]);
      expect(new Set([a.eventId, b.eventId, c.eventId]).size).toBe(3);
      expect((await eventRow(b.eventId)).orgId).toBe(ORG_SECOND);
    });
  });

  // ------------------------------------------------------------ relay with the mock ERP

  describe('relay with the mock ERP', () => {
    it('delivers a committed event: SENT with a MOCK- reference and one attempt row', async () => {
      const sourceId = uid('pay');
      const r = await commit((tx) => erpSync.emitRepayment(repaymentInput(sourceId), { tx }));

      const summary = await relay.tick();

      expect(summary).toEqual({ claimed: 1, sent: 1, duplicates: 0, retried: 0, dead: 0, lostLease: 0, aborted: false, cooldown: false });
      const row = await eventRow(r.eventId);
      expect(row.status).toBe('SENT');
      expect(row.externalRef).toMatch(/^MOCK-[0-9A-F]{12}$/);
      expect(row.attempts).toBe(1);
      expect(row.target).toBe('mock');
      expect(row.sentAt).not.toBeNull();
      expect(row.lockedBy).toBeNull();
      expect(row.lockedUntil).toBeNull();
      expect(row.lastError).toBeNull();
      expect(row.deliveries).toHaveLength(1);
      expect(row.deliveries[0]).toMatchObject({ attemptNo: 1, outcome: 'SENT', target: 'mock', externalRef: row.externalRef, errorCode: null });
      expect(row.deliveries[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('does not deliver anything before a tick (the timer is disabled)', async () => {
      const r = await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      expect((await eventRow(r.eventId)).status).toBe('PENDING');
      expect(post).not.toHaveBeenCalled();
    });

    it('posts the business event payload built from the stored row', async () => {
      const sourceId = uid('pay');
      const r = await erpSync.emitRepayment(repaymentInput(sourceId, { correlationId: 'corr-e2e-1' }), STANDALONE);
      await relay.tick();

      expect(post).toHaveBeenCalledTimes(1);
      const [payload, ctx] = post.mock.calls[0]!;
      expect(payload).toEqual({
        schemaVersion: 1, eventId: r.eventId, idempotencyKey: wire(`REPAYMENT:${sourceId}`), eventType: 'REPAYMENT', orgId: ORG, branchId: 'br-e2e',
        applicationId: 'app-e2e', contractNo: 'C-E2E-1', coreLoanId: 'L-E2E-1', customerId: 'cu-e2e', currency: 'MNT', businessDate: '2026-10-28',
        data: REPAYMENT_DATA, correlationId: 'corr-e2e-1', createdAt: expect.any(String),
      });
      expect(ctx).toEqual({ correlationId: 'corr-e2e-1', attemptNo: 1 });
    });

    it('delivers a full disbursement -> fee -> repayment sequence in order, each key exactly once', async () => {
      const dr = uid('dr');
      const fee = uid('fee');
      const pay = uid('pay');
      const a = await commit((tx) => erpSync.emitDisbursement(disbursementInput(dr), { tx }));
      const b = await commit((tx) => erpSync.emitFeeDeduction(feeInput(fee), { tx }));
      const c = await commit((tx) => erpSync.emitRepayment(repaymentInput(pay), { tx }));
      // an unrelated application in between must not disturb the order of this one
      const other = await erpSync.emitDisbursement(disbursementInput(uid('dr'), { applicationId: 'app-other' }), STANDALONE);

      expect(await relay.tick()).toMatchObject({ claimed: 4, sent: 4, dead: 0, retried: 0, aborted: false });

      const keys = [wire(`DISBURSEMENT:${dr}`), wire(`FEE_DEDUCTION:${fee}`), wire(`REPAYMENT:${pay}`)];
      expect(postedKeys().filter((k) => keys.includes(k))).toEqual(keys);
      expect(postedKeys()).toHaveLength(4);
      expect(new Set(postedKeys()).size).toBe(4);
      expect(postedKeys()).toContain(wire(other.idempotencyKey));
      expect(mock.postedKeys).toEqual(expect.arrayContaining(postedKeys()));

      const rows = await Promise.all([a, b, c].map((r) => eventRow(r.eventId)));
      expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT', 'SENT']);
      expect(rows[0]!.seq < rows[1]!.seq && rows[1]!.seq < rows[2]!.seq).toBe(true);
      expect(rows[0]!.sentAt!.getTime()).toBeLessThanOrEqual(rows[1]!.sentAt!.getTime());
      expect(rows[1]!.sentAt!.getTime()).toBeLessThanOrEqual(rows[2]!.sentAt!.getTime());
      expect(new Set(rows.map((r) => r.externalRef)).size).toBe(3);
      rows.forEach((r) => expect(r.externalRef).toMatch(/^MOCK-[0-9A-F]{12}$/));

      // the delivered events carry the business data; the ERP builds the journal from them
      const [dPayload, fPayload] = [post.mock.calls.find(([p]) => p.idempotencyKey === keys[0])![0], post.mock.calls.find(([p]) => p.idempotencyKey === keys[1])![0]];
      expect(dPayload.data).toEqual({ amount: '5000000.00' });
      expect(fPayload.data).toEqual({ fees: [{ kind: 'ORIGINATION', amount: '100000.00' }, { kind: 'INSURANCE', amount: '50000.00' }], totalAmount: '150000.00' });

      // a second pass and a replay of every business event add no ERP traffic
      expect(await relay.tick()).toMatchObject({ claimed: 0 });
      await commit((tx) => erpSync.emitDisbursement(disbursementInput(dr), { tx }));
      await commit((tx) => erpSync.emitFeeDeduction(feeInput(fee), { tx }));
      await commit((tx) => erpSync.emitRepayment(repaymentInput(pay), { tx }));
      expect(await relay.tick()).toMatchObject({ claimed: 0 });
      expect(post).toHaveBeenCalledTimes(4);
    });

    it('treats a ERP-side duplicate as delivered', async () => {
      const sourceId = uid('pay');
      const r = await erpSync.emitRepayment(repaymentInput(sourceId), STANDALONE);
      await mock.post(
        { schemaVersion: 1, eventId: r.eventId, idempotencyKey: wire(r.idempotencyKey), eventType: 'REPAYMENT', orgId: ORG, branchId: 'br-e2e', applicationId: 'app-e2e',
          contractNo: 'C-E2E-1', coreLoanId: 'L-E2E-1', customerId: 'cu-e2e', currency: 'MNT', businessDate: '2026-10-28', data: REPAYMENT_DATA,
          correlationId: 'c', createdAt: new Date().toISOString() },
        { correlationId: 'c', attemptNo: 1 },
      );

      expect(await relay.tick()).toMatchObject({ claimed: 1, sent: 0, duplicates: 1 });
      const row = await eventRow(r.eventId);
      expect(row.status).toBe('SENT');
      expect(row.deliveries.map((d) => d.outcome)).toEqual(['DUPLICATE']);
    });
  });

  // ------------------------------------------------------------ DEAD handling and ops endpoints

  describe('dead-lettering and the ops endpoints', () => {
    const reject = () => new ErpPostError('event rejected by the ERP', 'PERMANENT', 'REJECTED', 422);

    it('blocks later entries of the same application behind a DEAD entry until it is requeued via the API', async () => {
      const first = await erpSync.emitDisbursement(disbursementInput(uid('dr')), STANDALONE);
      const second = await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      const other = await erpSync.emitDisbursement(disbursementInput(uid('dr'), { applicationId: 'app-other' }), STANDALONE);
      mock.scriptResults([reject()]);

      // tick 1: the first entry is rejected -> DEAD; the second is blocked; another application is unaffected
      expect(await relay.tick()).toEqual({ claimed: 2, sent: 1, duplicates: 0, retried: 0, dead: 1, lostLease: 0, aborted: false, cooldown: false });
      let a = await eventRow(first.eventId);
      let b = await eventRow(second.eventId);
      expect(a).toMatchObject({ status: 'DEAD', attempts: 1, lastErrorCode: 'REJECTED' });
      expect(a.lastError).toContain('event rejected by the ERP');
      expect(a.deliveries[0]).toMatchObject({ outcome: 'DEAD', errorCode: 'REJECTED', httpStatus: 422 });
      expect(b).toMatchObject({ status: 'PENDING', attempts: 0 });
      expect(b.deliveries).toHaveLength(0);
      expect((await eventRow(other.eventId)).status).toBe('SENT');

      // later ticks do not touch the blocked entry
      expect(await relay.tick()).toMatchObject({ claimed: 0 });
      expect(await relay.tick()).toMatchObject({ claimed: 0 });
      expect(post).toHaveBeenCalledTimes(2);
      const stats = await GET(`${BASE}/stats`);
      expect(stats.body).toMatchObject({ counts: { PENDING: 1, SENT: 1, DEAD: 1, CANCELLED: 0 } });

      // ops requeues the DEAD entry
      const requeue = await POST(`${BASE}/${first.eventId}/requeue`, { note: 'ERP account fixed' }, { ...ADMIN, 'x-user-id': 'ops-1' });
      expect(requeue.status).toBe(201);
      expect(requeue.body).toMatchObject({ id: first.eventId, status: 'PENDING', attempts: 0 });

      // tick 2: first and second go out, in that order
      expect(await relay.tick()).toMatchObject({ claimed: 2, sent: 2, dead: 0 });
      expect(postedKeys().slice(2)).toEqual([wire(first.idempotencyKey), wire(second.idempotencyKey)]);
      a = await eventRow(first.eventId);
      b = await eventRow(second.eventId);
      expect([a.status, b.status]).toEqual(['SENT', 'SENT']);
      expect(a.sentAt!.getTime()).toBeLessThanOrEqual(b.sentAt!.getTime());
      expect(b.attempts).toBe(1);
      expect(a.deliveries.map((d) => [d.attemptNo, d.outcome, d.actorId])).toEqual([[1, 'DEAD', null], [1, 'REQUEUED', 'ops-1'], [1, 'SENT', null]]);
      expect(a.deliveries[1]!.note).toBe('ERP account fixed');
    });

    it('unblocks the application when the DEAD entry is cancelled via the API', async () => {
      const first = await erpSync.emitDisbursement(disbursementInput(uid('dr')), STANDALONE);
      const second = await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      mock.scriptResults([reject()]);
      await relay.tick();
      expect(await relay.tick()).toMatchObject({ claimed: 0 });

      const bad = await POST(`${BASE}/${first.eventId}/cancel`, { note: 'x' }, { ...ADMIN, 'x-user-id': 'ops-2' });
      expect(bad.status).toBe(400);
      expect((await eventRow(first.eventId)).status).toBe('DEAD');

      const cancel = await POST(`${BASE}/${first.eventId}/cancel`, { note: 'posted manually in the ERP' }, { ...ADMIN, 'x-user-id': 'ops-2' });
      expect(cancel.status).toBe(201);
      expect(cancel.body).toMatchObject({ status: 'CANCELLED', resolutionNote: 'posted manually in the ERP' });

      expect(await relay.tick()).toMatchObject({ claimed: 1, sent: 1 });
      const cancelled = await eventRow(first.eventId);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.deliveries.at(-1)).toMatchObject({ outcome: 'CANCELLED', actorId: 'ops-2', note: 'posted manually in the ERP' });
      expect((await eventRow(second.eventId)).status).toBe('SENT');
      expect(postedKeys()).toEqual([wire(first.idempotencyKey), wire(second.idempotencyKey)]);
    });

    it('keeps the second entry behind a retrying first entry and sends both after an immediate requeue', async () => {
      const first = await erpSync.emitDisbursement(disbursementInput(uid('dr')), STANDALONE);
      const second = await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      mock.scriptResults([new ErpPostError('ERP unavailable', 'RETRYABLE', 'SERVER_ERROR', 503)]);

      expect(await relay.tick()).toMatchObject({ claimed: 1, retried: 1 });
      const a = await eventRow(first.eventId);
      expect(a).toMatchObject({ status: 'PENDING', attempts: 1, lastErrorCode: 'SERVER_ERROR' });
      expect(a.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // default 30s base backoff (+-20% jitter)
      expect(await relay.tick()).toMatchObject({ claimed: 0 });

      expect((await POST(`${BASE}/${first.eventId}/requeue`, {})).status).toBe(201);
      expect(await relay.tick()).toMatchObject({ claimed: 2, sent: 2 });

      expect(postedKeys()).toEqual([wire(first.idempotencyKey), wire(first.idempotencyKey), wire(second.idempotencyKey)]);
      expect(new Set(mock.postedKeys.filter((k) => k === wire(first.idempotencyKey) || k === wire(second.idempotencyKey))).size).toBe(2);
      expect((await eventRow(first.eventId)).attempts).toBe(2);
      expect((await eventRow(second.eventId)).attempts).toBe(1);
    });

    it('serves the operations API from the database', async () => {
      const d = await erpSync.emitDisbursement(disbursementInput(uid('dr'), { applicationId: 'app-a1' }), STANDALONE);
      const p = await erpSync.emitRepayment(repaymentInput(uid('pay'), { applicationId: 'app-a1' }), STANDALONE);
      const f = await erpSync.emitFeeDeduction(feeInput(uid('fee'), { applicationId: 'app-a2' }), STANDALONE);

      // unauthenticated -> 401, authenticated without erp-sync:manage -> 403
      expect((await GET(BASE, null)).status).toBe(401);
      expect((await GET(BASE, { 'x-roles': 'OFFICER', 'x-user-id': 'officer-1', 'x-org-id': ORG })).status).toBe(403);
      // another organisation's admin sees nothing of this organisation
      const OTHER = { ...ADMIN, 'x-org-id': 'org-e2e-other' };
      expect(items(await GET(BASE, OTHER))).toEqual([]);
      expect((await GET(`${BASE}/${d.eventId}`, OTHER)).status).toBe(404);
      expect((await POST(`${BASE}/${d.eventId}/requeue`, {}, OTHER)).status).toBe(404);
      expect((await POST(`${BASE}/${d.eventId}/cancel`, { note: 'closing it' }, OTHER)).status).toBe(404);
      expect(((await GET(`${BASE}/stats`, OTHER)).body.counts as Record<string, number>).PENDING).toBe(0);

      // dispatch through HTTP delivers everything
      const dispatch = await POST(`${BASE}/dispatch`);
      expect(dispatch.status).toBe(201);
      expect(dispatch.body).toEqual({ claimed: 3, sent: 3, duplicates: 0, retried: 0, dead: 0, lostLease: 0, aborted: false, cooldown: false });

      // list: newest first, serialisable, no content hash
      const list = await GET(BASE);
      expect(list.status).toBe(200);
      expect(items(list).map((i) => i.id)).toEqual([f.eventId, p.eventId, d.eventId]);
      expect(items(list).map((i) => typeof i.seq)).toEqual(['string', 'string', 'string']);
      expect(list.text).not.toContain('contentHash');
      expect(items(list)[0]).toMatchObject({ amount: '150000.00', status: 'SENT', eventType: 'FEE_DEDUCTION', currency: 'MNT', businessDate: '2026-10-28' });

      // filters
      expect(items(await GET(`${BASE}?applicationId=app-a1`)).map((i) => i.id)).toEqual([p.eventId, d.eventId]);
      expect(items(await GET(`${BASE}?eventType=FEE_DEDUCTION`)).map((i) => i.id)).toEqual([f.eventId]);
      expect(items(await GET(`${BASE}?status=DEAD`))).toEqual([]);
      expect(items(await GET(`${BASE}?status=SENT&applicationId=app-a2`)).map((i) => i.id)).toEqual([f.eventId]);

      // pagination by seq cursor
      const page1 = await GET(`${BASE}?limit=2`);
      expect(items(page1).map((i) => i.id)).toEqual([f.eventId, p.eventId]);
      expect(page1.body.nextCursor).toBe(items(page1)[1]!.seq);
      const page2 = await GET(`${BASE}?limit=2&cursor=${page1.body.nextCursor as string}`);
      expect(items(page2).map((i) => i.id)).toEqual([d.eventId]);
      expect(page2.body.nextCursor).toBeNull();

      // validation
      expect((await GET(`${BASE}?limit=0`)).status).toBe(400);
      expect((await GET(`${BASE}?status=NOPE`)).status).toBe(400);

      // stats
      const stats = await GET(`${BASE}/stats`);
      expect(stats.body).toMatchObject({ counts: { PENDING: 0, SENT: 3, DEAD: 0, CANCELLED: 0 }, oldestPendingAt: null, nextAttemptAt: null, lagSeconds: 0 });

      // detail with deliveries
      const detail = await GET(`${BASE}/${p.eventId}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ id: p.eventId, status: 'SENT', target: 'mock' });
      expect(detail.body).not.toHaveProperty('contentHash');
      expect(detail.body.data).toEqual(REPAYMENT_DATA);
      expect(detail.body).not.toHaveProperty('lines');
      expect(detail.body.deliveries).toEqual([expect.objectContaining({ attemptNo: 1, outcome: 'SENT', target: 'mock', startedAt: expect.any(String), finishedAt: expect.any(String) })]);

      // errors
      const missing = '00000000-0000-4000-8000-000000000000';
      expect((await GET(`${BASE}/${missing}`)).status).toBe(404);
      expect((await POST(`${BASE}/${missing}/requeue`, {})).status).toBe(404);
      expect((await POST(`${BASE}/${missing}/cancel`, { note: 'no such entry' })).status).toBe(404);
      expect((await GET(`${BASE}/does-not-exist`)).status).toBe(400);
      expect((await POST(`${BASE}/${p.eventId}/requeue`, {})).status).toBe(409);
      expect((await POST(`${BASE}/${p.eventId}/cancel`, { note: 'already delivered' })).status).toBe(409);
      expect((await eventRow(p.eventId)).status).toBe('SENT');
    });

    it('never answers with a server error for a cursor beyond the bigint range', async () => {
      await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      const res = await GET(`${BASE}?cursor=99999999999999999999`);
      expect(res.status).toBeLessThan(500); // either a 400 or simply "everything older than that", never a 500
    });

    it('refuses to cancel an entry while a worker holds its lease, and allows it once the lease has expired', async () => {
      const r = await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      expect((await eventRepo.claimNext({ now: new Date(), leaseMs: 60_000, workerId: 'busy-worker' }))?.id).toBe(r.eventId);

      const busy = await POST(`${BASE}/${r.eventId}/cancel`, { note: 'cancel while sending' });
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ code: 'ERP_EVENT_STATE_CONFLICT' });
      expect(String(busy.body.message)).toContain('ERP event is being sent right now');
      expect(await db.erpEvent.findUniqueOrThrow({ where: { id: r.eventId } })).toMatchObject({ status: 'PENDING', lockedBy: 'busy-worker' });

      await db.erpEvent.update({ where: { id: r.eventId }, data: { lockedUntil: new Date(Date.now() - 1_000) } }); // the worker is gone
      const done = await POST(`${BASE}/${r.eventId}/cancel`, { note: 'worker died, handled manually' });
      expect(done.status).toBe(201);
      expect(done.body).toMatchObject({ status: 'CANCELLED', lockedBy: null });
    });

    it('reports lag for entries that are still waiting', async () => {
      await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      const stats = await GET(`${BASE}/stats`);
      expect(stats.body).toMatchObject({ counts: { PENDING: 1, SENT: 0, DEAD: 0, CANCELLED: 0 } });
      expect(stats.body.oldestPendingAt).toEqual(expect.any(String));
      expect(stats.body.lagSeconds as number).toBeGreaterThanOrEqual(0);
      expect(stats.body.lagSeconds as number).toBeLessThan(30);
    });
  });

  // ------------------------------------------------------------ concurrent relays on PostgreSQL

  describe('concurrent relays (FOR UPDATE SKIP LOCKED)', () => {
    it('never double-sends and keeps per-application order with two relays x three workers', async () => {
      const apps = ['app-c1', 'app-c2', 'app-c3', 'app-c4'];
      const expectedByApp = new Map<string, string[]>();
      for (let round = 0; round < 4; round++) {
        for (const applicationId of apps) {
          const r = await erpSync.emitRepayment(repaymentInput(uid('pay'), { applicationId }), STANDALONE);
          expectedByApp.set(applicationId, [...(expectedByApp.get(applicationId) ?? []), wire(r.idempotencyKey)]);
        }
      }
      const gateway = new SlowGateway();
      const cfg: ErpSyncConfig = { ...config, relay: { ...config.relay, concurrency: 3, batchSize: 50 } };
      const one = new OutboxRelayService(eventRepo, gateway, cfg, undefined, { workerId: 'relay-1' });
      const two = new OutboxRelayService(eventRepo, gateway, cfg, undefined, { workerId: 'relay-2' });

      const [s1, s2] = await Promise.all([one.tick(), two.tick()]);

      expect(s1.claimed + s2.claimed).toBe(16);
      expect(s1.sent + s2.sent).toBe(16);
      expect(s1.lostLease + s2.lostLease).toBe(0);
      expect(gateway.calls).toHaveLength(16);
      expect(new Set(gateway.calls.map((c) => c.key)).size).toBe(16);
      expect(gateway.maxInFlightPerApp).toBe(1);
      for (const [applicationId, keys] of expectedByApp) expect(gateway.calls.filter((c) => c.app === applicationId).map((c) => c.key)).toEqual(keys);

      const rows = await db.erpEvent.findMany();
      expect(rows).toHaveLength(16);
      expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1 && r.lockedBy === null)).toBe(true);
      expect(await db.erpDeliveryAttempt.count()).toBe(16);
    });

    it('skips a row locked by another transaction instead of waiting for it', async () => {
      const headA = await erpSync.emitRepayment(repaymentInput(uid('pay'), { applicationId: 'app-lock-a' }), STANDALONE);
      const headB = await erpSync.emitRepayment(repaymentInput(uid('pay'), { applicationId: 'app-lock-b' }), STANDALONE);

      await db.$transaction(async (tx) => {
        // another instance is in the middle of claiming application A's head entry
        await tx.$queryRaw`SELECT id FROM origination.erp_event WHERE id = ${headA.eventId} FOR UPDATE`;
        const claimed = await eventRepo.claimNext({ now: new Date(), leaseMs: 60_000, workerId: 'second-instance' });
        expect(claimed?.id).toBe(headB.eventId);
        // nothing else is claimable: A's head is locked, so it is skipped (and not waited for)
        expect(await eventRepo.claimNext({ now: new Date(), leaseMs: 60_000, workerId: 'second-instance' })).toBeNull();
      });

      expect(await db.erpEvent.findUniqueOrThrow({ where: { id: headA.eventId } })).toMatchObject({ status: 'PENDING', attempts: 0, lockedBy: null });
      expect(await db.erpEvent.findUniqueOrThrow({ where: { id: headB.eventId } })).toMatchObject({ attempts: 1, lockedBy: 'second-instance' });
    });

    it('re-claims an entry whose worker died holding the lease once the lease has expired', async () => {
      const r = await erpSync.emitRepayment(repaymentInput(uid('pay')), STANDALONE);
      const now = new Date();
      const crashed = await eventRepo.claimNext({ now, leaseMs: 60_000, workerId: 'crashed-worker' });
      expect(crashed?.id).toBe(r.eventId);
      expect(crashed?.attempts).toBe(1);

      // lease still valid: nothing is claimable
      expect(await relay.tick()).toMatchObject({ claimed: 0 });
      expect(await eventRepo.claimNext({ now: new Date(now.getTime() + 59_000), leaseMs: 60_000, workerId: 'other' })).toBeNull();

      // after expiry the entry is claimed again and the attempt counter keeps counting
      const again = await eventRepo.claimNext({ now: new Date(now.getTime() + 61_000), leaseMs: 60_000, workerId: 'rescuer' });
      expect(again).toMatchObject({ id: r.eventId, attempts: 2, lockedBy: 'rescuer' });
      // the crashed worker's late completion must not overwrite anything
      const late = await eventRepo.complete({
        id: r.eventId, workerId: 'crashed-worker', attemptNo: 1, completion: { outcome: 'SENT', externalRef: 'LATE', duplicate: false },
        target: 'mock', startedAt: now, finishedAt: now,
      });
      expect(late).toBe(false);
      const row = await eventRow(r.eventId);
      expect(row).toMatchObject({ status: 'PENDING', externalRef: null, lockedBy: 'rescuer' });
      expect(row.deliveries).toHaveLength(0);
    });
  });
});
