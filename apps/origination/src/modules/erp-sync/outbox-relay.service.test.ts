import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ErpEventData, ErpEventType, ErpEventPayload } from '@los/contracts';
import { ERP_GATEWAY, ErpPostError, type ErpGateway, type ErpPostContext, type ErpPostResult } from '../../integrations/erp';
import { ERP_SYNC_CONFIG, type ErpSyncConfig } from './erp-sync.config';
import { Clock } from '@los/nest-common';
import { ERP_EVENT_REPOSITORY, type ErpEventDraft } from './erp-event.repository';
import { OutboxRelayService, RELAY_DEPS, type RelayDeps, type TickSummary } from './outbox-relay.service';
import type { RetryPolicy } from './retry-policy';
import { MemoryErpEventRepository } from './testing/memory-erp-event.repository';

// ---------------------------------------------------------------- fixtures

const T0 = new Date('2026-10-28T09:00:00.000Z');
const LEASE_MS = 60_000;
const BASE_MS = 1_000;

class TestClock implements Clock {
  constructor(private ms: number) {}
  now(): Date { return new Date(this.ms); }
  advance(ms: number): void { this.ms += ms; }
  set(d: Date): void { this.ms = d.getTime(); }
}

type Step =
  | { kind: 'ok'; externalRef?: string | null; duplicate?: boolean }
  | { kind: 'throw'; error: unknown }
  | { kind: 'hang' };

// Scripted ErpGateway. Steps are consumed one per post(); when the script is empty `fallback` applies.
class FakeGateway implements ErpGateway {
  readonly name = 'fake-ERP';
  readonly calls: Array<{ payload: ErpEventPayload; ctx: ErpPostContext }> = [];
  fallback: Step = { kind: 'ok' };
  onPost: (() => void) | null = null; // e.g. advance the clock while the "network call" runs
  yieldTurns = false; // yield to the event loop inside post(), so concurrent workers interleave
  inFlight = 0;
  maxInFlight = 0;
  maxInFlightPerApp = 0;
  private readonly steps: Step[] = [];
  private readonly perApp = new Map<string, number>();
  private readonly hung: Array<() => void> = [];

  constructor(private readonly refPrefix = 'EXT') {}

  script(...steps: Step[]): this { this.steps.push(...steps); return this; }
  releaseHung(): void { this.hung.splice(0).forEach((release) => release()); }
  get keys(): string[] { return this.calls.map((c) => c.payload.idempotencyKey); }
  get ids(): string[] { return this.calls.map((c) => c.payload.eventId); }

  async post(payload: ErpEventPayload, ctx: ErpPostContext): Promise<ErpPostResult> {
    this.calls.push({ payload: structuredClone(payload), ctx: { ...ctx } });
    const step = this.steps.shift() ?? this.fallback;
    const app = payload.applicationId;
    this.inFlight++;
    this.perApp.set(app, (this.perApp.get(app) ?? 0) + 1);
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.maxInFlightPerApp = Math.max(this.maxInFlightPerApp, this.perApp.get(app) ?? 0);
    try {
      this.onPost?.();
      if (this.yieldTurns) await new Promise<void>((resolve) => setImmediate(resolve));
      if (step.kind === 'throw') throw step.error;
      if (step.kind === 'hang') await new Promise<void>((resolve) => this.hung.push(resolve));
      const ok = step.kind === 'ok' ? step : undefined;
      return {
        externalRef: ok?.externalRef === undefined ? `${this.refPrefix}-${payload.idempotencyKey}` : ok.externalRef,
        duplicate: ok?.duplicate ?? false,
      };
    } finally {
      this.inFlight--;
      this.perApp.set(app, (this.perApp.get(app) ?? 1) - 1);
    }
  }
}

const retryable = (code = 'SERVER_ERROR', status = 503, retryAfterMs?: number): Step => ({
  kind: 'throw', error: new ErpPostError(`ERP said ${status}`, 'RETRYABLE', code, status, retryAfterMs),
});
const permanent = (code = 'REJECTED', status = 422): Step => ({ kind: 'throw', error: new ErpPostError(`ERP rejected: ${status}`, 'PERMANENT', code, status) });

const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let counter = 0;

function defaultData(type: ErpEventType, amount = '1000.00'): ErpEventData {
  if (type === 'DISBURSEMENT') return { amount };
  if (type === 'FEE_DEDUCTION') return { fees: [{ kind: 'ORIGINATION', amount }], totalAmount: amount };
  return { receivedAmount: amount, principal: amount, interest: '0.00', penalty: '0.00', fee: '0.00', overpayment: '0.00' };
}

interface EntryOpts { app?: string; type?: ErpEventType; amount?: string; data?: unknown; correlationId?: string; }

async function addEntry(repo: MemoryErpEventRepository, now: Date, o: EntryOpts = {}): Promise<string> {
  const n = ++counter;
  const type = o.type ?? 'REPAYMENT';
  const draft: ErpEventDraft = {
    id: idOf(n), idempotencyKey: `${type}:src-${n}`, contentHash: `hash-${n}`, eventType: type, sourceId: `src-${n}`,
    header: {
      orgId: 'org-1', branchId: 'br-1', applicationId: o.app ?? 'app-1', contractNo: 'C-1', coreLoanId: null, customerId: 'cu-1',
      currency: 'MNT', businessDate: '2026-10-28', actorId: null,
    },
    correlationId: o.correlationId ?? `corr-${n}`, amount: o.amount ?? '1000.00',
    data: ('data' in o ? o.data : defaultData(type, o.amount)) as ErpEventData, now,
  };
  await repo.insert(draft);
  return draft.id;
}

interface SetupOpts {
  relay?: Partial<ErpSyncConfig['relay']>;
  retry?: Partial<RetryPolicy>;
  random?: () => number;
  workerId?: string;
  gateway?: FakeGateway;
  repo?: MemoryErpEventRepository;
  clock?: TestClock;
}

function makeConfig(o: SetupOpts = {}): ErpSyncConfig {
  return {
    relay: { enabled: false, intervalMs: 1_000, batchSize: 20, concurrency: 1, leaseMs: LEASE_MS, abortAfterFailures: 3, cooldownMs: 30_000, ...o.relay },
    retry: { baseDelayMs: BASE_MS, factor: 2, maxDelayMs: 60_000, jitterRatio: 0.2, maxAttempts: 5, ...o.retry },
    mode: 'mock',
    allowDevAccountDefaults: true,
  };
}

