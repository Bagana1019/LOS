// M9: e-sign sweeper олон pod-д зэрэг tick хийхэд provider руу (expire/finalize) нэг л pod хандана (advisory lock, бодит PostgreSQL).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import type { EsignConfig } from './esign.config';
import { SigningSweeperService } from './signing-sweeper.service';
import type { SigningService } from './signing.service';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const config = { sweepIntervalSec: 0 } as EsignConfig;
const empty = { scanned: 0 };

function slowSigning() {
  let release!: () => void;
  let markEntered!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const entered = new Promise<void>((r) => { markEntered = r; });
  const state = { calls: 0 };
  const signing = { sweep: async () => { state.calls++; markEntered(); await released; return empty; } } as unknown as SigningService;
  return { signing, entered, release, state };
}

describe.skipIf(!HAS_DB)('e-sign sweeper cross-pod lock (PostgreSQL)', () => {
  let podA: PrismaService;
  let podB: PrismaService;
  beforeAll(async () => { podA = new PrismaService(); podB = new PrismaService(); await Promise.all([podA.$connect(), podB.$connect()]); });
  afterAll(async () => { await Promise.all([podA?.$disconnect(), podB?.$disconnect()]); });

  it('two pods ticking at once sweep once', async () => {
    const s = slowSigning();
    const a = new SigningSweeperService(s.signing, config, podA).tick();
    await s.entered;
    const b = new SigningSweeperService(s.signing, config, podB).tick();
    await Promise.race([b, new Promise((r) => setTimeout(r, 1500))]);
    const calls = s.state.calls;
    s.release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  it('the lock is released after a tick, so the next pod sweeps', async () => {
    let n = 0;
    const signing = { sweep: async () => { n++; return empty; } } as unknown as SigningService;
    await new SigningSweeperService(signing, config, podA).tick();
    await new SigningSweeperService(signing, config, podB).tick();
    expect(n).toBe(2);
  });
});

describe('e-sign sweeper without a database', () => {
  it('sweeps directly when no PrismaService is wired (memory stores)', async () => {
    let n = 0;
    const signing = { sweep: async () => { n++; return empty; } } as unknown as SigningService;
    await new SigningSweeperService(signing, config).tick();
    expect(n).toBe(1);
  });
});
