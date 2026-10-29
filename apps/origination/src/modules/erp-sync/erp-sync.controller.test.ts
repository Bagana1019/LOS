import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ErpSyncController } from './erp-sync.controller';
import { ErpSyncService, type EmitResult } from './erp-sync.service';
import { Clock, CommonModule } from '@los/nest-common';
import { ERP_EVENT_REPOSITORY, type Completion, type ErpEventRecord } from './erp-event.repository';
import { OutboxRelayService, type TickSummary } from './outbox-relay.service';
import { MemoryErpEventRepository } from './testing/memory-erp-event.repository';

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

// ---- fixtures
const T0 = new Date('2026-10-28T09:00:00.000Z');
const BASE = '/erp-sync/events';
const ADMIN = { 'x-roles': 'ADMIN', 'x-user-id': 'admin-1', 'x-org-id': 'org-1' };
const MISSING = '00000000-0000-4000-8000-000000000000';
const ZERO_SUMMARY: TickSummary = { claimed: 0, sent: 0, duplicates: 0, retried: 0, dead: 0, lostLease: 0, aborted: false, cooldown: false };

class TestClock implements Clock {
  constructor(private ms: number) {}
  now(): Date { return new Date(this.ms); }
  set(d: Date): void { this.ms = d.getTime(); }
}

let app: INestApplication;
let repo: MemoryErpEventRepository;
let service: ErpSyncService;
let clock: TestClock;
let tick: ReturnType<typeof vi.fn<() => Promise<TickSummary>>>;

beforeEach(async () => {
  clock = new TestClock(T0.getTime());
  repo = new MemoryErpEventRepository();
  tick = vi.fn(async () => ZERO_SUMMARY);
  service = new ErpSyncService(repo, clock);
  const moduleRef = await Test.createTestingModule({
    imports: [CommonModule.forRoot()],
    controllers: [ErpSyncController],
    providers: [
      { provide: ERP_EVENT_REPOSITORY, useValue: repo },
      { provide: OutboxRelayService, useValue: { tick, status: () => ({ target: 'mock-ERP', mode: 'mock', enabled: true, cooldownUntil: null }) } },
      { provide: Clock, useValue: clock },
    ],
  }).compile();
  Logger.overrideLogger(false); // compile() installs Nest's TestingLogger; keep expected 4xx/5xx noise out of the output
  app = moduleRef.createNestApplication();
  await app.init();
});
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });

async function call(method: 'get' | 'post', path: string, o: { headers?: Record<string, string> | null; body?: unknown } = {}): Promise<Res> {
  let req = supertest(app.getHttpServer())[method](path);
  for (const [k, v] of Object.entries(o.headers === undefined ? ADMIN : o.headers ?? {})) req = req.set(k, v);
  if (o.body !== undefined) req = req.send(o.body);
  return req;
}
const GET = (path: string, headers?: Record<string, string> | null) => call('get', path, { headers });
const POST = (path: string, body?: unknown, headers?: Record<string, string> | null) => call('post', path, { body, headers });

const items = (r: Res) => r.body.items as Array<Record<string, unknown>>;
// AllExceptionsFilter: 400 { code: 'VALIDATION_FAILED', details: [{ path, message }] }
const hasField = (r: Res, field: string) => (r.body.details as Array<{ path: string }> | undefined)?.some((d) => d.path === field || d.path.startsWith(`${field}.`)) ?? false;

// `n` repayments, each in its own application, created in order (seq 1..n)
async function seed(n: number, over: { type?: 'REPAYMENT' | 'DISBURSEMENT' | 'FEE_DEDUCTION' } = {}): Promise<EmitResult[]> {
  const out: EmitResult[] = [];
  for (let i = 1; i <= n; i++) {
    const common = { orgId: 'org-1', branchId: 'br-1', applicationId: `app-${i}`, contractNo: `C-${i}`, coreLoanId: 'L-1', customerId: 'cu-1', currency: 'MNT', businessDate: '2026-10-28', sourceId: `src-${i}` };
    if (over.type === 'DISBURSEMENT') out.push(await service.emitDisbursement({ ...common, amount: '1000.00' }, STANDALONE));
    else if (over.type === 'FEE_DEDUCTION') out.push(await service.emitFeeDeduction({ ...common, fees: [{ kind: 'SERVICE', amount: 10 }] }, STANDALONE));
    else out.push(await service.emitRepayment({ ...common, receivedAmount: '1000.00', principal: '600.00', interest: '400.00', penalty: 0, fee: 0, overpayment: 0 }, STANDALONE));
  }
  return out;
}