function setup(o: SetupOpts = {}) {
  const clock = o.clock ?? new TestClock(T0.getTime());
  const repo = o.repo ?? new MemoryErpEventRepository();
  const gateway = o.gateway ?? new FakeGateway();
  const config = makeConfig(o);
  const relay = new OutboxRelayService(repo, gateway, config, clock, { random: o.random ?? (() => 0.5), workerId: o.workerId ?? 'worker-1' });
  const add = (e?: EntryOpts) => addEntry(repo, clock.now(), e);
  const get = async (id: string) => {
    const e = await repo.getById(id);
    if (!e) throw new Error(`entry ${id} missing`);
    return e;
  };
  return { clock, repo, gateway, config, relay, add, get };
}

const summary = (over: Partial<TickSummary> = {}): TickSummary => ({ claimed: 0, sent: 0, duplicates: 0, retried: 0, dead: 0, lostLease: 0, aborted: false, cooldown: false, ...over });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

// Structured relay logs are captured instead of printed
type LogLine = { level: 'log' | 'warn' | 'error'; payload: Record<string, unknown> };
const logs: LogLine[] = [];
const events = () => logs.map((l) => l.payload.event);

const captureLogs = () => {
  const sink = (level: LogLine['level']) => (message: unknown) => {
    if (message && typeof message === 'object') logs.push({ level, payload: message as Record<string, unknown> });
  };
  Logger.overrideLogger({ log: sink('log'), warn: sink('warn'), error: sink('error') });
};
beforeEach(() => { counter = 0; logs.length = 0; captureLogs(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------- tests

describe('OutboxRelayService.tick: delivery outcomes', () => {
  it('returns an all-zero summary and never calls the gateway when nothing is due', async () => {
    const { relay, gateway } = setup();
    expect(await relay.tick()).toEqual(summary());
    expect(gateway.calls).toHaveLength(0);
    expect(events()).not.toContain('erp.relay.tick');
  });

  it('marks a delivered entry SENT with the external reference and records the attempt', async () => {
    const { relay, gateway, clock, add, get } = setup();
    const id = await add();
    gateway.onPost = () => clock.advance(250);

    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));

    const e = await get(id);
    expect(e.status).toBe('SENT');
    expect(e.externalRef).toBe('EXT-org-1:REPAYMENT:src-1');
    expect(e.sentAt).toEqual(new Date(T0.getTime() + 250));
    expect(e.attempts).toBe(1);
    expect(e.target).toBe('fake-ERP');
    expect(e.lockedBy).toBeNull();
    expect(e.lockedUntil).toBeNull();
    expect(e.lastError).toBeNull();
    expect(e.lastErrorCode).toBeNull();
    expect(e.deliveries).toHaveLength(1);
    expect(e.deliveries[0]).toMatchObject({
      attemptNo: 1, outcome: 'SENT', errorCode: null, errorMessage: null, httpStatus: null, externalRef: 'EXT-org-1:REPAYMENT:src-1',
      target: 'fake-ERP', durationMs: 250, startedAt: T0, finishedAt: new Date(T0.getTime() + 250),
    });
  });

  it('keeps a null external reference when the ERP returns none', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script({ kind: 'ok', externalRef: null });
    const id = await add();
    await relay.tick();
    const e = await get(id);
    expect(e.status).toBe('SENT');
    expect(e.externalRef).toBeNull();
  });

  it('treats duplicate=true as delivered, counts it as a duplicate and records a DUPLICATE attempt', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script({ kind: 'ok', duplicate: true, externalRef: 'ALREADY-1' });
    const id = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, duplicates: 1, sent: 0 }));

    const e = await get(id);
    expect(e.status).toBe('SENT');
    expect(e.externalRef).toBe('ALREADY-1');
    expect(e.deliveries.map((d) => d.outcome)).toEqual(['DUPLICATE']);
  });

  it('schedules a retryable failure at now + backoff and counts the attempt', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script(retryable('SERVER_ERROR', 503));
    const id = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1 }));

    const e = await get(id);
    expect(e.status).toBe('PENDING');
    expect(e.attempts).toBe(1);
    expect(e.nextAttemptAt).toEqual(new Date(T0.getTime() + BASE_MS));
    expect(e.lastErrorCode).toBe('SERVER_ERROR');
    expect(e.lastError).toBe('ERP said 503');
    expect(e.lockedBy).toBeNull();
    expect(e.sentAt).toBeNull();
    expect(e.deliveries).toHaveLength(1);
    expect(e.deliveries[0]).toMatchObject({ attemptNo: 1, outcome: 'RETRY', errorCode: 'SERVER_ERROR', httpStatus: 503, externalRef: null });
  });

  it('does not re-send before nextAttemptAt, then retries with a doubled delay', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.script(retryable(), retryable());
    const id = await add();

    await relay.tick();
    clock.advance(BASE_MS - 1);
    expect(await relay.tick()).toEqual(summary());
    expect(gateway.calls).toHaveLength(1);

    clock.advance(1);
    expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1 }));
    const e = await get(id);
    expect(e.attempts).toBe(2);
    expect(e.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 2 * BASE_MS));

    clock.advance(2 * BASE_MS);
    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    const done = await get(id);
    expect(done.status).toBe('SENT');
    expect(done.attempts).toBe(3);
    expect(done.deliveries.map((d) => [d.attemptNo, d.outcome])).toEqual([[1, 'RETRY'], [2, 'RETRY'], [3, 'SENT']]);
  });

  it('doubles the delay on every attempt until it reaches the cap', async () => {
    const { relay, gateway, clock, add, get } = setup({ retry: { maxAttempts: 100, maxDelayMs: 60_000 } });
    gateway.fallback = retryable();
    const id = await add();
    const seen: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      const before = clock.now().getTime();
      await relay.tick();
      const e = await get(id);
      expect(e.attempts).toBe(attempt);
      seen.push(e.nextAttemptAt.getTime() - before);
      clock.set(e.nextAttemptAt);
    }
    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('applies the injected random source as backoff jitter', async () => {
    const low = setup({ random: () => 0 });
    low.gateway.script(retryable());
    const lowId = await low.add();
    await low.relay.tick();
    expect((await low.get(lowId)).nextAttemptAt).toEqual(new Date(T0.getTime() + 800)); // 1000 * (1 - 0.2)

    const high = setup({ random: () => 1 });
    high.gateway.script(retryable());
    const highId = await high.add();
    await high.relay.tick();
    expect((await high.get(highId)).nextAttemptAt).toEqual(new Date(T0.getTime() + 1_200)); // 1000 * (1 + 0.2)
  });

  it('honours Retry-After when it is larger than the backoff', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script(retryable('THROTTLED', 429, 90_000));
    const id = await add();
    await relay.tick();
    const e = await get(id);
    expect(e.nextAttemptAt).toEqual(new Date(T0.getTime() + 90_000));
    expect(e.lastErrorCode).toBe('THROTTLED');
    expect(e.deliveries[0]).toMatchObject({ outcome: 'RETRY', httpStatus: 429 });
  });

  it('keeps the exponential backoff when Retry-After is smaller', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script(retryable('THROTTLED', 429, 100));
    const id = await add();
    await relay.tick();
    expect((await get(id)).nextAttemptAt).toEqual(new Date(T0.getTime() + BASE_MS));
  });

  it('never schedules the next attempt earlier than Retry-After counted from the moment the response arrived', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.script(retryable('THROTTLED', 429, 60_000));
    gateway.onPost = () => clock.advance(5_000); // the ERP took 5s to answer
    const id = await add();
    await relay.tick();
    const e = await get(id);
    const respondedAt = T0.getTime() + 5_000;
    expect(e.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(respondedAt + 60_000);
  });

  it('moves a permanent failure to DEAD immediately with the ERP error code and status', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.script(permanent('REJECTED', 422));
    const id = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));

    const e = await get(id);
    expect(e.status).toBe('DEAD');
    expect(e.attempts).toBe(1);
    expect(e.lastErrorCode).toBe('REJECTED');
    expect(e.lastError).toBe('ERP rejected: 422');
    expect(e.lockedBy).toBeNull();
    expect(e.deliveries[0]).toMatchObject({ attemptNo: 1, outcome: 'DEAD', errorCode: 'REJECTED', httpStatus: 422 });

    clock.advance(24 * 3_600_000);
    expect(await relay.tick()).toEqual(summary());
    expect(gateway.calls).toHaveLength(1);
  });

  it('dead-letters with MAX_ATTEMPTS when the last allowed attempt fails with a retryable error', async () => {
    const { relay, gateway, clock, add, get } = setup({ retry: { maxAttempts: 3 } });
    gateway.fallback = retryable('SERVER_ERROR', 503);
    const id = await add();

    for (const attempt of [1, 2]) {
      expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1 }));
      const e = await get(id);
      expect(e.status).toBe('PENDING');
      expect(e.attempts).toBe(attempt);
      clock.set(e.nextAttemptAt);
    }
    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));

    const e = await get(id);
    expect(e.status).toBe('DEAD');
    expect(e.attempts).toBe(3);
    expect(e.lastErrorCode).toBe('MAX_ATTEMPTS');
    expect(e.lastError).toBe('SERVER_ERROR: ERP said 503');
    expect(e.deliveries.map((d) => [d.attemptNo, d.outcome])).toEqual([[1, 'RETRY'], [2, 'RETRY'], [3, 'DEAD']]);
    expect(e.deliveries[2]).toMatchObject({ errorCode: 'MAX_ATTEMPTS', httpStatus: 503 });

    clock.advance(24 * 3_600_000);
    expect(await relay.tick()).toEqual(summary());
    expect(gateway.calls).toHaveLength(3);
  });

  it('dead-letters on the first failure when maxAttempts is 1', async () => {
    const { relay, gateway, add, get } = setup({ retry: { maxAttempts: 1 } });
    gateway.script(retryable('NETWORK', 0));
    const id = await add();
    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));
    const e = await get(id);
    expect(e.status).toBe('DEAD');
    expect(e.lastErrorCode).toBe('MAX_ATTEMPTS');
  });

  it('dead-letters an unexpected error that exhausts the attempts as MAX_ATTEMPTS naming UNEXPECTED', async () => {
    const { relay, gateway, add, get } = setup({ retry: { maxAttempts: 1 } });
    gateway.script({ kind: 'throw', error: new Error('socket exploded') });
    const id = await add();
    await relay.tick();
    const e = await get(id);
    expect(e.status).toBe('DEAD');
    expect(e.lastErrorCode).toBe('MAX_ATTEMPTS');
    expect(e.lastError).toBe('UNEXPECTED: socket exploded');
  });

  it('treats a generic Error from the gateway as a retryable UNEXPECTED failure', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script({ kind: 'throw', error: new TypeError('cannot read properties of undefined') });
    const id = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1 }));

    const e = await get(id);
    expect(e.status).toBe('PENDING');
    expect(e.lastErrorCode).toBe('UNEXPECTED');
    expect(e.lastError).toBe('cannot read properties of undefined');
    expect(e.nextAttemptAt).toEqual(new Date(T0.getTime() + BASE_MS));
    expect(e.deliveries[0]).toMatchObject({ outcome: 'RETRY', errorCode: 'UNEXPECTED', httpStatus: null });
  });

  it('treats a thrown non-Error value as a retryable UNEXPECTED failure', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script({ kind: 'throw', error: 'boom' });
    const id = await add();
    await relay.tick();
    const e = await get(id);
    expect(e.status).toBe('PENDING');
    expect(e.lastErrorCode).toBe('UNEXPECTED');
    expect(e.lastError).toBe('boom');
  });

  it('truncates very long error messages to 500 characters plus an ellipsis', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script({ kind: 'throw', error: new ErpPostError('x'.repeat(2_000), 'RETRYABLE', 'SERVER_ERROR', 502) });
    const id = await add();
    await relay.tick();
    const e = await get(id);
    expect(e.lastError).toBe(`${'x'.repeat(500)}…`);
  });

  it('clears the previous error when a later attempt succeeds', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.script(retryable());
    const id = await add();
    await relay.tick();
    expect((await get(id)).lastErrorCode).toBe('SERVER_ERROR');
    clock.advance(BASE_MS);
    await relay.tick();
    const e = await get(id);
    expect(e.status).toBe('SENT');
    expect(e.lastError).toBeNull();
    expect(e.lastErrorCode).toBeNull();
  });
});

