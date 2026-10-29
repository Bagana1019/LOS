import 'reflect-metadata';
import { AmlListStatus } from '@los/contracts';
import { Logger, ServiceUnavailableException, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FATF_CLIENT, type FatfSnapshot } from '../../integrations/fatf/fatf.client';
import { UN_SC_CLIENT, type UnSanctionsSnapshot } from '../../integrations/un-sc/un-sc.client';
import { AML_CLOCK, type Clock } from './aml.ports';
import {
  DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_MIN_SNAPSHOT_RATIO, DEFAULT_RETRY_BACKOFF_MS, STALE_SUFFIX, stampedVersion, WATCHLIST_OPTIONS, WatchlistService,
  WatchlistUnavailableError, type WatchlistOptions,
} from './watchlist.service';

class FakeClock implements Clock {
  constructor(private t = Date.parse('2026-10-28T00:00:00.000Z')) {}
  now(): Date { return new Date(this.t); }
  advance(ms: number): void { this.t += ms; }
}
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

const unSnap = (version = 'un-v1', n = 2): UnSanctionsSnapshot => ({
  version,
  publishedAt: '2026-10-01T00:00:00.000Z',
  entries: Array.from({ length: n }, (_, i) => ({
    refId: `FIXTURE-UN-${i}`, type: 'INDIVIDUAL' as const, names: [{ value: `Fixture Person ${i}`, quality: 'PRIMARY' as const }],
    datesOfBirth: [], nationalities: [], identifiers: [], programme: 'FX_PROGRAMME_A', listedOn: '2020-01-01',
  })),
});
const fatfSnap = (version = 'fatf-v1'): FatfSnapshot => ({
  version,
  publishedAt: '2026-10-24T00:00:00.000Z',
  entries: [{ countryCode: 'KP', countryName: 'Fixture Country', category: 'CALL_FOR_ACTION', listedOn: '2026-10-23' }],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const OPTS = { maxStaleHours: 72 };

describe('WatchlistService', () => {
  let clock: FakeClock;
  let unFetch: ReturnType<typeof vi.fn<() => Promise<UnSanctionsSnapshot>>>;
  let fatfFetch: ReturnType<typeof vi.fn<() => Promise<FatfSnapshot>>>;
  const make = (options?: WatchlistOptions) => new WatchlistService({ fetchSnapshot: unFetch }, { fetchSnapshot: fatfFetch }, clock, options);

  beforeEach(() => {
    clock = new FakeClock();
    unFetch = vi.fn<() => Promise<UnSanctionsSnapshot>>().mockResolvedValue(unSnap());
    fatfFetch = vi.fn<() => Promise<FatfSnapshot>>().mockResolvedValue(fatfSnap());
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('cache', () => {
    it('serves the cache within the refresh interval', async () => {
      const svc = make();
      const first = await svc.getUn(OPTS);
      clock.advance(minutes(359));
      const second = await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(1);
      expect(second.snapshot).toBe(first.snapshot);
      expect(second.degraded).toBe(false);
      expect(second.fetchedAt).toEqual(first.fetchedAt);
    });

    it('reloads once the 360 minute default interval has elapsed', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      unFetch.mockResolvedValue(unSnap('un-v2'));
      clock.advance(minutes(360));
      const second = await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(2);
      expect(second.snapshot.version).toBe('un-v2');
      expect(second.degraded).toBe(false);
      expect(second.fetchedAt).toEqual(clock.now());
    });

    it('caches UN_SC and FATF independently', async () => {
      const svc = make();
      expect((await svc.getFatf(OPTS)).snapshot.version).toBe('fatf-v1');
      expect(unFetch).not.toHaveBeenCalled();
      await svc.getUn(OPTS);
      await svc.getFatf(OPTS);
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(1);
      expect(fatfFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('single-flight', () => {
    it('shares one in-flight load between 10 concurrent callers', async () => {
      const gate = deferred<UnSanctionsSnapshot>();
      unFetch.mockReturnValue(gate.promise);
      const svc = make();
      const calls = Array.from({ length: 10 }, () => svc.getUn(OPTS));
      gate.resolve(unSnap('un-shared'));
      const results = await Promise.all(calls);
      expect(unFetch).toHaveBeenCalledTimes(1);
      for (const r of results) {
        expect(r.snapshot.version).toBe('un-shared');
        expect(r.snapshot).toBe(results[0]?.snapshot);
        expect(r.degraded).toBe(false);
      }
    });

    it('shares one failed load between concurrent callers, then retries once the retry backoff has passed', async () => {
      const gate = deferred<UnSanctionsSnapshot>();
      unFetch.mockReturnValueOnce(gate.promise);
      const svc = make();
      const calls = Array.from({ length: 10 }, () => svc.getUn(OPTS).catch((e: unknown) => e));
      gate.reject(new Error('upstream down'));
      for (const r of await Promise.all(calls)) expect(r).toBeInstanceOf(WatchlistUnavailableError);
      expect(unFetch).toHaveBeenCalledTimes(1);

      clock.advance(DEFAULT_RETRY_BACKOFF_MS);
      expect((await svc.getUn(OPTS)).snapshot.version).toBe('un-v1');
      expect(unFetch).toHaveBeenCalledTimes(2);
    });

    it('lets refresh() join a load that is already in flight', async () => {
      const gate = deferred<UnSanctionsSnapshot>();
      unFetch.mockReturnValue(gate.promise);
      const svc = make();
      const pending = svc.getUn(OPTS);
      const refreshing = svc.refresh('UN_SC');
      gate.resolve(unSnap());
      await Promise.all([pending, refreshing]);
      expect(unFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('fail closed', () => {
    it('falls back to the cached snapshot with degraded=true when a refresh fails', async () => {
      const svc = make();
      const first = await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValue(new Error('upstream down'));

      const second = await svc.getUn(OPTS);
      expect(second.degraded).toBe(true);
      expect(second.snapshot).toBe(first.snapshot);
      expect(second.fetchedAt).toEqual(first.fetchedAt);
      expect(svc.status()[0]).toMatchObject({ list: 'UN_SC', stale: true, lastError: 'upstream down', version: 'un-v1' });
    });

    it('recovers to a fresh, non-degraded snapshot when the upstream comes back', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValueOnce(new Error('upstream down'));
      expect((await svc.getUn(OPTS)).degraded).toBe(true);

      unFetch.mockResolvedValue(unSnap('un-v2'));
      clock.advance(DEFAULT_RETRY_BACKOFF_MS); // хаалтын хугацаа дууссаны дараа л дахин татна
      const recovered = await svc.getUn(OPTS);
      expect(recovered).toMatchObject({ degraded: false, snapshot: { version: 'un-v2' } });
      expect(svc.status()[0]).toMatchObject({ stale: false, lastError: null, version: 'un-v2' });
    });

    it('throws WatchlistUnavailableError (503) naming the list when there is no cache', async () => {
      const boom = new Error('upstream down');
      unFetch.mockRejectedValue(boom);
      fatfFetch.mockRejectedValue(boom);
      const svc = make();

      const unErr = (await svc.getUn(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
      expect(unErr).toBeInstanceOf(WatchlistUnavailableError);
      expect(unErr).toBeInstanceOf(ServiceUnavailableException);
      expect(unErr.getStatus()).toBe(503);
      expect(unErr.list).toBe('UN_SC');
      expect(unErr.message).toContain('UN_SC');
      expect(unErr.cause).toBe(boom);

      const fatfErr = (await svc.getFatf(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
      expect(fatfErr.list).toBe('FATF');
      expect(fatfErr.message).toContain('FATF');
    });

    it('throws when the cached snapshot is older than maxStaleHours', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(80));
      unFetch.mockRejectedValue(new Error('upstream down'));
      const err = (await svc.getUn(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
      expect(err).toBeInstanceOf(WatchlistUnavailableError);
      expect(err.message).toContain('older than 72h');
    });

    it('still serves a cache that is exactly maxStaleHours old, but not one millisecond older', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      unFetch.mockRejectedValue(new Error('upstream down'));
      clock.advance(hours(72));
      expect((await svc.getUn(OPTS)).degraded).toBe(true);
      clock.advance(1);
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
    });

    it('applies maxStaleHours per caller', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(10));
      unFetch.mockRejectedValue(new Error('upstream down'));
      expect((await svc.getUn({ maxStaleHours: 12 })).degraded).toBe(true);
      await expect(svc.getUn({ maxStaleHours: 8 })).rejects.toBeInstanceOf(WatchlistUnavailableError);
    });

    it('fails closed when maxStaleHours is not a usable number', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValue(new Error('upstream down'));
      await expect(svc.getUn({ maxStaleHours: Number.NaN })).rejects.toBeInstanceOf(WatchlistUnavailableError);
    });

    it('rejects a snapshot with zero entries as a failed load', async () => {
      unFetch.mockResolvedValue(unSnap('un-empty', 0));
      const svc = make();
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      expect(svc.status()[0]).toMatchObject({ version: null, entryCount: 0, stale: true });
      expect(svc.status()[0]?.lastError).toContain('empty');
    });

    it('rejects a snapshot without a version as a failed load', async () => {
      fatfFetch.mockResolvedValue(fatfSnap('  '));
      const svc = make();
      await expect(svc.getFatf(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      expect(svc.status()[1]).toMatchObject({ list: 'FATF', version: null, stale: true });
    });

    it('keeps the previous cache when a refresh returns an empty snapshot', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockResolvedValue(unSnap('un-empty', 0));
      const result = await svc.getUn(OPTS);
      expect(result).toMatchObject({ degraded: true, snapshot: { version: 'un-v1' } });
    });
  });

  describe('refresh()', () => {
    it('reloads one list on demand, even within the interval', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      unFetch.mockResolvedValue(unSnap('un-v2'));
      await svc.refresh('UN_SC');
      expect(unFetch).toHaveBeenCalledTimes(2);
      expect(fatfFetch).not.toHaveBeenCalled();
      expect((await svc.getUn(OPTS)).snapshot.version).toBe('un-v2');
      expect(unFetch).toHaveBeenCalledTimes(2);
    });

    it('reloads both lists when called without an argument', async () => {
      const svc = make();
      await svc.refresh();
      expect(unFetch).toHaveBeenCalledTimes(1);
      expect(fatfFetch).toHaveBeenCalledTimes(1);
      expect(svc.status().map((s) => s.version)).toEqual(['un-v1', 'fatf-v1']);
    });

    it('rejects when the load fails but keeps the old cache', async () => {
      const svc = make();
      const before = await svc.getUn(OPTS);
      unFetch.mockRejectedValue(new Error('upstream down'));

      await expect(svc.refresh('UN_SC')).rejects.toThrow('upstream down');

      const after = await svc.getUn(OPTS);
      expect(after.snapshot).toBe(before.snapshot);
      expect(after.degraded).toBe(true);
      expect(svc.status()[0]).toMatchObject({ version: 'un-v1', entryCount: 2, lastError: 'upstream down', stale: true });
    });

    it('still reloads the other list when one fails, and then rejects', async () => {
      unFetch.mockRejectedValue(new Error('un down'));
      const svc = make();
      await expect(svc.refresh()).rejects.toThrow('un down');
      expect(fatfFetch).toHaveBeenCalledTimes(1);
      expect(svc.status()[1]).toMatchObject({ version: 'fatf-v1', stale: false });
    });

    it('rejects when the refreshed snapshot is empty', async () => {
      fatfFetch.mockResolvedValue({ ...fatfSnap(), entries: [] });
      await expect(make().refresh('FATF')).rejects.toThrow(/empty/);
    });
  });

  describe('status()', () => {
    it('reports never-loaded lists as stale with no version', () => {
      const result = make().status();
      expect(result).toEqual([
        { list: 'UN_SC', version: null, publishedAt: null, fetchedAt: null, entryCount: 0, stale: true, lastError: null },
        { list: 'FATF', version: null, publishedAt: null, fetchedAt: null, entryCount: 0, stale: true, lastError: null },
      ]);
      expect(Array.isArray(result)).toBe(true);
    });

    it('reports loaded lists from the cache without fetching', async () => {
      const svc = make();
      await svc.refresh();
      unFetch.mockClear();
      fatfFetch.mockClear();

      const result = svc.status();
      expect(result).toEqual([
        { list: 'UN_SC', version: 'un-v1', publishedAt: '2026-10-01T00:00:00.000Z', fetchedAt: '2026-10-28T00:00:00.000Z', entryCount: 2, stale: false, lastError: null },
        { list: 'FATF', version: 'fatf-v1', publishedAt: '2026-10-24T00:00:00.000Z', fetchedAt: '2026-10-28T00:00:00.000Z', entryCount: 1, stale: false, lastError: null },
      ]);
      for (const s of result) expect(AmlListStatus.parse(s)).toEqual(s);
      expect(unFetch).not.toHaveBeenCalled();
      expect(fatfFetch).not.toHaveBeenCalled();
    });

    it('marks lists stale once the cache is older than maxStaleHours (default 72)', async () => {
      const svc = make();
      await svc.refresh();
      clock.advance(hours(72));
      expect(svc.status().map((s) => s.stale)).toEqual([false, false]);
      clock.advance(1);
      expect(svc.status().map((s) => s.stale)).toEqual([true, true]);
      expect(svc.status(100).map((s) => s.stale)).toEqual([false, false]);
      expect(svc.status(1).map((s) => s.stale)).toEqual([true, true]);
    });
  });

  describe('currentVersions()', () => {
    it('returns the version of each list', async () => {
      unFetch.mockResolvedValue(unSnap('un-2026-10-01'));
      fatfFetch.mockResolvedValue(fatfSnap('2026-10'));
      expect(await make().currentVersions(OPTS)).toEqual({ UN_SC: 'un-2026-10-01', FATF: '2026-10' });
    });

    it('follows a refreshed list', async () => {
      const svc = make();
      await svc.currentVersions(OPTS);
      unFetch.mockResolvedValue(unSnap('un-v2'));
      await svc.refresh('UN_SC');
      expect(await svc.currentVersions(OPTS)).toEqual({ UN_SC: 'un-v2', FATF: 'fatf-v1' });
    });

    it('stamps the same +stale suffix as a screening would when the cache is degraded but usable', async () => {
      const svc = make();
      expect(await svc.currentVersions(OPTS)).toEqual({ UN_SC: 'un-v1', FATF: 'fatf-v1' });
      clock.advance(hours(7));
      unFetch.mockRejectedValue(new Error('un down'));
      fatfFetch.mockRejectedValue(new Error('fatf down'));
      const degraded = await svc.currentVersions(OPTS);
      expect(degraded).toEqual({ UN_SC: `un-v1${STALE_SUFFIX}`, FATF: `fatf-v1${STALE_SUFFIX}` });
      // Өөрчлөгдөөгүй доройтсон төлөв тогтвортой: хоёр дахь дуудлага ижил (өөр хувилбар болохгүй).
      expect(await svc.currentVersions(OPTS)).toEqual(degraded);
    });

    it('drops the suffix again once the list is fresh', async () => {
      const svc = make();
      await svc.currentVersions(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValueOnce(new Error('un down'));
      expect((await svc.currentVersions(OPTS)).UN_SC).toBe('un-v1+stale');
      clock.advance(DEFAULT_RETRY_BACKOFF_MS);
      expect((await svc.currentVersions(OPTS)).UN_SC).toBe('un-v1');
    });

    it('stampedVersion appends the suffix only for degraded snapshots', () => {
      expect(stampedVersion({ snapshot: { version: 'v9' }, degraded: false })).toBe('v9');
      expect(stampedVersion({ snapshot: { version: 'v9' }, degraded: true })).toBe('v9+stale');
    });

    it('fails closed when either list is unavailable', async () => {
      fatfFetch.mockRejectedValue(new Error('fatf down'));
      const err = (await make().currentVersions(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
      expect(err).toBeInstanceOf(WatchlistUnavailableError);
      expect(err.list).toBe('FATF');
    });
  });

  describe('refresh interval configuration', () => {
    it('honours options.refreshIntervalMinutes', async () => {
      const svc = make({ refreshIntervalMinutes: 10 });
      await svc.getUn(OPTS);
      clock.advance(minutes(9));
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(1);
      clock.advance(minutes(1));
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(2);
    });

    it('falls back to AML_LIST_REFRESH_MINUTES when no option is given', async () => {
      vi.stubEnv('AML_LIST_REFRESH_MINUTES', '30');
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(minutes(30));
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(2);
    });

    it('lets options win over the environment', async () => {
      vi.stubEnv('AML_LIST_REFRESH_MINUTES', '30');
      const svc = make({ refreshIntervalMinutes: 60 });
      await svc.getUn(OPTS);
      clock.advance(minutes(59));
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-positive or non-numeric interval at construction', () => {
      expect(() => make({ refreshIntervalMinutes: 0 })).toThrow(/refresh interval/);
      vi.stubEnv('AML_LIST_REFRESH_MINUTES', 'abc');
      expect(() => make()).toThrow(/"abc"/);
    });
  });

  describe('fetch timeout', () => {
    const hang = () => new Promise<never>(() => undefined);

    it('defaults to 15 seconds for an external fetch (CLAUDE.md 3.1)', async () => {
      expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(15_000);
      vi.useFakeTimers();
      try {
        unFetch.mockImplementation(hang);
        const settled = vi.fn();
        const pending = make().getUn(OPTS).catch((e: unknown) => { settled(e); });
        await vi.advanceTimersByTimeAsync(14_999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(WatchlistUnavailableError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('answers 503 when a hanging fetch has no cache to fall back to', async () => {
      unFetch.mockImplementation(hang);
      const svc = make({ fetchTimeoutMs: 20 });
      const err = (await svc.getUn(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
      expect(err).toBeInstanceOf(WatchlistUnavailableError);
      expect(err.getStatus()).toBe(503);
      expect((err.cause as Error).message).toMatch(/timed out after 20ms/);
      expect(svc.status()[0]?.lastError).toMatch(/timed out/);
    });

    it('degrades to the stale cache when a refresh hangs', async () => {
      const svc = make({ fetchTimeoutMs: 20 });
      const first = await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockImplementation(hang);
      const second = await svc.getUn(OPTS);
      expect(second).toMatchObject({ degraded: true });
      expect(second.snapshot).toBe(first.snapshot);
    });

    it('does not pin later callers to the hung fetch: the next call starts a fresh load', async () => {
      const svc = make({ fetchTimeoutMs: 20 });
      unFetch.mockImplementationOnce(hang);
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      clock.advance(DEFAULT_RETRY_BACKOFF_MS);
      expect((await svc.getUn(OPTS)).snapshot.version).toBe('un-v1');
      expect(unFetch).toHaveBeenCalledTimes(2);
    });

    it('does not fire after a fast fetch and rejects an invalid timeout option', async () => {
      const svc = make({ fetchTimeoutMs: 5 });
      expect((await svc.getUn(OPTS)).degraded).toBe(false);
      await new Promise((r) => setTimeout(r, 15));
      expect(svc.status()[0]).toMatchObject({ stale: false, lastError: null });
      expect(() => make({ fetchTimeoutMs: 0 })).toThrow(/fetch timeout/);
      expect(() => make({ fetchTimeoutMs: Number.NaN })).toThrow(/fetch timeout/);
    });
  });

  describe('retry backoff after a failed fetch', () => {
    const hang = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

    it('defaults to 30 seconds', () => {
      expect(DEFAULT_RETRY_BACKOFF_MS).toBe(30_000);
    });

    it('serves the usable stale cache immediately without a new fetch while backing off, and fetches again afterwards', async () => {
      const svc = make();
      const first = await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValue(new Error('upstream down'));
      expect((await svc.getUn(OPTS)).degraded).toBe(true);
      expect(unFetch).toHaveBeenCalledTimes(2);

      for (let i = 0; i < 5; i++) {
        clock.advance(1_000);
        const again = await svc.getUn(OPTS);
        expect(again).toMatchObject({ degraded: true });
        expect(again.snapshot).toBe(first.snapshot);
      }
      expect(unFetch).toHaveBeenCalledTimes(2); // 5 дуудлага, нэг ч шинэ таталт байхгүй

      clock.advance(DEFAULT_RETRY_BACKOFF_MS); // сүүлийн алдаанаас хойш >= 30с
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(3);
    });

    it('without a usable cache, fails closed immediately with the remembered error and does not fetch again', async () => {
      const boom = new Error('upstream down');
      unFetch.mockRejectedValue(boom);
      const svc = make();
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      for (let i = 0; i < 3; i++) {
        const err = (await svc.getUn(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
        expect(err).toBeInstanceOf(WatchlistUnavailableError);
        expect(err.cause).toBe(boom);
        expect(err.message).toContain('no cached snapshot');
      }
      expect(unFetch).toHaveBeenCalledTimes(1);
    });

    it('an expired stale cache (older than maxStaleHours) is still refused while backing off', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(80));
      unFetch.mockRejectedValue(new Error('upstream down'));
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      const err = (await svc.getUn(OPTS).catch((e: unknown) => e)) as WatchlistUnavailableError;
      expect(err.message).toContain('older than 72h');
      expect(unFetch).toHaveBeenCalledTimes(2);
    });

    it('four sequential calls during a hang cost one timeout, not four', async () => {
      vi.useFakeTimers();
      try {
        const svc = make({ fetchTimeoutMs: 150 });
        await svc.getUn(OPTS);
        clock.advance(hours(7));
        unFetch.mockImplementation(hang);

        const first = svc.getUn(OPTS);
        await vi.advanceTimersByTimeAsync(149);
        expect(vi.getTimerCount()).toBe(1); // таталт хугацаа хэтрэхийг хүлээж байна
        await vi.advanceTimersByTimeAsync(1);
        expect(await first).toMatchObject({ degraded: true });

        // Дараагийн гурван дуудлага таймер ахиулахгүйгээр, даруй хариулна.
        for (let i = 0; i < 3; i++) expect(await svc.getUn(OPTS)).toMatchObject({ degraded: true });
        expect(unFetch).toHaveBeenCalledTimes(2); // анхны ачаалал + нэг өлгөгдсөн таталт
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('with no cache, a hang costs one timeout and the next calls fail immediately', async () => {
      vi.useFakeTimers();
      try {
        const svc = make({ fetchTimeoutMs: 150 });
        unFetch.mockImplementation(hang);
        const first = svc.getUn(OPTS).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(150);
        expect(await first).toBeInstanceOf(WatchlistUnavailableError);
        for (let i = 0; i < 3; i++) await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
        expect(unFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes an AbortSignal to the client and aborts it when the fetch times out', async () => {
      const seen: (AbortSignal | undefined)[] = [];
      const svc = new WatchlistService(
        { fetchSnapshot: (signal) => { seen.push(signal); return hang(signal); } }, { fetchSnapshot: fatfFetch }, clock, { fetchTimeoutMs: 20 },
      );
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.aborted).toBe(true);
    });

    it('does not abort the signal of a fetch that completed in time', async () => {
      const seen: (AbortSignal | undefined)[] = [];
      const svc = new WatchlistService({ fetchSnapshot: async (signal) => { seen.push(signal); return unSnap(); } }, { fetchSnapshot: fatfFetch }, clock, { fetchTimeoutMs: 20 });
      await svc.getUn(OPTS);
      await new Promise((r) => setTimeout(r, 40));
      expect(seen[0]?.aborted).toBe(false);
    });

    it('a forced refresh() ignores the backoff, and its success clears it', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValueOnce(new Error('upstream down'));
      expect((await svc.getUn(OPTS)).degraded).toBe(true);
      await svc.refresh('UN_SC');
      expect(unFetch).toHaveBeenCalledTimes(3);
      expect(await svc.getUn(OPTS)).toMatchObject({ degraded: false });
      expect(unFetch).toHaveBeenCalledTimes(3);
    });

    it('a fetch that throws synchronously is a failed load, not a leaked timer', async () => {
      vi.useFakeTimers();
      try {
        const svc = new WatchlistService({ fetchSnapshot: () => { throw new Error('sync boom'); } }, { fetchSnapshot: fatfFetch }, clock);
        await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
        expect(vi.getTimerCount()).toBe(0);
        expect(svc.status()[0]?.lastError).toBe('sync boom');
      } finally {
        vi.useRealTimers();
      }
    });

    it('is per list and can be turned off (retryBackoffMs: 0)', async () => {
      unFetch.mockRejectedValue(new Error('un down'));
      const svc = make();
      await expect(svc.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      expect((await svc.getFatf(OPTS)).snapshot.version).toBe('fatf-v1'); // FATF нь UN-ийн алдаанд хамаарахгүй

      const off = make({ retryBackoffMs: 0 });
      await expect(off.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      await expect(off.getUn(OPTS)).rejects.toBeInstanceOf(WatchlistUnavailableError);
      expect(unFetch).toHaveBeenCalledTimes(3);
    });

    it('does not extend the backoff when the clock steps backwards', async () => {
      const svc = make();
      await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockRejectedValue(new Error('upstream down'));
      await svc.getUn(OPTS);
      clock.advance(-hours(6));
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(3);
    });

    it('rejects an invalid backoff option', () => {
      expect(() => make({ retryBackoffMs: -1 })).toThrow(/retry backoff/);
      expect(() => make({ retryBackoffMs: Number.NaN })).toThrow(/retry backoff/);
    });
  });

  describe('truncated snapshot guard', () => {
    const bigUn = (n: number, version: string) => unSnap(version, n);

    it('defaults to half of the previous snapshot', () => {
      expect(DEFAULT_MIN_SNAPSHOT_RATIO).toBe(0.5);
    });

    it('rejects a snapshot below half of the previous 20+ entries as a failed fetch: previous cache kept, degraded, logged, status shows the error', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      unFetch.mockResolvedValue(bigUn(40, 'un-v1'));
      const svc = make();
      const first = await svc.getUn(OPTS);
      clock.advance(hours(7));
      unFetch.mockResolvedValue(bigUn(19, 'un-v2-partial'));

      const second = await svc.getUn(OPTS);
      expect(second).toMatchObject({ degraded: true });
      expect(second.snapshot).toBe(first.snapshot);
      expect(svc.status()[0]).toMatchObject({ version: 'un-v1', entryCount: 40, stale: true });
      expect(svc.status()[0]?.lastError).toMatch(/19 entries.*50%.*previous 40.*truncated/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
    });

    it('accepts a snapshot at exactly the ratio (half) and any growth', async () => {
      unFetch.mockResolvedValue(bigUn(40, 'un-v1'));
      const svc = make();
      await svc.getUn(OPTS);
      unFetch.mockResolvedValue(bigUn(20, 'un-v2'));
      await svc.refresh('UN_SC');
      expect(svc.status()[0]).toMatchObject({ version: 'un-v2', entryCount: 20, lastError: null });
      unFetch.mockResolvedValue(bigUn(25, 'un-v3'));
      await svc.refresh('UN_SC');
      expect(svc.status()[0]).toMatchObject({ version: 'un-v3', entryCount: 25 });
    });

    it('lets a legitimately small list shrink: the guard only applies when the previous snapshot had 20 or more entries', async () => {
      unFetch.mockResolvedValue(bigUn(19, 'un-v1'));
      const svc = make();
      await svc.getUn(OPTS);
      unFetch.mockResolvedValue(bigUn(1, 'un-v2'));
      await svc.refresh('UN_SC');
      expect(svc.status()[0]).toMatchObject({ version: 'un-v2', entryCount: 1, lastError: null });
    });

    it('measures against the last ACCEPTED snapshot, so a rejected partial one does not become the new baseline', async () => {
      unFetch.mockResolvedValue(bigUn(40, 'un-v1'));
      const svc = make();
      await svc.getUn(OPTS);
      unFetch.mockResolvedValue(bigUn(5, 'un-partial'));
      await expect(svc.refresh('UN_SC')).rejects.toThrow(/truncated/);
      await expect(svc.refresh('UN_SC')).rejects.toThrow(/truncated/);
      expect(svc.status()[0]).toMatchObject({ version: 'un-v1', entryCount: 40 });
    });

    it('does not guard the first load (nothing to compare with) and honours minSnapshotRatio: 0 and a stricter ratio', async () => {
      unFetch.mockResolvedValue(bigUn(1, 'un-first'));
      expect((await make().getUn(OPTS)).snapshot.version).toBe('un-first');

      unFetch.mockResolvedValue(bigUn(40, 'un-v1'));
      const off = make({ minSnapshotRatio: 0 });
      await off.getUn(OPTS);
      unFetch.mockResolvedValue(bigUn(1, 'un-v2'));
      await off.refresh('UN_SC');
      expect(off.status()[0]).toMatchObject({ version: 'un-v2', entryCount: 1 });

      unFetch.mockResolvedValue(bigUn(40, 'un-v1'));
      const strict = make({ minSnapshotRatio: 0.9 });
      await strict.getUn(OPTS);
      unFetch.mockResolvedValue(bigUn(35, 'un-v2'));
      await expect(strict.refresh('UN_SC')).rejects.toThrow(/truncated/);
    });

    it('applies to FATF as well and rejects an out-of-range ratio option', async () => {
      const fatfEntries = (n: number) => Array.from({ length: n }, (_, i) => ({ countryCode: `C${i}`, countryName: `Country ${i}`, category: 'INCREASED_MONITORING' as const, listedOn: '2026-01-01' }));
      fatfFetch.mockResolvedValue({ ...fatfSnap('f1'), entries: fatfEntries(30) });
      const svc = make();
      await svc.getFatf(OPTS);
      fatfFetch.mockResolvedValue({ ...fatfSnap('f2'), entries: fatfEntries(10) });
      await expect(svc.refresh('FATF')).rejects.toThrow(/truncated/);
      expect(svc.status()[1]).toMatchObject({ version: 'f1', entryCount: 30 });
      expect(() => make({ minSnapshotRatio: 1.5 })).toThrow(/snapshot ratio/);
      expect(() => make({ minSnapshotRatio: -0.1 })).toThrow(/snapshot ratio/);
    });
  });

  describe('Nest wiring', () => {
    const boot = (extra: Provider[] = []) => Test.createTestingModule({
      providers: [
        WatchlistService,
        { provide: UN_SC_CLIENT, useValue: { fetchSnapshot: unFetch } },
        { provide: FATF_CLIENT, useValue: { fetchSnapshot: fatfFetch } },
        { provide: AML_CLOCK, useValue: clock },
        ...extra,
      ],
    }).compile();

    it('resolves its dependencies by explicit @Inject tokens, with WATCHLIST_OPTIONS optional', async () => {
      const svc = (await boot()).get(WatchlistService);
      expect(await svc.currentVersions(OPTS)).toEqual({ UN_SC: 'un-v1', FATF: 'fatf-v1' });
    });

    it('picks up WATCHLIST_OPTIONS when provided', async () => {
      const svc = (await boot([{ provide: WATCHLIST_OPTIONS, useValue: { refreshIntervalMinutes: 5 } }])).get(WatchlistService);
      await svc.getUn(OPTS);
      clock.advance(minutes(5));
      await svc.getUn(OPTS);
      expect(unFetch).toHaveBeenCalledTimes(2);
    });
  });
});
