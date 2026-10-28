import { afterEach, describe, it, expect, vi } from 'vitest';
import { callWithTimeout } from './call-with-timeout';
import { IntegrationError, type IntegrationContext } from './integration.types';

const base = { correlationId: 'corr-1', now: new Date('2026-10-28T09:00:00.000Z') };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => vi.useRealTimers());

describe('callWithTimeout (fake timers)', () => {
  it('resolves with the value and hands the base context plus a live signal to fn', async () => {
    vi.useFakeTimers();
    let seen: IntegrationContext | undefined;
    const value = await callWithTimeout('X', 1000, base, async (ctx) => {
      seen = ctx;
      return 42;
    });
    expect(value).toBe(42);
    expect(seen).toMatchObject({ correlationId: 'corr-1', now: base.now });
    expect(seen?.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rethrows the error of fn unchanged and clears the timer', async () => {
    vi.useFakeTimers();
    const boom = new IntegrationError('X', 'UNAVAILABLE', 'down');
    await expect(callWithTimeout('X', 1000, base, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes plain errors and synchronous throws through without wrapping them', async () => {
    vi.useFakeTimers();
    const plain = new Error('plain');
    await expect(callWithTimeout('X', 1000, base, () => Promise.reject(plain))).rejects.toBe(plain);
    await expect(
      callWithTimeout('X', 1000, base, () => {
        throw plain;
      }),
    ).rejects.toBe(plain);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with IntegrationError TIMEOUT after timeoutMs, not before, and aborts the signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = callWithTimeout('ATUT', 1000, base, (ctx) => {
      signal = ctx.signal;
      return new Promise<never>(() => undefined);
    });
    const outcome = pending.then(
      () => 'resolved',
      (e: unknown) => e,
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ integration: 'ATUT', code: 'TIMEOUT' });
    expect((error as Error).message).toContain('1000 ms');
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still reports TIMEOUT when fn rejects synchronously from its abort listener', async () => {
    vi.useFakeTimers();
    const pending = callWithTimeout('X', 500, base, (ctx) => {
      return new Promise<never>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted by fn'))));
    });
    const outcome = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toMatchObject({ integration: 'X', code: 'TIMEOUT' });
  });

  it('does not time out a call that settles in time and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const pending = callWithTimeout('X', 1000, base, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
  });
});

describe('callWithTimeout (real timers)', () => {
  it('survives fn rejecting after the timeout without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const outcome = await callWithTimeout('X', 10, base, async () => {
        await sleep(40);
        throw new Error('late failure');
      }).catch((e: unknown) => e);
      expect(outcome).toMatchObject({ code: 'TIMEOUT' });
      await sleep(80);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('survives fn resolving after the timeout', async () => {
    const outcome = await callWithTimeout('X', 10, base, async () => {
      await sleep(40);
      return 'late';
    }).catch((e: unknown) => e);
    expect(outcome).toMatchObject({ code: 'TIMEOUT' });
    await sleep(60);
  });
});