describe('OutboxRelayService.tick: invalid stored events', () => {
  const repayment = (over: Record<string, unknown> = {}) => ({ ...(defaultData('REPAYMENT') as object), ...over });
  const mismatched = () => repayment({ overpayment: '5.00' });

  const cases: Array<[string, () => unknown]> = [
    ['an allocation that does not add up', mismatched],
    ['a missing repayment part', () => { const { fee: _fee, ...rest } = repayment() as Record<string, unknown>; return rest; }],
    ['a negative amount', () => repayment({ principal: '-5.00' })],
    ['a non-canonical amount', () => repayment({ principal: '1000' })],
    ['data of another event type', () => ({ amount: '1000.00' })],
    ['no data at all', () => null],
  ];

  it.each(cases)('dead-letters %s as INVALID_PAYLOAD without calling the gateway', async (_name, make) => {
    const { relay, gateway, add, get } = setup();
    const id = await add({ data: make() });

    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));

    expect(gateway.calls).toHaveLength(0);
    const e = await get(id);
    expect(e.status).toBe('DEAD');
    expect(e.attempts).toBe(1);
    expect(e.lastErrorCode).toBe('INVALID_PAYLOAD');
    expect(e.deliveries[0]).toMatchObject({ attemptNo: 1, outcome: 'DEAD', errorCode: 'INVALID_PAYLOAD', externalRef: null });
  });

  it('explains an inconsistent allocation in the stored error', async () => {
    const { relay, add, get } = setup();
    const id = await add({ data: mismatched() });
    await relay.tick();
    expect((await get(id)).lastError).toContain('allocation does not equal receivedAmount');
  });

  it('lets later entries of other applications through after one invalid entry', async () => {
    const { relay, gateway, add, get } = setup();
    const bad = await add({ app: 'app-1', data: mismatched() });
    const good = await add({ app: 'app-2' });
    expect(await relay.tick()).toEqual(summary({ claimed: 2, dead: 1, sent: 1 }));
    expect((await get(bad)).status).toBe('DEAD');
    expect((await get(good)).status).toBe('SENT');
    expect(gateway.ids).toEqual([good]);
  });
});

