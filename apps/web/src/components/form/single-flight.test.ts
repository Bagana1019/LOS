import { describe, expect, it, vi } from 'vitest';
import { createSingleFlight } from './single-flight';

// F2-14: React-ийн isPending дараагийн task-д л шинэчлэгддэг тул хурдан давхар товшилт хоёр хүсэлт явуулдаг байсан. Хамгаалалт нь синхрон.
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createSingleFlight', () => {
  it('нэг task дотор хоёр удаа дуудахад зөвхөн эхнийх ажиллана', async () => {
    const run = createSingleFlight();
    const gate = deferred<string>();
    const task = vi.fn(() => gate.promise);
    const first = run(task);
    const second = run(task); // синхрон, эхний нь дуусаагүй
    expect(task).toHaveBeenCalledTimes(1);
    gate.resolve('ok');
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBeUndefined();
  });

  it('task дууссаны дараа дахин ажиллуулж болно', async () => {
    const run = createSingleFlight();
    const task = vi.fn(() => Promise.resolve(1));
    await run(task);
    await run(task);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('task алдаа өгвөл алдааг дамжуулж, түгжээг тайлна (дахин оролдож болно)', async () => {
    const run = createSingleFlight();
    const gate = deferred<void>();
    const failing = run(() => gate.promise);
    gate.reject(new Error('409'));
    await expect(failing).rejects.toThrow('409');
    const retry = vi.fn(() => Promise.resolve('again'));
    await expect(run(retry)).resolves.toBe('again');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('тусдаа createSingleFlight нэг нэгийгээ түгжихгүй (хэсэг тус бүрийн форм)', async () => {
    const a = createSingleFlight();
    const b = createSingleFlight();
    const gate = deferred<void>();
    const pendingA = a(() => gate.promise);
    const taskB = vi.fn(() => Promise.resolve());
    await b(taskB);
    expect(taskB).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pendingA;
  });
});