// Settle the next claimable entries in seq order (each seeded in its own application, so they are all claimable)
async function settle(...completions: Completion[]): Promise<string[]> {
  const ids: string[] = [];
  for (const completion of completions) {
    const claimed = await repo.claimNext({ now: clock.now(), leaseMs: 60_000, workerId: 'seed' });
    if (!claimed) throw new Error('nothing to claim');
    await repo.complete({ id: claimed.id, workerId: 'seed', attemptNo: claimed.attempts, completion, target: 'mock', startedAt: clock.now(), finishedAt: clock.now() });
    ids.push(claimed.id);
  }
  return ids;
}
const SENT: Completion = { outcome: 'SENT', externalRef: 'MOCK-1', duplicate: false };
const DEAD: Completion = { outcome: 'DEAD', errorCode: 'REJECTED', errorMessage: 'ERP rejected the event', httpStatus: 422 };
const RETRY = (at: Date): Completion => ({ outcome: 'RETRY', nextAttemptAt: at, errorCode: 'SERVER_ERROR', errorMessage: 'ERP down', httpStatus: 503 });

const statusOf = async (id: string) => (await repo.getById(id))?.status;

// ---------------------------------------------------------------- tests

describe('ErpSyncController permission guard (erp-sync:manage)', () => {
  const routes: Array<[string, 'get' | 'post', string]> = [
    ['list', 'get', BASE],
    ['stats', 'get', `${BASE}/stats`],
    ['detail', 'get', `${BASE}/${MISSING}`],
    ['dispatch', 'post', `${BASE}/dispatch`],
    ['requeue', 'post', `${BASE}/${MISSING}/requeue`],
    ['requeue-dead', 'post', `${BASE}/requeue-dead`],
    ['cancel', 'post', `${BASE}/${MISSING}/cancel`],
  ];

  it.each(routes)('answers 401 to %s without the gateway identity headers', async (_name, method, path) => {
    const res = await call(method, path, { headers: null, body: { note: 'long enough note' } });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(tick).not.toHaveBeenCalled();
  });

  it('answers 401 when the organisation header is missing', async () => {
    const res = await GET(BASE, { 'x-roles': 'ADMIN', 'x-user-id': 'admin-1' });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'MISSING_ORG' });
  });

  it.each([['OFFICER'], ['APPROVER'], ['BRANCH_MANAGER'], ['ADMINISTRATOR'], ['SUPERADMIN,OFFICER'], ['']])('answers 403 for the roles %j', async (roles) => {
    const headers = { ...ADMIN, 'x-roles': roles };
    expect((await GET(BASE, headers)).status).toBe(403);
    expect((await POST(`${BASE}/dispatch`, undefined, headers)).status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  // the foundation context trims and upper-cases the roles gateway sends
  it.each([['ADMIN'], ['admin'], ['OFFICER,ADMIN'], ['ADMIN,OFFICER'], ['OFFICER, ADMIN'], [' ADMIN '], ['REVIEWER,OFFICER,ADMIN']])('accepts the roles %j', async (roles) => {
    expect((await GET(BASE, { ...ADMIN, 'x-roles': roles })).status).toBe(200);
  });

  it('does not change state for a forbidden requeue or cancel', async () => {
    const [{ eventId }] = await seed(1);
    const [id] = await settle(DEAD);
    expect(id).toBe(eventId);
    const officer = { ...ADMIN, 'x-roles': 'OFFICER' };
    expect((await POST(`${BASE}/${id}/requeue`, {}, officer)).status).toBe(403);
    expect((await POST(`${BASE}/${id}/cancel`, { note: 'closing it' }, officer)).status).toBe(403);
    expect(await statusOf(eventId)).toBe('DEAD');
  });
});

// Foundation rule (docs/00-foundation.md §3, NFR-3): every query is scoped to the caller's organisation
describe('organisation scope', () => {
  const OTHER = { ...ADMIN, 'x-org-id': 'org-2' };

  it('shows another organisation no entries, no details and no counts', async () => {
    const [{ eventId }] = await seed(2);
    expect(items(await GET(BASE, OTHER))).toEqual([]);
    expect(await GET(`${BASE}/${eventId}`, OTHER)).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect((await GET(`${BASE}/stats`, OTHER)).body).toMatchObject({ counts: { PENDING: 0, SENT: 0, DEAD: 0, CANCELLED: 0 }, lagSeconds: 0 });
    expect((await GET(`${BASE}/stats`)).body).toMatchObject({ counts: { PENDING: 2 } });
  });

  it('answers 404 (not 403) to requeue and cancel of another organisation\'s entry and leaves it untouched', async () => {
    await seed(1);
    const [id] = await settle(DEAD);
    expect((await POST(`${BASE}/${id}/requeue`, { note: 'try again' }, OTHER)).status).toBe(404);
    expect((await POST(`${BASE}/${id}/cancel`, { note: 'closing it' }, OTHER)).status).toBe(404);
    expect(await statusOf(id!)).toBe('DEAD');
  });

  it('requeues only the own organisation\'s DEAD entries in bulk', async () => {
    await seed(2);
    const ids = await settle(DEAD, DEAD);
    const res = await POST(`${BASE}/requeue-dead`, {}, OTHER);
    expect(res.body).toEqual({ matched: 0, requeued: 0, failed: [] });
    expect(await Promise.all(ids.map(statusOf))).toEqual(['DEAD', 'DEAD']);
    expect((await POST(`${BASE}/requeue-dead`, {})).body).toMatchObject({ matched: 2, requeued: 2 });
  });
});

describe('GET /erp-sync/events', () => {
  it('returns an empty page when there are no entries', async () => {
    const res = await GET(BASE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('lists the newest entries first with a serialisable view that never leaks the content hash', async () => {
    const [{ eventId }] = await seed(1);
    const res = await GET(BASE);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(items(res)).toHaveLength(1);
    expect(items(res)[0]).toEqual({
      id: eventId, seq: '1', orgId: 'org-1', branchId: 'br-1', idempotencyKey: 'REPAYMENT:src-1', eventType: 'REPAYMENT', sourceId: 'src-1',
      applicationId: 'app-1', contractNo: 'C-1', coreLoanId: 'L-1', customerId: 'cu-1', currency: 'MNT', businessDate: '2026-10-28',
      correlationId: expect.any(String), amount: '1000.00', status: 'PENDING', attempts: 0,
      nextAttemptAt: T0.toISOString(), lockedUntil: null, lockedBy: null, lastErrorCode: null, lastError: null, sentAt: null, externalRef: null,
      target: null, resolutionNote: null, createdAt: T0.toISOString(), updatedAt: T0.toISOString(),
      data: { receivedAmount: '1000.00', principal: '600.00', interest: '400.00', penalty: '0.00', fee: '0.00', overpayment: '0.00' },
    });
    expect(res.text).not.toContain('contentHash');
  });

  it('serialises a seq beyond Number.MAX_SAFE_INTEGER without losing precision', async () => {
    const [{ eventId }] = await seed(1);
    const stored = (await repo.getById(eventId)) as ErpEventRecord;
    vi.spyOn(repo, 'list').mockResolvedValueOnce({ items: [{ ...stored, seq: 9_007_199_254_740_993n }], nextCursor: '9007199254740993' });
    const res = await GET(BASE);
    expect(res.status).toBe(200);
    expect(items(res)[0]!.seq).toBe('9007199254740993');
    expect(res.body.nextCursor).toBe('9007199254740993');
  });

  it('serialises every date as an ISO string', async () => {
    const [{ eventId }] = await seed(1);
    const [id] = await settle(SENT);
    expect(id).toBe(eventId);
    const item = items(await GET(BASE))[0]!;
    for (const field of ['nextAttemptAt', 'sentAt', 'createdAt', 'updatedAt']) expect(item[field]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(item).toMatchObject({ status: 'SENT', externalRef: 'MOCK-1', sentAt: T0.toISOString(), attempts: 1 });
  });

  it('filters by status', async () => {
    await seed(4);
    const [sent, dead] = await settle(SENT, DEAD);
    const pending = await GET(`${BASE}?status=PENDING`);
    expect(items(pending)).toHaveLength(2);
    expect(items(pending).every((i) => i.status === 'PENDING')).toBe(true);
    expect(items(await GET(`${BASE}?status=SENT`)).map((i) => i.id)).toEqual([sent]);
    expect(items(await GET(`${BASE}?status=DEAD`)).map((i) => i.id)).toEqual([dead]);
    expect(items(await GET(`${BASE}?status=CANCELLED`))).toEqual([]);
  });

  it('filters by event type', async () => {
    await service.emitDisbursement({ orgId: 'org-1', applicationId: 'app-1', sourceId: 'd-1', currency: 'MNT', businessDate: '2026-10-28', amount: 100 }, STANDALONE);
    await service.emitFeeDeduction({ orgId: 'org-1', applicationId: 'app-1', sourceId: 'f-1', currency: 'MNT', businessDate: '2026-10-28', fees: [{ kind: 'SERVICE', amount: 5 }] }, STANDALONE);
    await service.emitRepayment({ orgId: 'org-1', applicationId: 'app-1', sourceId: 'r-1', currency: 'MNT', businessDate: '2026-10-28', receivedAmount: 50, principal: 0, interest: 0, penalty: 0, fee: 0, overpayment: 50 }, STANDALONE);
    expect(items(await GET(`${BASE}?eventType=DISBURSEMENT`)).map((i) => i.sourceId)).toEqual(['d-1']);
    expect(items(await GET(`${BASE}?eventType=FEE_DEDUCTION`)).map((i) => i.sourceId)).toEqual(['f-1']);
    expect(items(await GET(`${BASE}?eventType=REPAYMENT`)).map((i) => i.sourceId)).toEqual(['r-1']);
  });

  it('filters by application and combines filters', async () => {
    await seed(3);
    await service.emitDisbursement({ orgId: 'org-1', applicationId: 'app-2', sourceId: 'd-2', currency: 'MNT', businessDate: '2026-10-28', amount: 100 }, STANDALONE);
    expect(items(await GET(`${BASE}?applicationId=app-2`)).map((i) => i.sourceId)).toEqual(['d-2', 'src-2']);
    expect(items(await GET(`${BASE}?applicationId=app-2&eventType=REPAYMENT`)).map((i) => i.sourceId)).toEqual(['src-2']);
    expect(items(await GET(`${BASE}?applicationId=app-2&status=SENT`))).toEqual([]);
    expect(items(await GET(`${BASE}?applicationId=nobody`))).toEqual([]);
  });

  it('paginates with limit and a seq cursor until the end', async () => {
    await seed(5);

    const page1 = await GET(`${BASE}?limit=2`);
    expect(items(page1).map((i) => i.seq)).toEqual(['5', '4']);
    expect(page1.body.nextCursor).toBe('4');

    const page2 = await GET(`${BASE}?limit=2&cursor=4`);
    expect(items(page2).map((i) => i.seq)).toEqual(['3', '2']);
    expect(page2.body.nextCursor).toBe('2');

    const page3 = await GET(`${BASE}?limit=2&cursor=2`);
    expect(items(page3).map((i) => i.seq)).toEqual(['1']);
    expect(page3.body.nextCursor).toBeNull();
  });

  it('returns no cursor when the page is exactly full and nothing remains', async () => {
    await seed(3);
    const res = await GET(`${BASE}?limit=3`);
    expect(items(res)).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it('defaults the page size to 50', async () => {
    const spy = vi.spyOn(repo, 'list');
    await GET(BASE);
    expect(spy).toHaveBeenCalledWith({ limit: 50, orgId: 'org-1' });
  });

  it('passes parsed filters through to the repository', async () => {
    const spy = vi.spyOn(repo, 'list');
    await GET(`${BASE}?status=DEAD&eventType=REPAYMENT&applicationId=app-9&limit=7&cursor=12`);
    expect(spy).toHaveBeenCalledWith({ orgId: 'org-1', status: 'DEAD', eventType: 'REPAYMENT', applicationId: 'app-9', limit: 7, cursor: '12' });
  });

  it.each([
    ['limit=0', 'limit'],
    ['limit=-1', 'limit'],
    ['limit=101', 'limit'],
    ['limit=abc', 'limit'],
    ['limit=10.5', 'limit'],
    ['limit=', 'limit'],
    ['status=FOO', 'status'],
    ['status=pending', 'status'],
    ['status=PENDING&status=SENT', 'status'],
    ['eventType=REFUND', 'eventType'],
    ['cursor=abc', 'cursor'],
    ['cursor=-1', 'cursor'],
    ['cursor=1.5', 'cursor'],
  ])('answers 400 for ?%s and names the field', async (query, field) => {
    const spy = vi.spyOn(repo, 'list');
    const res = await GET(`${BASE}?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(hasField(res, field)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts the limits 1 and 100', async () => {
    expect((await GET(`${BASE}?limit=1`)).status).toBe(200);
    expect((await GET(`${BASE}?limit=100`)).status).toBe(200);
  });
});

describe('GET /erp-sync/events/stats', () => {
  it('reports zero counts and no lag when the outbox is empty', async () => {
    const res = await GET(`${BASE}/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: { PENDING: 0, SENT: 0, DEAD: 0, CANCELLED: 0 }, oldestPendingAt: null, nextAttemptAt: null, lagSeconds: 0,
      relay: { target: 'mock-ERP', mode: 'mock', enabled: true, cooldownUntil: null },
    });
  });

  it('is not captured by the :id route', async () => {
    const res = await GET(`${BASE}/stats`);
    expect(res.body).toHaveProperty('counts');
    expect(res.body).not.toHaveProperty('statusCode');
  });

  it('counts entries per status and measures the lag from the oldest pending entry', async () => {
    clock.set(new Date(T0.getTime() - 300_000));
    await seed(1); // becomes SENT below, so it must not count as pending
    clock.set(new Date(T0.getTime() - 125_400));
    await service.emitRepayment({ orgId: 'org-1', applicationId: 'app-9', sourceId: 'old', currency: 'MNT', businessDate: '2026-10-28', receivedAmount: 10, principal: 0, interest: 0, penalty: 0, fee: 0, overpayment: 10 }, STANDALONE);
    clock.set(new Date(T0.getTime() - 10_000));
    await service.emitRepayment({ orgId: 'org-1', applicationId: 'app-10', sourceId: 'new', currency: 'MNT', businessDate: '2026-10-28', receivedAmount: 10, principal: 0, interest: 0, penalty: 0, fee: 0, overpayment: 10 }, STANDALONE);
    clock.set(T0);
    const [sentId] = await settle(SENT);
    expect(await statusOf(sentId!)).toBe('SENT');

    const res = await GET(`${BASE}/stats`);
    expect(res.body).toEqual({
      counts: { PENDING: 2, SENT: 1, DEAD: 0, CANCELLED: 0 },
      oldestPendingAt: new Date(T0.getTime() - 125_400).toISOString(),
      nextAttemptAt: new Date(T0.getTime() - 125_400).toISOString(),
      lagSeconds: 125,
      relay: { target: 'mock-ERP', mode: 'mock', enabled: true, cooldownUntil: null },
    });
  });

  it('rounds the lag to the nearest second', async () => {
    clock.set(new Date(T0.getTime() - 125_600));
    await seed(1);
    clock.set(T0);
    expect((await GET(`${BASE}/stats`)).body.lagSeconds).toBe(126);
  });

  it('never reports a negative lag, even with clock skew', async () => {
    clock.set(new Date(T0.getTime() + 10_000));
    await seed(1);
    clock.set(T0);
    expect((await GET(`${BASE}/stats`)).body.lagSeconds).toBe(0);
  });

  it('reports the earliest scheduled retry as nextAttemptAt', async () => {
    await seed(1);
    const retryAt = new Date(T0.getTime() + 30_000);
    await settle(RETRY(retryAt));
    const res = await GET(`${BASE}/stats`);
    expect(res.body).toMatchObject({ counts: { PENDING: 1 }, oldestPendingAt: T0.toISOString(), nextAttemptAt: retryAt.toISOString(), lagSeconds: 0 });
  });

  it('counts dead and cancelled entries without treating them as pending', async () => {
    await seed(3);
    const [, dead] = await settle(SENT, DEAD);
    await POST(`${BASE}/${dead}/cancel`, { note: 'handled by hand' });
    const res = await GET(`${BASE}/stats`);
    expect(res.body).toMatchObject({ counts: { PENDING: 1, SENT: 1, DEAD: 0, CANCELLED: 1 } });
  });
});

describe('GET /erp-sync/events/:id', () => {
  it('returns the event with its data and an empty delivery history', async () => {
    const [{ eventId }] = await seed(1);
    const res = await GET(`${BASE}/${eventId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: eventId, seq: '1', status: 'PENDING', idempotencyKey: 'REPAYMENT:src-1', deliveries: [] });
    expect(res.body.data).toEqual({ receivedAmount: '1000.00', principal: '600.00', interest: '400.00', penalty: '0.00', fee: '0.00', overpayment: '0.00' });
    expect(res.body).not.toHaveProperty('lines');
  });

  it('serialises seq as a string and never leaks the content hash', async () => {
    const [{ eventId }] = await seed(1);
    const res = await GET(`${BASE}/${eventId}`);
    expect(typeof res.body.seq).toBe('string');
    expect(res.body).not.toHaveProperty('contentHash');
    expect(res.text).not.toContain('contentHash');
    const stored = await repo.getById(eventId);
    expect(res.text).not.toContain(stored!.contentHash);
  });

  it('includes the delivery attempts, manual actions included, with ISO dates', async () => {
    const [{ eventId }] = await seed(1);
    const retryAt = new Date(T0.getTime() + 30_000);
    await settle(RETRY(retryAt));
    clock.set(new Date(T0.getTime() + 5_000));
    await POST(`${BASE}/${eventId}/requeue`, { note: 'try now' }, { ...ADMIN, 'x-user-id': 'u-1' });

    const res = await GET(`${BASE}/${eventId}`);
    expect(res.body.deliveries).toEqual([
      {
        attemptNo: 1, outcome: 'RETRY', errorCode: 'SERVER_ERROR', errorMessage: 'ERP down', httpStatus: 503, durationMs: 0, externalRef: null,
        target: 'mock', actorId: null, note: null, startedAt: T0.toISOString(), finishedAt: T0.toISOString(),
      },
      {
        attemptNo: 1, outcome: 'REQUEUED', errorCode: null, errorMessage: null, httpStatus: null, durationMs: null, externalRef: null,
        target: null, actorId: 'u-1', note: 'try now', startedAt: new Date(T0.getTime() + 5_000).toISOString(), finishedAt: new Date(T0.getTime() + 5_000).toISOString(),
      },
    ]);
  });

  it('shows the final SENT state with the external reference', async () => {
    const [{ eventId }] = await seed(1);
    await settle(SENT);
    const res = await GET(`${BASE}/${eventId}`);
    expect(res.body).toMatchObject({ status: 'SENT', externalRef: 'MOCK-1', target: 'mock', sentAt: T0.toISOString() });
    expect((res.body.deliveries as unknown[]).length).toBe(1);
  });

  it('answers 404 for an unknown entry', async () => {
    const res = await GET(`${BASE}/00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: 'ERP үйл явдал олдсонгүй: 00000000-0000-4000-8000-000000000000' });
  });
});

describe('POST /erp-sync/events/:id/requeue', () => {
  it('moves a DEAD entry back to PENDING with a reset attempt counter and records the actor and note', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    clock.set(new Date(T0.getTime() + 60_000));

    const res = await POST(`${BASE}/${eventId}/requeue`, { note: '  endpoint fixed  ' }, { ...ADMIN, 'x-user-id': 'admin-7' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: eventId, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(T0.getTime() + 60_000).toISOString(), lockedBy: null, lockedUntil: null,
    });
    expect(res.body).not.toHaveProperty('contentHash');
    const detail = await repo.getById(eventId);
    expect(detail!.deliveries.at(-1)).toMatchObject({ outcome: 'REQUEUED', actorId: 'admin-7', note: 'endpoint fixed' });
  });

  it('accepts an empty body and records a null note', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    const res = await POST(`${BASE}/${eventId}/requeue`);
    expect(res.status).toBe(201);
    const detail = await repo.getById(eventId);
    expect(detail!.deliveries.at(-1)).toMatchObject({ outcome: 'REQUEUED', actorId: 'admin-1', note: null });
  });

  it('answers 401 when the gateway did not pass X-User-Id, because a manual action must name who did it', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    const res = await POST(`${BASE}/${eventId}/requeue`, {}, { 'x-roles': 'ADMIN' });
    expect(res.status).toBe(401);
    expect(await statusOf(eventId)).toBe('DEAD');
  });

  it('answers 409 for an entry that is being sent right now', async () => {
    const [{ eventId }] = await seed(1);
    await repo.claimNext({ now: clock.now(), leaseMs: 60_000, workerId: 'w' });
    const res = await POST(`${BASE}/${eventId}/requeue`, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ERP_EVENT_STATE_CONFLICT' });
    expect(String(res.body.message)).toContain('ERP event is being sent right now');
  });

  it('makes a pending entry due immediately without touching its attempts', async () => {
    const [{ eventId }] = await seed(1);
    await settle(RETRY(new Date(T0.getTime() + 3_600_000)));
    clock.set(new Date(T0.getTime() + 1_000));

    const res = await POST(`${BASE}/${eventId}/requeue`, {}, ADMIN);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', attempts: 1, nextAttemptAt: new Date(T0.getTime() + 1_000).toISOString() });
  });

  it('makes the requeued entry claimable again', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    expect(await repo.claimNext({ now: clock.now(), leaseMs: 1_000, workerId: 'w' })).toBeNull();
    await POST(`${BASE}/${eventId}/requeue`);
    expect((await repo.claimNext({ now: clock.now(), leaseMs: 1_000, workerId: 'w' }))?.id).toBe(eventId);
  });

  it.each([['SENT'], ['CANCELLED']])('answers 409 for a %s entry and leaves it unchanged', async (state) => {
    const [{ eventId }] = await seed(1);
    if (state === 'SENT') await settle(SENT);
    else await POST(`${BASE}/${eventId}/cancel`, { note: 'closed by hand' });
    const before = await repo.getById(eventId);

    const res = await POST(`${BASE}/${eventId}/requeue`, { note: 'again' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ERP_EVENT_STATE_CONFLICT' });
    expect(String(res.body.message)).toContain(`cannot requeue a ${state} ERP event`);
    expect(await repo.getById(eventId)).toEqual(before);
  });

  it('answers 404 for an unknown entry', async () => {
    const res = await POST(`${BASE}/${MISSING}/requeue`, {});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: `ERP үйл явдал олдсонгүй: ${MISSING}` });
  });

  it.each([
    ['a note over 500 characters', { note: 'x'.repeat(501) }],
    ['a numeric note', { note: 123 }],
    ['a null note', { note: null }],
  ])('answers 400 for %s', async (_name, body) => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    const res = await POST(`${BASE}/${eventId}/requeue`, body);
    expect(res.status).toBe(400);
    expect(hasField(res, 'note')).toBe(true);
    expect(await statusOf(eventId)).toBe('DEAD');
  });

  it('accepts a note of exactly 500 characters', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    expect((await POST(`${BASE}/${eventId}/requeue`, { note: 'x'.repeat(500) })).status).toBe(201);
  });

  it('answers 500 for an unexpected repository failure instead of mapping it to a client error', async () => {
    await seed(1);
    const [id] = await settle(DEAD);
    vi.spyOn(repo, 'requeue').mockRejectedValueOnce(new Error('connection lost'));
    const res = await POST(`${BASE}/${id}/requeue`, {});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL' });
    expect(res.text).not.toContain('connection lost');
  });
});

