import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { cpuTimeMs, expectNearLinear, measureGrowth, type Measure } from './scaling';

/** Deterministic clock: the "cost" of a task is `cost(size)`, where size is what `prepare` was called with (plus optional noise). */
function modelled(cost: (size: number) => number, noise: (call: number) => number = () => 0) {
  let size = 0;
  let call = 0;
  const prepare = (n: number) => () => {
    size = n;
  };
  const measure: Measure = (task) => {
    task();
    return cost(size) + noise(call++);
  };
  return { prepare, measure };
}

describe('measureGrowth (modelled cost, deterministic)', () => {
  it('linear growth is accepted: ratio == factor', () => {
    const { prepare, measure } = modelled((n) => n / 1000);
    const g = measureGrowth(prepare, 10_000, { measure });
    expect(g).toMatchObject({ smallMs: 10, largeMs: 80, ratio: 8, ok: true });
  });

  it('n·log n growth is accepted', () => {
    const { prepare, measure } = modelled((n) => (n * Math.log2(n)) / 10_000);
    expect(measureGrowth(prepare, 10_000, { measure }).ok).toBe(true);
  });

  it('quadratic growth is rejected: ratio == factor²', () => {
    const { prepare, measure } = modelled((n) => (n * n) / 1e7);
    const g = measureGrowth(prepare, 10_000, { measure });
    expect(g.ratio).toBeCloseTo(64);
    expect(g.limit).toBeCloseTo(8 ** 1.5);
    expect(g.ok).toBe(false);
  });

  it('factor and maxExponent move the limit', () => {
    const { prepare, measure } = modelled((n) => n ** 1.3 / 1000);
    expect(measureGrowth(prepare, 1_000, { measure, factor: 4, maxExponent: 1.5 }).ok).toBe(true);
    expect(measureGrowth(prepare, 1_000, { measure, factor: 4, maxExponent: 1.1 }).ok).toBe(false);
  });

  it('keeps the best sample of each size, so a single noisy run (GC, preemption) cannot decide', () => {
    // the first sample at every size is 500 ms slower; the large size has to be sampled again before it is within the limit
    const { prepare, measure } = modelled((n) => n / 1000, (call) => (call % 3 === 0 ? 500 : 0));
    const g = measureGrowth(prepare, 10_000, { measure, samples: 3 });
    expect(g).toMatchObject({ smallMs: 10, largeMs: 80, ok: true });
  });

  it('a noisy single sample does decide when samples is 1', () => {
    const { prepare, measure } = modelled((n) => n / 1000, (call) => (call === 1 ? 500 : 0));
    expect(measureGrowth(prepare, 10_000, { measure, samples: 1 }).ok).toBe(false);
  });

  it('a sub-millisecond baseline is floored, so timer noise cannot fake a blow-up', () => {
    const { prepare, measure } = modelled((n) => n / 1e6); // 0.001 ms -> 0.008 ms
    const g = measureGrowth(prepare, 1_000, { measure });
    expect(g.ratio).toBeLessThan(1);
    expect(g.ok).toBe(true);
  });

  it('builds the input once per size, outside the measured region', () => {
    const built: number[] = [];
    const ran: number[] = [];
    // 1 ms at the small size, 100 ms at the large one: over the limit, so every large sample is taken
    const measure: Measure = (task) => {
      task();
      return ran[ran.length - 1] === 100 ? 1 : 100;
    };
    measureGrowth(
      (n) => {
        built.push(n);
        return () => void ran.push(n);
      },
      100,
      { measure, samples: 4 },
    );
    expect(built).toEqual([100, 800]);
    expect(ran).toEqual([100, 100, 100, 100, 800, 800, 800, 800]);
  });

  it('stops sampling the large size at the first sample within the limit (the minimum cannot get worse)', () => {
    let largeRuns = 0;
    const g = measureGrowth(
      (n) => () => {
        if (n === 800) largeRuns++;
      },
      100,
      { samples: 5, measure: (task) => (task(), 8) },
    );
    expect(g.ok).toBe(true);
    expect(largeRuns).toBe(1);
  });

  it('takes every large sample while they are over the limit, and keeps the best', () => {
    const sequence = [1, 1, 1, 90, 70, 80]; // 3 small samples, then 3 large ones, all over the limit (22.6 x 1 ms)
    let call = 0;
    const g = measureGrowth((n) => () => void n, 100, { samples: 3, measure: (task) => (task(), sequence[call++]) });
    expect(g).toMatchObject({ smallMs: 1, largeMs: 70, ok: false });
    expect(call).toBe(6);
  });

  it('maxLargeMs fails a uniform slowdown the ratio cannot see', () => {
    const slow = modelled((n) => 50_000 + n / 1000); // ~constant, huge: ratio ~1
    expect(measureGrowth(slow.prepare, 10_000, { measure: slow.measure })).toMatchObject({ ok: true });
    expect(measureGrowth(slow.prepare, 10_000, { measure: slow.measure, maxLargeMs: 10_000 })).toMatchObject({ ok: false });
    expect(() => expectNearLinear(slow.prepare, 10_000, { measure: slow.measure, maxLargeMs: 10_000 })).toThrow(/absolute ceiling/);
  });

  it('rejects options that make the check meaningless', () => {
    const { prepare, measure } = modelled((n) => n);
    expect(() => measureGrowth(prepare, 10, { measure, samples: 0 })).toThrow(RangeError);
    expect(() => measureGrowth(prepare, 10, { measure, factor: 1 })).toThrow(RangeError);
    expect(() => measureGrowth(prepare, 10, { measure, maxExponent: 1 })).toThrow(RangeError);
  });
});