describe('OutboxRelayService.tick: what the gateway receives', () => {
  it('posts the business event with its data, idempotency key, correlation id and attempt number', async () => {
    const { relay, gateway, add } = setup();
    const id = await add({
      correlationId: 'corr-xyz',
      data: { receivedAmount: '1500.00', principal: '1000.00', interest: '500.00', penalty: '0.00', fee: '0.00', overpayment: '0.00' },
      amount: '1500.00',
    });
    await relay.tick();

    expect(gateway.calls).toHaveLength(1);
    const { payload, ctx } = gateway.calls[0]!;
    expect(payload).toEqual({
      schemaVersion: 1, eventId: id, idempotencyKey: 'org-1:REPAYMENT:src-1', eventType: 'REPAYMENT',
      orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'C-1', coreLoanId: null, customerId: 'cu-1',
      businessDate: '2026-10-28', currency: 'MNT',
      data: { receivedAmount: '1500.00', principal: '1000.00', interest: '500.00', penalty: '0.00', fee: '0.00', overpayment: '0.00' },
      correlationId: 'corr-xyz', createdAt: T0.toISOString(),
    });
    // LOS never sends ledger concepts: the ERP builds the journal itself
    expect(payload).not.toHaveProperty('lines');
    expect(payload).not.toHaveProperty('totals');
    expect(ctx).toEqual({ correlationId: 'corr-xyz', attemptNo: 1 });
  });

  it('sends an identical payload on every attempt and increments the attempt number', async () => {
    const { relay, gateway, clock, add } = setup();
    gateway.script(retryable(), retryable());
    await add();
    await relay.tick();
    clock.advance(BASE_MS);
    await relay.tick();
    clock.advance(2 * BASE_MS);
    await relay.tick();

    expect(gateway.calls).toHaveLength(3);
    expect(gateway.calls.map((c) => c.ctx.attemptNo)).toEqual([1, 2, 3]);
    expect(gateway.calls[1]!.payload).toEqual(gateway.calls[0]!.payload);
    expect(gateway.calls[2]!.payload).toEqual(gateway.calls[0]!.payload);
    expect(new Set(gateway.calls.map((c) => c.ctx.correlationId))).toEqual(new Set(['corr-1']));
  });

  it('records the gateway name as the delivery target', async () => {
    const { relay, add, get } = setup();
    const id = await add();
    await relay.tick();
    const e = await get(id);
    expect(e.target).toBe('fake-ERP');
    expect(e.deliveries[0]!.target).toBe('fake-ERP');
  });
});

describe('OutboxRelayService.tick: per-application FIFO', () => {
  it('sends the entries of one application in seq order', async () => {
    const { relay, gateway, add, get } = setup();
    const [a, b, c] = [await add(), await add({ type: 'FEE_DEDUCTION' }), await add({ type: 'DISBURSEMENT' })];

    expect(await relay.tick()).toEqual(summary({ claimed: 3, sent: 3 }));

    expect(gateway.ids).toEqual([a, b, c]);
    for (const id of [a, b, c]) expect((await get(id)).status).toBe('SENT');
  });

  it('does not send the second entry while the first waits for a retry, then sends both in order', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.script(retryable());
    const first = await add();
    const second = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1 }));
    expect(gateway.ids).toEqual([first]);
    const untouched = await get(second);
    expect(untouched.status).toBe('PENDING');
    expect(untouched.attempts).toBe(0);
    expect(untouched.deliveries).toHaveLength(0);

    clock.advance(BASE_MS);
    expect(await relay.tick()).toEqual(summary({ claimed: 2, sent: 2 }));
    expect(gateway.ids).toEqual([first, first, second]);
  });

  it('blocks the second entry after the first goes DEAD, for any number of ticks', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.script(permanent());
    const first = await add();
    const second = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));
    for (let i = 0; i < 3; i++) {
      clock.advance(3_600_000);
      expect(await relay.tick()).toEqual(summary());
    }
    expect(gateway.ids).toEqual([first]);
    const blocked = await get(second);
    expect(blocked.status).toBe('PENDING');
    expect(blocked.attempts).toBe(0);
  });

  it('does not block entries of other applications behind a DEAD entry', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script(permanent());
    const a1 = await add({ app: 'app-A' });
    const a2 = await add({ app: 'app-A' });
    const b1 = await add({ app: 'app-B' });

    expect(await relay.tick()).toEqual(summary({ claimed: 2, dead: 1, sent: 1 }));
    expect((await get(a1)).status).toBe('DEAD');
    expect((await get(a2)).attempts).toBe(0);
    expect((await get(b1)).status).toBe('SENT');
  });

  it('lets the second entry proceed in a later tick once the first is requeued and SENT', async () => {
    const { relay, repo, gateway, clock, add, get } = setup({ relay: { batchSize: 1 } });
    gateway.script(permanent());
    const first = await add();
    const second = await add();

    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));
    expect(await relay.tick()).toEqual(summary());

    await repo.requeue(first, 'admin-1', 'fixed the account map', clock.now());
    expect((await get(first)).status).toBe('PENDING');
    expect((await get(first)).attempts).toBe(0);

    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    expect((await get(first)).status).toBe('SENT');
    expect((await get(second)).attempts).toBe(0);

    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    expect((await get(second)).status).toBe('SENT');
    expect(gateway.ids).toEqual([first, first, second]);
  });

  it('lets the second entry proceed once the dead first entry is cancelled', async () => {
    const { relay, repo, gateway, clock, add, get } = setup();
    gateway.script(permanent());
    const first = await add();
    const second = await add();
    await relay.tick();
    expect((await get(second)).attempts).toBe(0);

    await repo.cancel(first, 'admin-1', 'handled manually in the ERP', clock.now());
    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    expect((await get(first)).status).toBe('CANCELLED');
    expect((await get(second)).status).toBe('SENT');
  });
});