describe('POST /erp-sync/events/:id/cancel', () => {
  it('cancels a DEAD entry, storing the trimmed note and the actor', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);

    const res = await POST(`${BASE}/${eventId}/cancel`, { note: '  booked manually in ERP  ' }, { ...ADMIN, 'x-user-id': 'admin-3' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: eventId, status: 'CANCELLED', resolutionNote: 'booked manually in ERP', lockedBy: null });
    const detail = await repo.getById(eventId);
    expect(detail!.deliveries.at(-1)).toMatchObject({ outcome: 'CANCELLED', actorId: 'admin-3', note: 'booked manually in ERP' });
  });

  it('cancels a PENDING entry', async () => {
    const [{ eventId }] = await seed(1);
    const res = await POST(`${BASE}/${eventId}/cancel`, { note: 'duplicate of a manual posting' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'CANCELLED', attempts: 0 });
    expect((await repo.claimNext({ now: clock.now(), leaseMs: 1_000, workerId: 'w' }))).toBeNull();
  });

  it('answers 401 without X-User-Id and leaves the entry untouched', async () => {
    const [{ eventId }] = await seed(1);
    const res = await POST(`${BASE}/${eventId}/cancel`, { note: 'no actor header' }, { 'x-roles': 'ADMIN' });
    expect(res.status).toBe(401);
    expect(await statusOf(eventId)).toBe('PENDING');
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a note of two characters', { note: 'ab' }],
    ['a note that is only whitespace', { note: '     ' }],
    ['a note that is two characters after trimming', { note: '  ab  ' }],
    ['a note over 500 characters', { note: 'x'.repeat(501) }],
    ['a numeric note', { note: 12345 }],
  ])('answers 400 for %s and leaves the entry untouched', async (_name, body) => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    const res = await POST(`${BASE}/${eventId}/cancel`, body);
    expect(res.status).toBe(400);
    expect(hasField(res, 'note')).toBe(true);
    expect(await statusOf(eventId)).toBe('DEAD');
  });

  it('accepts a note of exactly three characters', async () => {
    const [{ eventId }] = await seed(1);
    expect((await POST(`${BASE}/${eventId}/cancel`, { note: 'abc' })).status).toBe(201);
  });

  it.each([['SENT'], ['CANCELLED']])('answers 409 for a %s entry and leaves it unchanged', async (state) => {
    const [{ eventId }] = await seed(1);
    if (state === 'SENT') await settle(SENT);
    else await POST(`${BASE}/${eventId}/cancel`, { note: 'first cancel' });
    const before = await repo.getById(eventId);

    const res = await POST(`${BASE}/${eventId}/cancel`, { note: 'second cancel' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ERP_EVENT_STATE_CONFLICT' });
    expect(String(res.body.message)).toContain(`cannot cancel a ${state} ERP event`);
    expect(await repo.getById(eventId)).toEqual(before);
  });

  it('answers 409 while a worker is sending the entry', async () => {
    const [{ eventId }] = await seed(1);
    await repo.claimNext({ now: clock.now(), leaseMs: 60_000, workerId: 'busy-worker' });
    const res = await POST(`${BASE}/${eventId}/cancel`, { note: 'try to cancel' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ERP_EVENT_STATE_CONFLICT' });
    expect(String(res.body.message)).toContain('ERP event is being sent right now');
    expect(await statusOf(eventId)).toBe('PENDING');
  });

  it('answers 404 for an unknown entry', async () => {
    const res = await POST(`${BASE}/${MISSING}/cancel`, { note: 'does not exist' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: `ERP үйл явдал олдсонгүй: ${MISSING}` });
  });
});

describe('POST /erp-sync/events/dispatch', () => {
  it('runs one relay tick and returns its summary', async () => {
    const summary: TickSummary = { claimed: 3, sent: 2, duplicates: 1, retried: 0, dead: 0, lostLease: 0, aborted: false, cooldown: false };
    tick.mockResolvedValueOnce(summary);
    const res = await POST(`${BASE}/dispatch`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual(summary);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('triggers a new tick on every call', async () => {
    await POST(`${BASE}/dispatch`);
    await POST(`${BASE}/dispatch`);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('is not captured by the :id routes and does not run on reads', async () => {
    await GET(BASE);
    await GET(`${BASE}/stats`);
    expect(tick).not.toHaveBeenCalled();
    await POST(`${BASE}/dispatch`);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when the relay tick fails', async () => {
    tick.mockRejectedValueOnce(new Error('db down'));
    expect((await POST(`${BASE}/dispatch`)).status).toBe(500);
  });
});

describe('input hardening', () => {
  it.each([['not-a-uuid'], ['123'], ['..%2F..%2Fetc']])('answers 400 for the malformed id %j on every :id route', async (id) => {
    expect((await GET(`${BASE}/${id}`)).status).toBe(400);
    expect((await POST(`${BASE}/${id}/requeue`, {})).status).toBe(400);
    expect((await POST(`${BASE}/${id}/cancel`, { note: 'closing it' })).status).toBe(400);
  });

  it.each([['abc'], ['-1'], ['1.5'], ['1'.repeat(19)]])('answers 400 for the cursor %j instead of failing in the database', async (cursor) => {
    const res = await GET(`${BASE}?cursor=${cursor}`);
    expect(res.status).toBe(400);
    expect(hasField(res, 'cursor')).toBe(true);
  });

  it('answers 401 for dispatch without X-User-Id and does not tick', async () => {
    expect((await POST(`${BASE}/dispatch`, undefined, { 'x-roles': 'ADMIN' })).status).toBe(401);
    expect(tick).not.toHaveBeenCalled();
  });

  it('rejects an over-long X-User-Id', async () => {
    const [{ eventId }] = await seed(1);
    await settle(DEAD);
    expect((await POST(`${BASE}/${eventId}/requeue`, {}, { 'x-roles': 'ADMIN', 'x-user-id': 'u'.repeat(65) })).status).toBe(401);
  });
});

describe('GET /erp-sync/events?errorCode=', () => {
  it('filters by the last error code', async () => {
    await seed(3);
    const [rejected, timeout] = await settle(DEAD, { ...DEAD, errorCode: 'MAX_ATTEMPTS' });
    expect(items(await GET(`${BASE}?errorCode=REJECTED`)).map((i) => i.id)).toEqual([rejected]);
    expect(items(await GET(`${BASE}?errorCode=MAX_ATTEMPTS`)).map((i) => i.id)).toEqual([timeout]);
    expect(items(await GET(`${BASE}?errorCode=NOPE`))).toEqual([]);
    expect(items(await GET(`${BASE}?status=DEAD`))).toHaveLength(2);
  });
});

describe('POST /erp-sync/events/:id/requeue — no amendments', () => {
  it('ignores amendment fields: the stored event never changes on requeue', async () => {
    const [{ eventId }] = await seed(1);
    await settle({ ...DEAD, errorMessage: 'period 2026-10 is closed' });
    const before = (await repo.getById(eventId))!;

    const res = await POST(`${BASE}/${eventId}/requeue`, { businessDate: '2026-11-02', refreshAccounts: true, note: 'retry' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', attempts: 0, businessDate: '2026-10-28' });
    const after = (await repo.getById(eventId))!;
    expect([after.data, after.amount, after.businessDate]).toEqual([before.data, before.amount, before.businessDate]);
  });
});

describe('POST /erp-sync/events/requeue-dead', () => {
  it('requeues every DEAD entry with the given error code and leaves the others', async () => {
    await seed(5);
    const [a, b, c] = await settle(DEAD, { ...DEAD, errorCode: 'MAX_ATTEMPTS' }, DEAD);

    const res = await POST(`${BASE}/requeue-dead`, { errorCode: 'REJECTED', note: 'URL fixed' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ matched: 2, requeued: 2, failed: [] });
    expect(await statusOf(a!)).toBe('PENDING');
    expect(await statusOf(b!)).toBe('DEAD');
    expect(await statusOf(c!)).toBe('PENDING');
    expect((await repo.getById(a!))!.deliveries.at(-1)).toMatchObject({ outcome: 'REQUEUED', actorId: 'admin-1', note: 'URL fixed' });
  });

  it('requeues all DEAD entries when no error code is given, never touching SENT, CANCELLED or PENDING ones', async () => {
    await seed(4);
    const [sent, dead] = await settle(SENT, DEAD);
    const res = await POST(`${BASE}/requeue-dead`, {});
    expect(res.body).toEqual({ matched: 1, requeued: 1, failed: [] });
    expect(await statusOf(sent!)).toBe('SENT');
    expect(await statusOf(dead!)).toBe('PENDING');
  });

  it('honours the limit and pages through more than one repository page', async () => {
    await seed(130);
    await settle(...Array.from({ length: 130 }, () => DEAD));
    const first = await POST(`${BASE}/requeue-dead`, { limit: 120 });
    expect(first.body).toMatchObject({ matched: 120, requeued: 120 });
    const rest = await POST(`${BASE}/requeue-dead`, {});
    expect(rest.body).toMatchObject({ matched: 10, requeued: 10 });
  });

  it('reports the entries that could not be requeued without aborting the rest', async () => {
    await seed(3);
    const [a, b, c] = await settle(DEAD, DEAD, DEAD);
    const original = repo.requeue.bind(repo);
    vi.spyOn(repo, 'requeue').mockImplementation(async (id, ...rest) => {
      if (id === b) throw new Error('changed concurrently');
      return original(id, ...rest);
    });

    const res = await POST(`${BASE}/requeue-dead`, {});

    expect(res.body).toEqual({ matched: 3, requeued: 2, failed: [{ id: b, error: 'changed concurrently' }] });
    expect(await statusOf(a!)).toBe('PENDING');
    expect(await statusOf(c!)).toBe('PENDING');
  });

  it.each([[{ limit: 0 }], [{ limit: 501 }], [{ limit: 1.5 }], [{ note: 'x'.repeat(501) }]])('answers 400 for %j', async (body) => {
    expect((await POST(`${BASE}/requeue-dead`, body)).status).toBe(400);
  });

  it('answers 401 without the gateway identity and 403 for a non-admin', async () => {
    expect((await POST(`${BASE}/requeue-dead`, {}, { 'x-roles': 'ADMIN' })).status).toBe(401);
    expect((await POST(`${BASE}/requeue-dead`, {}, { ...ADMIN, 'x-roles': 'OFFICER' })).status).toBe(403);
  });

  it('is not captured by the :id routes', async () => {
    const res = await POST(`${BASE}/requeue-dead`, {});
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('matched');
  });
});
