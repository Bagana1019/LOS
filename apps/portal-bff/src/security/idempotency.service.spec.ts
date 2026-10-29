import { describe, expect, it } from 'vitest';
import { MemoryKvStore } from '../store/memory-kv-store';
import { FakeClock } from '../testing/test-app';
import { IdempotencyService } from './idempotency.service';

const make = () => {
  const clock = new FakeClock(new Date('2026-10-28T04:00:00Z'));
  return { clock, svc: new IdempotencyService(new MemoryKvStore(clock)) };
};
const fp = (x: unknown) => IdempotencyService.fingerprint(x);

describe('IdempotencyService', () => {
  it('validates the key format', () => {
    expect(() => IdempotencyService.validateKey(undefined)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(() => IdempotencyService.validateKey('short')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => IdempotencyService.validateKey('has space in it!')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(IdempotencyService.validateKey('7d3f5c1e-aaaa-bbbb-cccc-0123456789ab')).toBeTruthy();
  });

  it('runs once and replays the stored result', async () => {
    const { svc } = make();
    let calls = 0;
    const exec = async () => ({ id: ++calls });
    const a = await svc.run('c1', 'key-00000001', fp({ a: 1 }), exec);
    const b = await svc.run('c1', 'key-00000001', fp({ a: 1 }), exec);
    expect(a).toEqual({ value: { id: 1 }, replayed: false });
    expect(b).toEqual({ value: { id: 1 }, replayed: true });
    expect(calls).toBe(1);
  });

  it('scopes keys per customer', async () => {
    const { svc } = make();
    let calls = 0;
    const exec = async () => ++calls;
    await svc.run('c1', 'key-00000001', fp(1), exec);
    const other = await svc.run('c2', 'key-00000001', fp(1), exec);
    expect(other.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('rejects the same key with a different payload', async () => {
    const { svc } = make();
    await svc.run('c1', 'key-00000001', fp({ amount: 1 }), async () => 'x');
    await expect(svc.run('c1', 'key-00000001', fp({ amount: 2 }), async () => 'y')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('while in flight, duplicates get REQUEST_IN_PROGRESS and exec runs once', async () => {
    const { svc } = make();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = svc.run('c1', 'key-00000001', fp(1), async () => {
      calls++;
      await gate;
      return 'done';
    });
    await expect(svc.run('c1', 'key-00000001', fp(1), async () => 'dup')).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    await expect(svc.run('c1', 'key-00000001', fp(2), async () => 'dup')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    release();
    expect(await slow).toEqual({ value: 'done', replayed: false });
    expect(calls).toBe(1);
  });

  it('a failed execution releases the key so the client can retry', async () => {
    const { svc } = make();
    await expect(svc.run('c1', 'key-00000001', fp(1), async () => { throw new Error('downstream down'); })).rejects.toThrow('downstream down');
    expect(await svc.run('c1', 'key-00000001', fp(1), async () => 'ok')).toEqual({ value: 'ok', replayed: false });
  });

  it('a crashed worker’s lock expires after 60s; completed results are kept for 24h', async () => {
    const { svc, clock } = make();
    // «Унасан» ажилтан: setIfAbsent хийсэн ч дуусгаагүй — гараар дуурайна
    let calls = 0;
    const hang = svc.run('c1', 'key-00000001', fp(1), () => new Promise<string>(() => { calls++; }));
    void hang;
    await Promise.resolve();
    await expect(svc.run('c1', 'key-00000001', fp(1), async () => 'x')).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    clock.advance(61_000);
    expect(await svc.run('c1', 'key-00000001', fp(1), async () => 'recovered')).toEqual({ value: 'recovered', replayed: false });
    clock.advance(23 * 3600_000);
    expect((await svc.run('c1', 'key-00000001', fp(1), async () => 'nope')).replayed).toBe(true);
    clock.advance(2 * 3600_000);
    expect((await svc.run('c1', 'key-00000001', fp(1), async () => 'fresh')).replayed).toBe(false);
    expect(calls).toBe(1);
  });
});
