// M8: outbox relay survives a transient DB outage — warns, backs off, keeps ticking, marks nothing when the tx failed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelay, buildEvent } from './outbox';

const event = buildEvent({ orgId: 'o1', userId: 'u1', correlationId: 'c' }, 'SettingsChanged', { key: 'k', productId: null });
const dbDown = () => Object.assign(new Error("Can't reach database server"), { name: 'PrismaClientInitializationError', errorCode: 'P1001' });

function fakeDb(failures: number, failure: () => Error = dbDown) {
  const marked: string[][] = [];
  let pending = [{ id: event.eventId, type: event.type, payload: event }];
  let calls = 0;
  const db = {
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      calls++;
      if (calls <= failures) throw failure();
      const tx = {
        $queryRawUnsafe: async () => pending,
        $executeRawUnsafe: async (_q: string, ids: string[]) => { marked.push(ids); pending = []; return ids.length; },
      };
      return fn(tx as never);
    },
  };
  return { db, marked, calls: () => calls };
}

describe('OutboxRelay under a transient DB outage', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('logs a warning, backs off beyond pollMs, then publishes on a later tick', async () => {
    const { db, marked, calls } = fakeDb(2);
    const publish = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const relay = new OutboxRelay({ db, schema: 'kyc', bus: { publish }, pollMs: 100, log, backoff: { initialDelayMs: 1000, maxDelayMs: 5000, random: () => 1 } });
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('DB unavailable'));
    expect(log).not.toHaveBeenCalledWith('error', expect.anything());
    await vi.advanceTimersByTimeAsync(500); // pollMs would have fired; backoff (1000) has not
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls()).toBe(2); // 2nd failure → backoff 2000
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls()).toBe(3);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(marked).toEqual([[event.eventId]]);
    await vi.advanceTimersByTimeAsync(100); // back to normal polling after recovery
    expect(calls()).toBe(4);
    await relay.stop();
  });

  it('never marks rows published when the transaction failed (at-least-once)', async () => {
    const { db, marked } = fakeDb(1);
    const relay = new OutboxRelay({ db, schema: 'kyc', bus: { publish: vi.fn() }, pollMs: 100, backoff: { initialDelayMs: 10, maxDelayMs: 10, random: () => 1 } });
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(marked).toEqual([]);
    await relay.stop();
  });

  it('non-transient errors keep the previous behaviour: error log, retry after pollMs', async () => {
    const { db, calls } = fakeDb(1, () => new Error('syntax error'));
    const log = vi.fn();
    const relay = new OutboxRelay({ db, schema: 'kyc', bus: { publish: vi.fn().mockResolvedValue(undefined) }, pollMs: 100, log });
    relay.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('outbox relay error'));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls()).toBe(2);
    await relay.stop();
  });
});
