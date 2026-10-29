// Complexity guard for "adversarial input stays linear" tests.
//
// A fixed wall-clock budget (`expect(elapsed).toBeLessThan(5_000)`) is a load test, not a complexity test: CI runs every
// package's tests at once on two vCPUs, the process gets descheduled, and the budget trips although the code did not change.
// Instead we (1) count CPU time, which descheduling does not inflate (contention still adds a little through cache and context
// switches), and (2) compare the cost at two input sizes, so the machine's absolute speed and that residual inflation cancel out:
// linear code grows ~factor×, quadratic code ~factor²×.
import { expect } from 'vitest';

/** Runs `task` and returns its cost in ms. */
export type Measure = (task: () => void) => number;

// Thread-scoped where Node has it (>= 22.19): process.cpuUsage() also counts the other worker threads of this process, which
// distorts the measurement under vitest's `threads` pool. Older Node falls back to the process-wide clock (vitest's default
// `forks` pool runs one test file per process, so that is exact there).
const cpuUsage: typeof process.cpuUsage = (process.threadCpuUsage ?? process.cpuUsage).bind(process);

/** CPU time (user + system) the calling thread spent in `task`; time spent descheduled or blocked is not counted. */
export const cpuTimeMs: Measure = (task) => {
  const before = cpuUsage();
  task();
  const { user, system } = cpuUsage(before);
  return (user + system) / 1000;
};

export interface GrowthOptions {
  /** Input size multiplier between the two measured sizes. Linear ≈ factor×, quadratic ≈ factor²×. Default 8. */
  factor?: number;
  /** Best-of-N per size: the minimum drops GC pauses, JIT warm-up and preemption noise. Default 3. */
  samples?: number;
  /** Fail when the cost grows faster than size^maxExponent. Default 1.5: accepts n·log n, rejects n². */
  maxExponent?: number;
  /**
   * Also fail when the large run needs more than this much CPU time. A ratio cannot see a slowdown that is uniform across sizes,
   * so give this a generous ceiling (20× or more above the normal cost). Default: none.
   */
  maxLargeMs?: number;
  /** Replaces the CPU-time clock (only for testing this helper). */
  measure?: Measure;
}

export interface Growth {
  factor: number;
  smallMs: number;
  /** Best large sample taken; sampling stops at the first sample that is within `limit`, since the minimum can only improve. */
  largeMs: number;
  /** largeMs / smallMs */
  ratio: number;
  /** Highest ratio accepted: factor ** maxExponent */
  limit: number;
  ok: boolean;
}

/** A baseline below this is timer noise, not signal; it keeps a near-zero small sample from inflating the ratio. */
const MIN_BASELINE_MS = 1;

/**
 * Measures how the cost of `prepare(size)()` grows between `size` and `size * factor`. `prepare` builds the input outside the
 * measured region and returns the thunk that processes it.
 */
export function measureGrowth(prepare: (size: number) => () => void, size: number, options: GrowthOptions = {}): Growth {
  const { factor = 8, samples = 3, maxExponent = 1.5, maxLargeMs = Infinity, measure = cpuTimeMs } = options;
  if (!(samples >= 1) || !(factor > 1) || !(maxExponent > 1)) throw new RangeError('measureGrowth: need samples >= 1, factor > 1 and maxExponent > 1');
  const smallTask = prepare(size);
  const smallMs = Math.min(...Array.from({ length: samples }, () => measure(smallTask)));
  const baseline = Math.max(smallMs, MIN_BASELINE_MS);
  const limit = factor ** maxExponent;

  const largeTask = prepare(size * factor);
  let largeMs = Infinity;
  for (let i = 0; i < samples; i++) {
    largeMs = Math.min(largeMs, measure(largeTask));
    if (largeMs / baseline <= limit) break; // the verdict is decided by the minimum, which cannot get worse from here
  }
  const ratio = largeMs / baseline;
  return { factor, smallMs, largeMs, ratio, limit, ok: ratio <= limit && largeMs <= maxLargeMs };
}

/** Asserts that processing time grows (near-)linearly with input size; see {@link measureGrowth}. */
export function expectNearLinear(prepare: (size: number) => () => void, size: number, options: GrowthOptions = {}): void {
  const g = measureGrowth(prepare, size, options);
  const detail = `${g.smallMs.toFixed(1)} ms -> ${g.largeMs.toFixed(1)} ms CPU for ${g.factor}x the input (linear ~${g.factor}x, limit ${g.limit.toFixed(1)}x)`;
  expect(g.ratio, detail).toBeLessThanOrEqual(g.limit);
  if (options.maxLargeMs !== undefined) expect(g.largeMs, `${detail}; absolute ceiling for the large run`).toBeLessThanOrEqual(options.maxLargeMs);
}
