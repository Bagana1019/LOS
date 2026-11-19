// M8: transient DB error classifier + bounded startup connect retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, connectRetryOptionsFromEnv, connectWithRetry, isTransientDbError } from './db-resilience';

const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('x'), { name, ...extra });

describe('isTransientDbError', () => {
  it.each([
    ['Prisma P1001 cannot reach server', named('PrismaClientKnownRequestError', { code: 'P1001' })],
    ['Prisma P1002 server timed out', named('PrismaClientKnownRequestError', { code: 'P1002' })],
    ['Prisma P1008 operation timed out', named('PrismaClientKnownRequestError', { code: 'P1008' })],
    ['Prisma P1017 server closed the connection', named('PrismaClientKnownRequestError', { code: 'P1017' })],
    ['Prisma P2024 pool timeout', named('PrismaClientKnownRequestError', { code: 'P2024' })],
    ['PrismaClientInitializationError (errorCode)', named('PrismaClientInitializationError', { errorCode: 'P1001' })],
    ['PrismaClientInitializationError without code', named('PrismaClientInitializationError')],
    ['raw query failed with 57P01 admin shutdown', named('PrismaClientKnownRequestError', { code: 'P2010', meta: { code: '57P01' } })],
    ['pg 57P01 admin shutdown', Object.assign(new Error('terminating connection'), { code: '57P01' })],
    ['pg 57P03 cannot connect now (starting up)', Object.assign(new Error('the database system is starting up'), { code: '57P03' })],
    ['pg class 08 connection exception', Object.assign(new Error('x'), { code: '08006' })],
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['Rust panic about a closed connection', named('PrismaClientRustPanicError', { message: 'Connection reset by peer' })],
    ['unknown request error "Server has closed the connection"', named('PrismaClientUnknownRequestError', { message: 'Server has closed the connection.' })],
    ['wrapped in cause', new Error('outer', { cause: Object.assign(new Error('inner'), { code: 'ECONNREFUSED' }) })],
    ['dms DbOperationError carrying P1001', named('DbOperationError', { code: 'P1001' })],
    ['dms DbOperationError INIT', named('DbOperationError', { code: 'INIT' })],
  ])('transient: %s', (_l, err) => { expect(isTransientDbError(err)).toBe(true); });

  it.each([
    ['unique violation P2002', named('PrismaClientKnownRequestError', { code: 'P2002' })],
    ['not found P2025', named('PrismaClientKnownRequestError', { code: 'P2025' })],
    ['validation error', named('PrismaClientValidationError')],
    ['Rust panic unrelated to connections', named('PrismaClientRustPanicError', { message: 'index out of bounds' })],
    ['pg 23505 unique', Object.assign(new Error('dup'), { code: '23505' })],
    ['pg 22P02 bad input', Object.assign(new Error('bad'), { code: '22P02' })],
    ['plain Error', new Error('boom')],
    ['domain error with string code', named('DomainError', { code: 'NOT_FOUND' })],
    ['null', null], ['undefined', undefined], ['string', 'ECONNREFUSED'], ['number', 1001],
  ])('not transient: %s', (_l, err) => { expect(isTransientDbError(err)).toBe(false); });

  it('survives a self-referencing cause cycle', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(isTransientDbError(e)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  const o = { initialDelayMs: 100, maxDelayMs: 1000 };
  it('grows exponentially and is capped', () => {
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffDelayMs(a, o, () => 1))).toEqual([100, 200, 400, 800, 1000, 1000]);
  });
  it('full jitter stays within [0, cap]', () => {
    expect(backoffDelayMs(3, o, () => 0)).toBe(0);
    expect(backoffDelayMs(3, o, () => 0.5)).toBe(400);
  });
});

describe('connectRetryOptionsFromEnv', () => {
  it('defaults to a ~60 s budget', () => {
    expect(connectRetryOptionsFromEnv({})).toEqual({ maxWaitMs: 60_000, initialDelayMs: 500, maxDelayMs: 10_000 });
  });
  it('reads env overrides and ignores invalid values', () => {
    expect(connectRetryOptionsFromEnv({ DB_CONNECT_MAX_WAIT_MS: '5000', DB_CONNECT_INITIAL_DELAY_MS: 'abc', DB_CONNECT_MAX_DELAY_MS: '-1' }))
      .toEqual({ maxWaitMs: 5000, initialDelayMs: 500, maxDelayMs: 10_000 });
  });
});

describe('connectWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const down = () => named('PrismaClientInitializationError', { errorCode: 'P1001', message: "Can't reach database server at postgresql://los:secret@db:5432" });
  const opts = { maxWaitMs: 10_000, initialDelayMs: 100, maxDelayMs: 1000, random: () => 1 };

  it('connects on the first try without waiting', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    await connectWithRetry(connect, opts);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('succeeds after N transient failures, logging warnings without the connection string', async () => {
    const warn = vi.fn();
    const connect = vi.fn().mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockResolvedValue(undefined);
    const p = connectWithRetry(connect, { ...opts, log: { warn } });
    await vi.advanceTimersByTimeAsync(100 + 200 + 400);
    await expect(p).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(3);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('postgresql://');
    expect(logged).toContain('P1001');
  });

  it('gives up after the time budget and rethrows the last error', async () => {
    const connect = vi.fn().mockRejectedValue(down());
    const p = connectWithRetry(connect, opts);
    const settled = expect(p).rejects.toMatchObject({ name: 'PrismaClientInitializationError' });
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    // 100+200+400+800+1000×n ≤ 10 000 → bounded number of attempts
    expect(connect.mock.calls.length).toBeGreaterThan(3);
    expect(connect.mock.calls.length).toBeLessThan(20);
  });

  it('does not retry non-transient errors (e.g. invalid schema / auth config)', async () => {
    const connect = vi.fn().mockRejectedValue(named('PrismaClientValidationError'));
    await expect(connectWithRetry(connect, opts)).rejects.toMatchObject({ name: 'PrismaClientValidationError' });
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
