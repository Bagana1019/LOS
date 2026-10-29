import { describe, expect, it } from 'vitest';
import { Semaphore, SemaphoreFullError, mapLimit, yieldToEventLoop } from './concurrency';

const deferred = <T = void>() => {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('Semaphore', () => {
  it('limit-ээс илүү зэрэг ажиллуулахгүй, илүүг FIFO дарааллаар хүлээлгэнэ', async () => {
    const sem = new Semaphore(2);
    let running = 0; let peak = 0; const order: number[] = [];
    const gates = Array.from({ length: 6 }, () => deferred());
    const jobs = gates.map((g, i) => sem.run(async () => { order.push(i); running++; peak = Math.max(peak, running); await g.promise; running--; return i; }));
    await Promise.resolve();
    expect(sem.running).toBe(2);
    expect(sem.queued).toBe(4);
    expect(order).toEqual([0, 1]);
    for (const g of gates) { g.resolve(); await new Promise((r) => setImmediate(r)); }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(sem.running).toBe(0);
    expect(sem.queued).toBe(0);
  });

  it('дараалал дүүрвэл SemaphoreFullError; ажиллаж буй, хүлээж буй ажилд нөлөөлөхгүй', async () => {
    const sem = new Semaphore(1, 2);
    const gate = deferred();
    const a = sem.run(() => gate.promise.then(() => 'a'));
    const b = sem.run(async () => 'b');
    const c = sem.run(async () => 'c');
    await expect(sem.run(async () => 'd')).rejects.toBeInstanceOf(SemaphoreFullError);
    gate.resolve();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(await sem.run(async () => 'e')).toBe('e'); // дараа нь дахин хэвийн
  });

  it('ажил алдаатай дууссан ч slot чөлөөлөгдөнө', async () => {
    const sem = new Semaphore(1);
    const failing = sem.run(async () => { throw new Error('boom'); });
    const next = sem.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ok');
    expect(sem.running).toBe(0);
  });

  it('limit < 1 эсвэл бүхэл биш бол алдаа', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });
});

describe('mapLimit', () => {
  it('үр дүнг эхлэх дарааллаар нь буцаана, зэрэгцээг limit-ээр хязгаарлана', async () => {
    let running = 0; let peak = 0;
    const tasks = [30, 5, 20, 1, 10].map((ms, i) => async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--; return i;
    });
    expect(await mapLimit(tasks, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('аль нэг ажил унавал reject', async () => {
    await expect(mapLimit([async () => 1, async () => { throw new Error('x'); }], 2)).rejects.toThrow('x');
  });
});

describe('yieldToEventLoop', () => {
  it('хүлээж буй timer-ийг ажиллуулах боломж олгоно', async () => {
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    await new Promise((r) => setTimeout(r, 2)); // timer хугацаа нь болсон
    expect(fired).toBe(true);
    let ran = false;
    setImmediate(() => { ran = true; });
    await yieldToEventLoop();
    expect(ran).toBe(true);
  });
});
