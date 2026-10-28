import { describe, expect, it } from 'vitest';
import { ConcurrencyGate, GateFullError } from './concurrency-gate';

/** Гаднаас нээж хаадаг promise (ажлыг гараар дуусгах) */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
type Deferred = ReturnType<typeof deferred<void>>;
const tick = () => new Promise<void>((r) => setImmediate(r));

describe('ConcurrencyGate', () => {
  it('ажлын үр дүнг буцаана', async () => {
    const gate = new ConcurrencyGate(1, 0);
    await expect(gate.run(async () => 42)).resolves.toBe(42);
    expect(gate.stats).toEqual({ running: 0, queued: 0 });
  });

  it('maxConcurrent-ээс илүүг зэрэг ажиллуулахгүй, үлдсэнийг дараалуулна (FIFO)', async () => {
    const gate = new ConcurrencyGate(2, 5);
    const order: string[] = [];
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const d = deferred();
    const run = (name: string, gateOpen: Deferred) =>
      gate.run(async () => {
        order.push(`start ${name}`);
        await gateOpen.promise;
        order.push(`end ${name}`);
      });
    const pa = run('a', a);
    const pb = run('b', b);
    const pc = run('c', c);
    const pd = run('d', d);
    await tick();
    expect(order).toEqual(['start a', 'start b']);
    expect(gate.stats).toEqual({ running: 2, queued: 2 });

    a.resolve();
    await pa;
    await tick();
    expect(order).toContain('start c');
    expect(order).not.toContain('start d');

    b.resolve();
    await pb;
    await tick();
    expect(order).toContain('start d');
    c.resolve();
    d.resolve();
    await Promise.all([pc, pd]);
    expect(gate.stats).toEqual({ running: 0, queued: 0 });
  });

  it('дараалал дүүрэн бол GateFullError, ажиллаж буй ажилд нөлөөлөхгүй', async () => {
    const gate = new ConcurrencyGate(1, 1);
    const a = deferred<string>();
    const pa = gate.run(() => a.promise);
    const pb = gate.run(async () => 'b'); // дараалалд
    await tick();
    await expect(gate.run(async () => 'c')).rejects.toBeInstanceOf(GateFullError);
    expect(gate.stats).toEqual({ running: 1, queued: 1 });
    a.resolve('a');
    await expect(pa).resolves.toBe('a');
    await expect(pb).resolves.toBe('b');
    expect(gate.stats).toEqual({ running: 0, queued: 0 });
  });

  it('maxQueue=0 үед завгүй бол шууд татгалзана', async () => {
    const gate = new ConcurrencyGate(1, 0);
    const a = deferred();
    const pa = gate.run(() => a.promise);
    await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(GateFullError);
    a.resolve();
    await pa;
  });

  it('ажил алдаатай дуусвал слотыг чөлөөлж, хүлээж буйг эхлүүлнэ', async () => {
    const gate = new ConcurrencyGate(1, 1);
    const a = deferred();
    const pa = gate.run(() => a.promise);
    const pb = gate.run(async () => 'ok');
    await tick();
    a.reject(new Error('boom'));
    await expect(pa).rejects.toThrow('boom');
    await expect(pb).resolves.toBe('ok');
    expect(gate.stats).toEqual({ running: 0, queued: 0 });
  });

  it('GateFullError нь тодорхой нэртэй', () => {
    const e = new GateFullError();
    expect(e.name).toBe('GateFullError');
    expect(e).toBeInstanceOf(Error);
  });
});