describe('OutboxRelayService.tick: abort, batch and concurrency', () => {
  it('aborts after abortAfterFailures consecutive retryable failures and leaves the rest untouched', async () => {
    const { relay, gateway, add, get } = setup({ relay: { abortAfterFailures: 2 } });
    gateway.fallback = retryable();
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await add({ app: `app-${i}` }));

    expect(await relay.tick()).toEqual(summary({ claimed: 2, retried: 2, aborted: true }));

    expect(gateway.ids).toEqual([ids[0], ids[1]]);
    for (const id of ids.slice(2)) {
      const e = await get(id);
      expect(e.status).toBe('PENDING');
      expect(e.attempts).toBe(0);
      expect(e.lockedBy).toBeNull();
      expect(e.lockedUntil).toBeNull();
      expect(e.deliveries).toHaveLength(0);
    }
  });

  it('pauses the whole relay for the cooldown after an aborted tick, then starts with a fresh failure count', async () => {
    const { relay, gateway, clock, add, get } = setup({ relay: { abortAfterFailures: 2, cooldownMs: 30_000 } });
    gateway.script(retryable(), retryable());
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) ids.push(await add({ app: `app-${i}` }));

    expect(await relay.tick()).toEqual(summary({ claimed: 2, retried: 2, aborted: true }));
    expect(relay.status().cooldownUntil).toBe(new Date(clock.now().getTime() + 30_000).toISOString());

    // during the cooldown nothing is claimed, so an outage cannot burn the attempt counters of the other entries
    expect(await relay.tick()).toEqual(summary({ cooldown: true }));
    clock.advance(29_999);
    expect(await relay.tick()).toEqual(summary({ cooldown: true }));
    expect(gateway.calls).toHaveLength(2);
    for (const id of ids.slice(2)) expect((await get(id)).attempts).toBe(0);

    clock.advance(1); // the gateway recovered
    expect(relay.status().cooldownUntil).toBeNull();
    expect(await relay.tick()).toEqual(summary({ claimed: 4, sent: 4 }));
    expect((await get(ids[0]!)).attempts).toBe(2);
    expect((await get(ids[3]!)).status).toBe('SENT');
  });

  it('does not start a cooldown when the tick stops for another reason than consecutive gateway failures', async () => {
    const { relay, repo, add } = setup({ relay: { abortAfterFailures: 2 } });
    await add();
    vi.spyOn(repo, 'complete').mockRejectedValue(new Error('connection terminated'));
    expect(await relay.tick()).toMatchObject({ aborted: true, cooldown: false });
    expect(relay.status().cooldownUntil).toBeNull();
  });

  it('does not abort when a success interrupts the failures', async () => {
    const { relay, gateway, add } = setup({ relay: { abortAfterFailures: 2 } });
    gateway.script(retryable(), { kind: 'ok' }, retryable(), { kind: 'ok' }, retryable(), { kind: 'ok' });
    for (let i = 1; i <= 6; i++) await add({ app: `app-${i}` });
    expect(await relay.tick()).toEqual(summary({ claimed: 6, sent: 3, retried: 3, aborted: false }));
  });

  it('aborts on the very first retryable failure when abortAfterFailures is 1', async () => {
    const { relay, gateway, add } = setup({ relay: { abortAfterFailures: 1 } });
    gateway.fallback = retryable();
    await add({ app: 'app-1' });
    await add({ app: 'app-2' });
    expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1, aborted: true }));
    expect(gateway.calls).toHaveLength(1);
  });

  it('never claims more than batchSize entries per tick', async () => {
    const { relay, gateway, add } = setup({ relay: { batchSize: 3 } });
    for (let i = 1; i <= 5; i++) await add({ app: `app-${i}` });

    expect(await relay.tick()).toEqual(summary({ claimed: 3, sent: 3 }));
    expect(gateway.calls).toHaveLength(3);
    expect(await relay.tick()).toEqual(summary({ claimed: 2, sent: 2 }));
    expect(await relay.tick()).toEqual(summary());
  });

  it('shares the batch budget between concurrent workers', async () => {
    const { relay, gateway, add } = setup({ relay: { batchSize: 3, concurrency: 4 } });
    gateway.yieldTurns = true;
    for (let i = 1; i <= 10; i++) await add({ app: `app-${i}` });
    expect(await relay.tick()).toEqual(summary({ claimed: 3, sent: 3 }));
    expect(gateway.calls).toHaveLength(3);
  });

  it('runs entries of different applications in parallel but never two of the same application', async () => {
    const { relay, gateway, add, get } = setup({ relay: { concurrency: 4, batchSize: 50 } });
    gateway.yieldTurns = true;
    const ids: Record<string, string[]> = { A: [], B: [], C: [], D: [] };
    for (let round = 0; round < 3; round++) for (const app of Object.keys(ids)) ids[app]!.push(await add({ app }));

    expect(await relay.tick()).toEqual(summary({ claimed: 12, sent: 12 }));

    expect(gateway.maxInFlightPerApp).toBe(1);
    expect(gateway.maxInFlight).toBeGreaterThan(1);
    expect(new Set(gateway.ids).size).toBe(12);
    for (const list of Object.values(ids)) {
      const order = gateway.ids.filter((id) => list.includes(id));
      expect(order).toEqual(list);
      for (const id of list) expect((await get(id)).status).toBe('SENT');
    }
  });

  it('keeps one application strictly sequential even when many workers are idle', async () => {
    const { relay, gateway, add } = setup({ relay: { concurrency: 8 } });
    gateway.yieldTurns = true;
    const ids = [await add(), await add(), await add(), await add()];
    expect(await relay.tick()).toEqual(summary({ claimed: 4, sent: 4 }));
    expect(gateway.ids).toEqual(ids);
    expect(gateway.maxInFlight).toBe(1);
  });

  it('never double-sends when two relay instances tick concurrently on the same outbox', async () => {
    const repo = new MemoryErpEventRepository();
    const gateway = new FakeGateway();
    gateway.yieldTurns = true;
    const clock = new TestClock(T0.getTime());
    const one = setup({ repo, gateway, clock, workerId: 'worker-1', relay: { concurrency: 3 } });
    const two = setup({ repo, gateway, clock, workerId: 'worker-2', relay: { concurrency: 3 } });
    for (let round = 0; round < 3; round++) for (const app of ['A', 'B', 'C', 'D', 'E']) await one.add({ app });

    const [s1, s2] = await Promise.all([one.relay.tick(), two.relay.tick()]);

    expect(s1.claimed + s2.claimed).toBe(15);
    expect(s1.sent + s2.sent).toBe(15);
    expect(s1.lostLease + s2.lostLease).toBe(0);
    expect(gateway.calls).toHaveLength(15);
    expect(new Set(gateway.keys).size).toBe(15);
    expect(gateway.maxInFlightPerApp).toBe(1);
    const stats = await repo.stats();
    expect(stats.counts).toEqual({ PENDING: 0, SENT: 15, DEAD: 0, CANCELLED: 0 });
  });
});

