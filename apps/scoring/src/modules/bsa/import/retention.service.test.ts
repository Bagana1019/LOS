// BSA-BR-8: хадгалах хугацаа (retention) дууссан шинжилгээг устгах. Дараалал: DB commit ЭХЭНД, дараа нь object store (хуулгын файл).
// Хоёрын завсар унавал дахин ажиллуулахад аюулгүй. SYNTHETIC өгөгдөл.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BsaNotFoundError } from '../common/persistence';
import type { ObjectStore } from '../common/infra.ports';
import { createHarness, type Harness } from './testing/harness';
import { happyFiles } from './testing/scenario';
import { subtractYears } from './retention.service';

const YEAR_MS = 365 * 24 * 3600 * 1000;

/** Нэг хуулгатай шинжилгээ үүсгэнэ */
async function analysisWithFile(h: Harness, application: string): Promise<string> {
  const analysis = await h.createAnalysis({ loanApplicationId: application });
  const { a } = await happyFiles({ nameA: `zxq-secret-${application}.csv` });
  await h.uploadFiles(analysis.id, [a]);
  expect((await h.jobs(analysis.id))[0].status).toBe('COMPLETED');
  return analysis.id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RetentionService.purgeExpired', () => {
  it('purges only analyses older than the retention period, with all their rows, history and files', async () => {
    const h = await createHarness();
    const oldId = await analysisWithFile(h, 'app-old');
    h.clock.advance(2 * YEAR_MS);
    const newerId = await analysisWithFile(h, 'app-newer');
    expect(h.store.keys()).toHaveLength(2);

    // retentionYears = 3 (TEST_SETTINGS): 3 жил + 2 өдрийн дараа (2028 оны өндөр жилийг оролцуулан) зөвхөн анхных хугацаа хэтэрсэн
    h.clock.advance(YEAR_MS + 2 * 24 * 3600 * 1000);
    const report = await h.retention.purgeExpired();
    expect(report).toEqual({ examined: 2, purged: 1, objectsDeleted: 1, objectFailures: 0 });

    expect(await h.memory.analyses.getById(oldId)).toBeNull();
    expect(await h.memory.transactions.loadAll(oldId)).toHaveLength(0);
    expect((await h.memory.events.list(oldId)).items).toHaveLength(0);
    expect(await h.memory.importJobs.list({ analysisId: oldId })).toMatchObject({ items: [] });
    // Шинэ шинжилгээ бүрэн хэвээр
    expect(await h.memory.analyses.getById(newerId)).not.toBeNull();
    expect(await h.memory.transactions.loadAll(newerId)).toHaveLength(18);
    expect(h.store.keys()).toHaveLength(1);

    // Дахин ажиллуулахад юу ч хийхгүй
    expect(await h.retention.purgeExpired()).toMatchObject({ purged: 0, objectsDeleted: 0 });
  });

  it('respects the configured retention years (nothing is purged before the period ends)', async () => {
    const h = await createHarness({ settings: { retentionYears: 5 } });
    await analysisWithFile(h, 'app-1');
    h.clock.advance(4 * YEAR_MS);
    expect(await h.retention.purgeExpired()).toEqual({ examined: 1, purged: 0, objectsDeleted: 0, objectFailures: 0 });
    expect(h.store.keys()).toHaveLength(1);
    h.clock.advance(2 * YEAR_MS);
    expect(await h.retention.purgeExpired()).toMatchObject({ purged: 1, objectsDeleted: 1 });
  });

  it('commits the database purge BEFORE any file is deleted', async () => {
    const seen: Array<{ key: string; analysisStillThere: boolean; rowsStillThere: number }> = [];
    let analysisId = '';
    const h = await createHarness({
      wrapStore: (inner, memory): ObjectStore => ({
        put: (k, b, c) => inner.put(k, b, c),
        get: (k) => inner.get(k),
        exists: (k) => inner.exists(k),
        delete: async (key) => {
          seen.push({
            key,
            analysisStillThere: (await memory.analyses.getById(analysisId)) !== null,
            rowsStillThere: (await memory.transactions.loadAll(analysisId)).length,
          });
          await inner.delete(key);
        },
      }),
    });
    analysisId = await analysisWithFile(h, 'app-1');
    h.clock.advance(4 * YEAR_MS);
    await h.retention.purgeExpired();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ analysisStillThere: false, rowsStillThere: 0 });
  });

  it('a crash between the database commit and the file deletion is safe to re-run (files may be orphaned, never data loss)', async () => {
    let failDeletes = true;
    const h = await createHarness({
      wrapStore: (inner): ObjectStore => ({
        put: (k, b, c) => inner.put(k, b, c),
        get: (k) => inner.get(k),
        exists: (k) => inner.exists(k),
        delete: async (key) => {
          if (failDeletes) throw new Error('minio unreachable zxq-secret');
          await inner.delete(key);
        },
      }),
    });
    const id = await analysisWithFile(h, 'app-1');
    h.clock.advance(4 * YEAR_MS);

    const first = await h.retention.purgeExpired();
    expect(first).toEqual({ examined: 1, purged: 1, objectsDeleted: 0, objectFailures: 1 });
    expect(await h.memory.analyses.getById(id)).toBeNull(); // DB аль хэдийн цэвэр
    expect(h.store.keys()).toHaveLength(1); // файл өнчирсөн (устгах боломжгүй байсан)

    // Дахин ажиллуулахад алдаа гарахгүй, давхар устгахгүй
    failDeletes = false;
    expect(await h.retention.purgeExpired()).toEqual({ examined: 0, purged: 0, objectsDeleted: 0, objectFailures: 0 });
  });

  it('when the database purge itself fails no file is touched, and the next run completes the job', async () => {
    const h = await createHarness();
    await analysisWithFile(h, 'app-1');
    h.clock.advance(4 * YEAR_MS);
    const purge = vi.spyOn(h.repo.retention, 'purge').mockRejectedValueOnce(new Error('db down'));

    await expect(h.retention.purgeExpired()).rejects.toThrow('db down');
    expect(h.store.keys()).toHaveLength(1);
    expect(purge).toHaveBeenCalledTimes(1);

    expect(await h.retention.purgeExpired()).toMatchObject({ purged: 1, objectsDeleted: 1 });
    expect(h.store.keys()).toHaveLength(0);
  });

  it('skips an analysis that vanished concurrently (idempotent) and honours the batch limit', async () => {
    const h = await createHarness();
    for (const app of ['app-1', 'app-2', 'app-3']) await analysisWithFile(h, app);
    h.clock.advance(4 * YEAR_MS);

    const real = h.repo.retention.purge.bind(h.repo.retention);
    vi.spyOn(h.repo.retention, 'purge').mockImplementationOnce(async (id) => {
      throw new BsaNotFoundError('analysis', id);
    }).mockImplementation(real);

    const first = await h.retention.purgeExpired(h.clock.now(), 2);
    expect(first.purged).toBe(1); // нэг нь «аль хэдийн устсан», нөгөө нь устсан
    const second = await h.retention.purgeExpired(h.clock.now(), 10);
    expect(second.purged).toBe(2);
    expect(h.store.keys().length).toBeLessThanOrEqual(1);
  });

  it('the optional timer runs the purge periodically and stops on shutdown', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ options: { retentionIntervalMs: 1000 } });
    const run = vi.spyOn(h.retention, 'purgeExpired').mockResolvedValue({ examined: 0, purged: 0, objectsDeleted: 0, objectFailures: 0 });
    h.retention.onModuleInit();
    h.retention.onModuleInit(); // давхар эхлүүлэхгүй
    await vi.advanceTimersByTimeAsync(3100);
    expect(run).toHaveBeenCalledTimes(3);
    h.retention.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('the timer is off by default and a failing run does not stop it', async () => {
    vi.useFakeTimers();
    const off = await createHarness();
    const never = vi.spyOn(off.retention, 'purgeExpired');
    off.retention.onModuleInit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(never).not.toHaveBeenCalled();

    const h = await createHarness({ options: { retentionIntervalMs: 500 } });
    const run = vi.spyOn(h.retention, 'purgeExpired').mockRejectedValue(new Error('db down zxq-secret'));
    h.retention.onModuleInit();
    await vi.advanceTimersByTimeAsync(1600);
    expect(run).toHaveBeenCalledTimes(3);
    h.retention.onModuleDestroy();
  });

  it('subtractYears keeps the calendar date (and handles 29 February)', () => {
    expect(subtractYears(new Date('2026-07-15T09:00:00.000Z'), 3).toISOString()).toBe('2023-07-15T09:00:00.000Z');
    expect(subtractYears(new Date('2028-02-29T00:00:00.000Z'), 1).toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});
