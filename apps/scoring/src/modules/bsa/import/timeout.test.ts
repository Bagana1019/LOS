import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadline, ImportTimeoutError, withTimeout } from './timeout';

afterEach(() => vi.useRealTimers());

describe('withTimeout', () => {
  it('returns the result when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'step')).resolves.toBe(42);
  });

  it('propagates the work error as is', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'step')).rejects.toThrow('boom');
  });

  it('rejects with ImportTimeoutError naming the step, and a late rejection of the abandoned work stays silent', async () => {
    vi.useFakeTimers();
    let rejectLate: (e: Error) => void = () => undefined;
    const slow = new Promise<number>((_, reject) => {
      rejectLate = reject;
    });
    const guarded = withTimeout(slow, 50, 'extract');
    const outcome = guarded.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60);
    const error = (await outcome) as ImportTimeoutError;
    expect(error).toBeInstanceOf(ImportTimeoutError);
    expect(error.step).toBe('extract');
    rejectLate(new Error('late')); // unhandled rejection болохгүй
    await vi.advanceTimersByTimeAsync(1);
  });

  it('clears its timer when the work wins', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 10_000, 'x');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Deadline', () => {
  it('passes until the total budget is exceeded', () => {
    let now = 1000;
    const d = new Deadline(500, () => now);
    d.check('a');
    now = 1500;
    d.check('b'); // яг хязгаарт: хэтрээгүй
    expect(d.remainingMs()).toBe(0);
    now = 1501;
    expect(() => d.check('c')).toThrowError(ImportTimeoutError);
  });

  it('reports the remaining time', () => {
    let now = 0;
    const d = new Deadline(1000, () => now);
    now = 400;
    expect(d.remainingMs()).toBe(600);
  });
});