describe('OutboxRelayService.tick: leases', () => {
  it('takes a lease for the configured duration under its worker id', async () => {
    const { relay, gateway, add, get } = setup({ workerId: 'w-lease' });
    gateway.script({ kind: 'hang' });
    const id = await add();
    const tick = relay.tick();
    await flush();

    const e = await get(id);
    expect(e.attempts).toBe(1);
    expect(e.lockedBy).toBe('w-lease');
    expect(e.lockedUntil).toEqual(new Date(T0.getTime() + LEASE_MS));

    gateway.releaseHung();
    await tick;
  });

  it('re-claims an entry whose worker never completed once the lease has expired, and attempts keep counting', async () => {
    const repo = new MemoryErpEventRepository();
    const clock = new TestClock(T0.getTime());
    const crashed = new FakeGateway('LATE');
    crashed.script({ kind: 'hang' });
    const a = setup({ repo, clock, gateway: crashed, workerId: 'worker-A' });
    const b = setup({ repo, clock, workerId: 'worker-B' });
    const id = await a.add();

    const tickA = a.relay.tick();
    await flush();
    expect((await a.get(id)).lockedBy).toBe('worker-A');

    clock.advance(LEASE_MS - 1);
    expect(await b.relay.tick()).toEqual(summary());
    expect(b.gateway.calls).toHaveLength(0);

    clock.advance(2);
    expect(await b.relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    const e = await b.get(id);
    expect(e.status).toBe('SENT');
    expect(e.attempts).toBe(2);
    expect(e.externalRef).toBe('EXT-org-1:REPAYMENT:src-1');
    expect(b.gateway.calls[0]!.ctx.attemptNo).toBe(2);
    expect(e.deliveries.map((d) => [d.attemptNo, d.outcome])).toEqual([[2, 'SENT']]);

    // the slow worker finally answers: its result must not overwrite anything
    crashed.releaseHung();
    expect(await tickA).toEqual(summary({ claimed: 1, lostLease: 1 }));
    const after = await b.get(id);
    expect(after.status).toBe('SENT');
    expect(after.externalRef).toBe('EXT-org-1:REPAYMENT:src-1');
    expect(after.deliveries).toHaveLength(1);
  });

  it('counts lease-expired claims towards maxAttempts', async () => {
    const { relay, repo, gateway, clock, add, get } = setup({ retry: { maxAttempts: 3 } });
    const id = await add();
    // two workers claim and crash without completing
    for (const worker of ['dead-1', 'dead-2']) {
      expect(await repo.claimNext({ now: clock.now(), leaseMs: LEASE_MS, workerId: worker })).not.toBeNull();
      clock.advance(LEASE_MS + 1);
    }
    expect((await get(id)).attempts).toBe(2);

    gateway.script(retryable());
    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));
    const e = await get(id);
    expect(e.attempts).toBe(3);
    expect(e.status).toBe('DEAD');
    expect(e.lastErrorCode).toBe('MAX_ATTEMPTS');
  });

  it('reports a lost lease without changing the entry state', async () => {
    const { relay, repo, gateway, add, get } = setup();
    const id = await add();
    vi.spyOn(repo, 'complete').mockResolvedValueOnce(false);

    expect(await relay.tick()).toEqual(summary({ claimed: 1, lostLease: 1 }));

    expect(gateway.calls).toHaveLength(1);
    const e = await get(id);
    expect(e.status).toBe('PENDING'); // nothing was recorded by this worker
    expect(e.externalRef).toBeNull();
    expect(e.deliveries).toHaveLength(0);
    expect(events()).toContain('erp.relay.lease_lost');
    expect(events()).not.toContain('erp.sent');
  });

  it('does not count a lost-lease retryable failure towards the abort threshold', async () => {
    const { relay, repo, gateway, add } = setup({ relay: { abortAfterFailures: 1 } });
    gateway.script(retryable());
    await add({ app: 'app-1' });
    await add({ app: 'app-2' });
    vi.spyOn(repo, 'complete').mockResolvedValueOnce(false);

    expect(await relay.tick()).toEqual(summary({ claimed: 2, lostLease: 1, sent: 1, aborted: false }));
  });

  it('aborts the tick without crashing when complete() throws, and the entry is retried after the lease expires', async () => {
    const { relay, repo, gateway, clock, add, get } = setup();
    const first = await add({ app: 'app-1' });
    const second = await add({ app: 'app-2' });
    vi.spyOn(repo, 'complete').mockRejectedValueOnce(new Error('connection terminated')).mockRejectedValueOnce(new Error('connection terminated'));

    expect(await relay.tick()).toEqual(summary({ claimed: 1, aborted: true }));

    expect(gateway.ids).toEqual([first]);
    const e = await get(first);
    expect(e.status).toBe('PENDING');
    expect(e.attempts).toBe(1);
    expect(e.lockedBy).toBe('worker-1');
    expect((await get(second)).attempts).toBe(0);
    expect(events()).toContain('erp.relay.complete_failed');

    // lease still active: the next tick only picks up the untouched entry
    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    expect((await get(second)).status).toBe('SENT');

    clock.advance(LEASE_MS + 1);
    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    const recovered = await get(first);
    expect(recovered.status).toBe('SENT');
    expect(recovered.attempts).toBe(2);
    expect(gateway.ids).toEqual([first, second, first]); // at-least-once: same idempotency key is sent twice
    expect(gateway.keys[2]).toBe(gateway.keys[0]);
  });
});