describe('expectNearLinear', () => {
  it('passes for linear, throws with the measured numbers for quadratic', () => {
    const linear = modelled((n) => n / 1000);
    expect(() => expectNearLinear(linear.prepare, 10_000, { measure: linear.measure })).not.toThrow();
    const quadratic = modelled((n) => (n * n) / 1e7);
    expect(() => expectNearLinear(quadratic.prepare, 10_000, { measure: quadratic.measure })).toThrow(/10\.0 ms -> 640\.0 ms CPU for 8x the input \(linear ~8x, limit 22\.6x\)/);
  });
});

// The real clock. Everything below is self-calibrating (ratios, CPU time), so it does not depend on how fast or how busy the machine is.
// The work is done inside native Array#indexOf on purpose: a hot JS loop is orders of magnitude slower under v8 coverage (CI runs with it).
describe('cpuTimeMs / real code', () => {
  const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const haystack = (n: number): number[] => new Array<number>(n).fill(0);

  it('does not count time spent blocked or descheduled, only CPU', () => {
    expect(cpuTimeMs(() => sleepMs(100))).toBeLessThan(50);
  });

  it.skipIf(typeof process.threadCpuUsage !== 'function')('counts only the calling thread, not the other worker threads of the process', async () => {
    const worker = new Worker('const end = Date.now() + 400; while (Date.now() < end) {}', { eval: true });
    await new Promise((resolve) => worker.once('online', resolve));
    const ms = cpuTimeMs(() => sleepMs(300)); // the worker burns ~300 ms of CPU meanwhile
    await worker.terminate();
    expect(ms).toBeLessThan(100);
  });

  it('counts the CPU a busy task burns', () => {
    const hay = haystack(4_000_000);
    expect(cpuTimeMs(() => void hay.indexOf(1))).toBeGreaterThan(0);
  });

  it('accepts a really linear task', () => {
    expectNearLinear((n) => {
      const hay = haystack(n);
      return () => void hay.indexOf(1); // one scan: O(n)
    }, 500_000);
  });

  it('rejects a really quadratic task', () => {
    const quadratic = (n: number) => {
      const hay = haystack(n);
      return () => {
        for (let i = 0; i < n; i++) hay.indexOf(1); // n scans: O(n^2)
      };
    };
    expect(() => expectNearLinear(quadratic, 2_000, { factor: 4, samples: 3 })).toThrow(/CPU for 4x the input \(linear ~4x, limit 8\.0x\)/);
  });
});
