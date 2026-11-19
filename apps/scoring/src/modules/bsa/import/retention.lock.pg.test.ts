// M9: BSA retention timer tick олон pod-д зэрэг ажиллахад нэг л pod устгана (advisory lock, бодит PostgreSQL). TEST_DATABASE_URL-гүй бол алгасна.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../../prisma.service';
import type { BsaSettingsProvider, ObjectStore } from '../common/infra.ports';
import type { BsaRepository } from '../common/persistence';
import { IMPORT_DEFAULTS, type Clock } from './import.defaults';
import { RetentionService } from './retention.service';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const clock: Clock = { now: () => new Date('2030-01-01T00:00:00.000Z') };

function slowRepo() {
  let release!: () => void;
  let markEntered!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { markEntered = r; });
  const state = { calls: 0 };
  const repo = { retention: { findExpired: async () => { state.calls++; markEntered(); await released; return []; } } } as unknown as BsaRepository;
  return { repo, entered, release, state };
}
const make = (repo: BsaRepository, prisma?: PrismaService) =>
  new RetentionService(repo, {} as BsaSettingsProvider, {} as ObjectStore, IMPORT_DEFAULTS, clock, prisma);

describe.skipIf(!HAS_DB)('BSA retention cross-pod lock (PostgreSQL)', () => {
  let podA: PrismaService;
  let podB: PrismaService;
  beforeAll(async () => { podA = new PrismaService(); podB = new PrismaService(); await Promise.all([podA.$connect(), podB.$connect()]); });
  afterAll(async () => { await Promise.all([podA?.$disconnect(), podB?.$disconnect()]); });

  it('two pods ticking at once purge once; the second tick reports it did not run', async () => {
    const s = slowRepo();
    const a = make(s.repo, podA).tick();
    await s.entered;
    const b = await Promise.race([make(s.repo, podB).tick(), new Promise((r) => setTimeout(() => r('timeout'), 1500))]);
    const calls = s.state.calls;
    s.release();
    expect(await a).toMatchObject({ purged: 0 });
    expect(b).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('BSA retention without a database', () => {
  it('runs the purge directly (memory repository mode)', async () => {
    let n = 0;
    const repo = { retention: { findExpired: async () => { n++; return []; } } } as unknown as BsaRepository;
    expect(await make(repo).tick()).toMatchObject({ examined: 0, purged: 0 });
    expect(n).toBe(1);
  });
});