describe('OutboxRelayService.tick: recording the outcome', () => {
  it('retries the completion with a minimal record when the first write is refused, so a delivered entry is not sent again', async () => {
    const { relay, repo, add, get } = setup();
    const id = await add();
    const complete = vi.spyOn(repo, 'complete');
    complete.mockRejectedValueOnce(new Error('invalid byte sequence for encoding "UTF8"'));

    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0].completion).toEqual({ outcome: 'SENT', externalRef: null, duplicate: false });
    expect((await get(id)).status).toBe('SENT');
    expect(events()).toContain('erp.relay.complete_retry_minimal');
  });

  it('drops only the error text of a refused RETRY completion and keeps the schedule', async () => {
    const { relay, repo, gateway, add, get } = setup();
    gateway.script(retryable('NETWORK'));
    const id = await add();
    vi.spyOn(repo, 'complete').mockRejectedValueOnce(new Error('value too long'));

    expect(await relay.tick()).toEqual(summary({ claimed: 1, retried: 1 }));
    const e = await get(id);
    expect(e.status).toBe('PENDING');
    expect(e.lastErrorCode).toBe('NETWORK');
    expect(e.lastError).toBe('delivery failed (message dropped)');
  });

  it('computes the backoff from the time the response arrived, not from when the request started', async () => {
    const { relay, gateway, clock, add, get } = setup();
    gateway.onPost = () => clock.advance(20_000); // a slow network call
    gateway.script(retryable('TIMEOUT'));
    const id = await add();
    const started = clock.now().getTime();

    await relay.tick();
    expect((await get(id)).nextAttemptAt.getTime()).toBe(started + 20_000 + BASE_MS);
  });

  it('dead-letters an entry whose payload cannot be built as INVALID_PAYLOAD without calling the gateway', async () => {
    const { relay, gateway, add, get } = setup();
    const id = await add({ data: { receivedAmount: '10.00', principal: '9.00', interest: '0.00', penalty: '0.00', fee: '0.00', overpayment: '0.00' } });

    expect(await relay.tick()).toEqual(summary({ claimed: 1, dead: 1 }));
    expect(gateway.calls).toHaveLength(0);
    const e = await get(id);
    expect([e.status, e.lastErrorCode]).toEqual(['DEAD', 'INVALID_PAYLOAD']);
  });

  it('classifies a non-validation bug while building the payload as INVALID_PAYLOAD too (it will not fix itself)', async () => {
    const { relay, repo, add, get } = setup();
    const id = await add();
    const original = repo.claimNext.bind(repo);
    vi.spyOn(repo, 'claimNext').mockImplementationOnce(async (args) => {
      const e = await original(args);
      return e && ({ ...e, createdAt: null } as never); // a corrupt row: building the payload throws a TypeError
    });
    await relay.tick();
    expect((await get(id)).lastErrorCode).toBe('INVALID_PAYLOAD');
  });
});

describe('OutboxRelayService.tick: in-flight sharing and failures', () => {
  it('returns the same in-flight promise to overlapping callers and starts a new one afterwards', async () => {
    const { relay, gateway, add } = setup();
    gateway.script({ kind: 'hang' });
    await add();

    const p1 = relay.tick();
    const p2 = relay.tick();
    expect(p2).toBe(p1);
    await flush();
    expect(relay.tick()).toBe(p1);
    expect(gateway.calls).toHaveLength(1);

    gateway.releaseHung();
    const result = await p1;
    expect(result).toEqual(summary({ claimed: 1, sent: 1 }));

    const p3 = relay.tick();
    expect(p3).not.toBe(p1);
    expect(await p3).toEqual(summary());
    expect(gateway.calls).toHaveLength(1);
  });

  it('rejects when claiming fails but accepts new ticks afterwards', async () => {
    const { relay, repo, gateway, add, get } = setup();
    const id = await add();
    vi.spyOn(repo, 'claimNext').mockRejectedValueOnce(new Error('db down'));

    await expect(relay.tick()).rejects.toThrow('db down');
    expect(gateway.calls).toHaveLength(0);

    expect(await relay.tick()).toEqual(summary({ claimed: 1, sent: 1 }));
    expect((await get(id)).status).toBe('SENT');
  });

  it('logs one structured line per outcome with the correlation id', async () => {
    const { relay, gateway, clock, add } = setup();
    gateway.script({ kind: 'ok' }, retryable('THROTTLED', 429), permanent('REJECTED', 422));
    await add({ app: 'app-1', correlationId: 'corr-sent' });
    await add({ app: 'app-2', correlationId: 'corr-retry' });
    await add({ app: 'app-3', correlationId: 'corr-dead' });
    await relay.tick();
    clock.advance(1);

    const byEvent = (name: string) => logs.find((l) => l.payload.event === name);
    expect(byEvent('erp.sent')).toMatchObject({ level: 'log', payload: { correlationId: 'corr-sent', key: 'REPAYMENT:src-1', attempt: 1, duplicate: false } });
    expect(byEvent('erp.retry')).toMatchObject({
      level: 'warn', payload: { correlationId: 'corr-retry', code: 'THROTTLED', nextAttemptAt: new Date(T0.getTime() + BASE_MS).toISOString() },
    });
    expect(byEvent('erp.dead')).toMatchObject({ level: 'error', payload: { correlationId: 'corr-dead', code: 'REJECTED' } });
    expect(byEvent('erp.relay.tick')).toMatchObject({ payload: { claimed: 3, sent: 1, retried: 1, dead: 1, aborted: false } });
  });
});

