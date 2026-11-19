// M9 — cross-pod exclusive tick. Real Postgres required (TEST_DATABASE_URL); each pg.Pool plays one pod.
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { advisoryLockKey, runExclusive, type AdvisoryLockClient } from './advisory-lock';

const PG_URL = process.env.TEST_DATABASE_URL;

/** Minimal Prisma-like `$transaction` over a dedicated pg connection; records the backend pid of the lock holder. */
function pod(pool: pg.Pool): AdvisoryLockClient & { pids: number[] } {
  const pids: number[] = [];
  return {
    pids,
    async $transaction(fn) {
      const c = await pool.connect();
      c.on('error', () => undefined);
      try {
        await c.query('BEGIN');
        pids.push((await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
        const r = await fn({ $queryRawUnsafe: async <T>(q: string, ...v: unknown[]) => (await c.query(q, v)).rows as T });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally { c.release(true); }
    },
  };
}

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const uniq = (s: string) => `test:${s}:${Math.random().toString(36).slice(2)}`;

describe('advisoryLockKey', () => {
  it('is stable for a name, distinct across names, and a signed 64-bit integer', () => {
    expect(advisoryLockKey('origination:approval-sla')).toBe(advisoryLockKey('origination:approval-sla'));
    expect(advisoryLockKey('origination:approval-sla')).not.toBe(advisoryLockKey('origination:draft-archive'));
    for (const n of ['a', 'b', 'origination:x', 'ü-юникод']) {
      const k = advisoryLockKey(n);
      expect(k >= -(2n ** 63n) && k < 2n ** 63n).toBe(true);
    }
  });
  it('rejects an empty name', () => { expect(() => advisoryLockKey('')).toThrow(); });
});

describe.skipIf(!PG_URL)('runExclusive (pg_try_advisory_xact_lock)', () => {
  const pools = [new pg.Pool({ connectionString: PG_URL, max: 3 }), new pg.Pool({ connectionString: PG_URL, max: 3 })];
  for (const p of pools) p.on('error', () => undefined); // the crash test kills a backend on purpose
  const [a, b] = pools.map(pod) as [ReturnType<typeof pod>, ReturnType<typeof pod>];
  afterAll(async () => { await Promise.all(pools.map((p) => p.end())); });

  it('single pod: runs the work and returns its value', async () => {
    expect(await runExclusive(a, uniq('single'), async () => 42)).toEqual({ ran: true, value: 42 });
  });

  it('two pods ticking at once: exactly one runs, the other skips without calling work', async () => {
    const name = uniq('race');
    const g = gate();
    let calls = 0;
    const work = async () => { calls++; await g.p; return 'done'; };
    const first = runExclusive(a, name, work);
    await new Promise((r) => setTimeout(r, 100)); // a holds the lock
    const second = await runExclusive(b, name, work);
    expect(second).toEqual({ ran: false });
    g.open();
    expect(await first).toEqual({ ran: true, value: 'done' });
    expect(calls).toBe(1);
  });

  it('many concurrent ticks across pods → work runs once', async () => {
    const name = uniq('burst');
    let calls = 0;
    const work = async () => { calls++; await new Promise((r) => setTimeout(r, 150)); };
    const results = await Promise.all([a, b, a, b, a, b].map((p) => runExclusive(p, name, work)));
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('lock is released after the work completes → the next tick on another pod runs', async () => {
    const name = uniq('release');
    expect((await runExclusive(a, name, async () => 1)).ran).toBe(true);
    expect((await runExclusive(b, name, async () => 2))).toEqual({ ran: true, value: 2 });
  });

  it('work error propagates and still releases the lock', async () => {
    const name = uniq('error');
    await expect(runExclusive(a, name, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await runExclusive(b, name, async () => 'ok')).ran).toBe(true);
  });

  it('different sweeper names do not block each other', async () => {
    const g = gate();
    const held = runExclusive(a, uniq('one'), () => g.p);
    await new Promise((r) => setTimeout(r, 50));
    expect((await runExclusive(b, uniq('two'), async () => 'x')).ran).toBe(true);
    g.open(); await held;
  });

  it('pod crash (holder connection dies) frees the lock immediately — no TTL wait', async () => {
    const name = uniq('crash');
    const g = gate();
    const held = runExclusive(a, name, () => g.p).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    try { await admin.query('SELECT pg_terminate_backend($1)', [a.pids.at(-1)]); } finally { await admin.end(); }
    await new Promise((r) => setTimeout(r, 100));
    expect((await runExclusive(b, name, async () => 'took over')).ran).toBe(true);
    g.open(); await held;
  });
});