describe('OutboxRelayService lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('schedules nothing when the relay is disabled', async () => {
    const { relay, gateway, add } = setup({ relay: { enabled: false, intervalMs: 1_000 } });
    await add();
    relay.onModuleInit();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gateway.calls).toHaveLength(0);
    expect(events()).toContain('erp.relay.disabled');
  });

  it('ticks every intervalMs when enabled', async () => {
    const { relay, gateway, add, get } = setup({ relay: { enabled: true, intervalMs: 1_000 } });
    const first = await add({ app: 'app-1' });
    relay.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    await flush();
    expect(gateway.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(gateway.ids).toEqual([first]);
    expect((await get(first)).status).toBe('SENT');

    const second = await add({ app: 'app-2' });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(gateway.ids).toEqual([first, second]);

    await relay.onModuleDestroy();
  });

  it('does not start a second tick while one is still in flight', async () => {
    const { relay, repo, gateway, add, get } = setup({ relay: { enabled: true, intervalMs: 1_000 } });
    const claim = vi.spyOn(repo, 'claimNext');
    gateway.script({ kind: 'hang' });
    const id = await add();
    relay.onModuleInit();

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(gateway.calls).toHaveLength(1);
    expect(claim).toHaveBeenCalledTimes(1);

    gateway.releaseHung();
    await flush();
    expect((await get(id)).status).toBe('SENT');
    await relay.onModuleDestroy();
  });

  it('survives a failing scheduled tick, logs it and keeps ticking', async () => {
    const { relay, repo, gateway, add } = setup({ relay: { enabled: true, intervalMs: 1_000 } });
    vi.spyOn(repo, 'claimNext').mockRejectedValueOnce(new Error('db down'));
    const id = await add();
    relay.onModuleInit();

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(gateway.calls).toHaveLength(0);
    expect(logs.find((l) => l.payload.event === 'erp.relay.tick_failed')).toMatchObject({ level: 'error', payload: { error: 'Error: db down' } });

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(gateway.ids).toEqual([id]);
    await relay.onModuleDestroy();
  });

  it('claims nothing once destroy has started', async () => {
    const { relay, gateway, add } = setup();
    await add();
    await relay.onModuleDestroy();
    expect(await relay.tick()).toEqual(summary());
    expect(gateway.calls).toHaveLength(0);
  });

  it('logs the target and mode on init, and warns loudly when a production process runs the mock', () => {
    const { relay } = setup();
    relay.onModuleInit();
    expect(logs.find((l) => l.payload.event === 'erp.relay.config')).toMatchObject({ level: 'log', payload: { target: 'fake-ERP', mode: 'mock', enabled: false } });
    expect(events()).not.toContain('erp.relay.mock_in_production');

    vi.stubEnv('NODE_ENV', 'production');
    try { relay.onModuleInit(); } finally { vi.unstubAllEnvs(); }
    expect(logs.find((l) => l.payload.event === 'erp.relay.mock_in_production')).toMatchObject({ level: 'warn' });
  });

  it('stops the timer on destroy', async () => {
    const { relay, gateway, add } = setup({ relay: { enabled: true, intervalMs: 1_000 } });
    relay.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);
    await relay.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);

    await add();
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(gateway.calls).toHaveLength(0);
  });

  it('is safe to destroy a relay that never started', async () => {
    const { relay } = setup();
    await expect(relay.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('waits for an in-flight tick on destroy', async () => {
    const { relay, gateway, add, get } = setup();
    gateway.script({ kind: 'hang' });
    const id = await add();
    const tick = relay.tick();
    await flush();

    let destroyed = false;
    const destroy = relay.onModuleDestroy().then(() => { destroyed = true; });
    await flush();
    expect(destroyed).toBe(false);

    gateway.releaseHung();
    await destroy;
    expect(destroyed).toBe(true);
    expect(await tick).toEqual(summary({ claimed: 1, sent: 1 }));
    expect((await get(id)).status).toBe('SENT');
  });

  it('still finishes destroying when the in-flight tick fails', async () => {
    const { relay, repo } = setup();
    let fail: (e: Error) => void = () => undefined;
    vi.spyOn(repo, 'claimNext').mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const outcome = relay.tick().then(() => 'ok', (e: Error) => e.message);
    await flush();

    let destroyed = false;
    const destroy = relay.onModuleDestroy().then(() => { destroyed = true; });
    await flush();
    expect(destroyed).toBe(false);

    fail(new Error('db down'));
    await destroy;
    expect(await outcome).toBe('db down');
  });
});

describe('OutboxRelayService dependency injection', () => {
  it('is wired from the explicit tokens, including the optional clock and deps', async () => {
    const repo = new MemoryErpEventRepository();
    const gateway = new FakeGateway();
    const clock = new TestClock(T0.getTime());
    const deps: RelayDeps = { random: () => 0.5, workerId: 'nest-worker' };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxRelayService,
        { provide: ERP_EVENT_REPOSITORY, useValue: repo },
        { provide: ERP_GATEWAY, useValue: gateway },
        { provide: ERP_SYNC_CONFIG, useValue: makeConfig() },
        { provide: Clock, useValue: clock },
        { provide: RELAY_DEPS, useValue: deps },
      ],
    }).compile();
    await moduleRef.init();
    const relay = moduleRef.get(OutboxRelayService);
    const id = await addEntry(repo, clock.now());
    gateway.script({ kind: 'hang' });
    const tick = relay.tick();
    await flush();
    expect((await repo.getById(id))?.lockedBy).toBe('nest-worker');
    gateway.releaseHung();
    expect(await tick).toEqual(summary({ claimed: 1, sent: 1 }));
    await moduleRef.close();
  });

  it('works without the optional providers, using the system clock and a unique generated worker id', async () => {
    const repo = new MemoryErpEventRepository();
    const gateway = new FakeGateway();
    const build = async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          OutboxRelayService,
          { provide: ERP_EVENT_REPOSITORY, useValue: repo },
          { provide: ERP_GATEWAY, useValue: gateway },
          { provide: ERP_SYNC_CONFIG, useValue: makeConfig() },
        ],
      }).compile();
      return moduleRef;
    };
    const m1 = await build();
    const m2 = await build();

    const id = await addEntry(repo, new Date(Date.now() - 1_000));
    gateway.script({ kind: 'hang' });
    const tick = m1.get(OutboxRelayService).tick();
    await flush();
    const lockedBy = (await repo.getById(id))?.lockedBy ?? '';
    expect(lockedBy.startsWith(`${hostname()}:${process.pid}:`)).toBe(true);
    expect(lockedBy.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
    gateway.releaseHung();
    expect(await tick).toEqual(summary({ claimed: 1, sent: 1 }));

    // a second instance generates a different worker id
    const id2 = await addEntry(repo, new Date(Date.now() - 1_000), { app: 'app-2' });
    gateway.script({ kind: 'hang' });
    const tick2 = m2.get(OutboxRelayService).tick();
    await flush();
    expect((await repo.getById(id2))?.lockedBy).not.toBe(lockedBy);
    gateway.releaseHung();
    await tick2;
    await Promise.all([m1.close(), m2.close()]);
  });
});
