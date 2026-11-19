// HIGH (C3): events dead-lettered for the dwh-sync-* groups must be recoverable. replay-dlq applies them through the same projector
// (processed_events makes it idempotent), only for dwh groups, never re-XADDs to los:events (that would redeliver to every service).
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DwhProjector } from '../modules/consumers/dwh-projector';
import { createDwhDatabase, type DwhDatabase } from '../modules/etl/dwh-database';
import { applyDwhDdl, DWH_TEST_URL, wipeDwh } from '../test-utils/dwh-db';
import { ev } from '../test-utils/events';
import { parseReplayArgs, replayDlq } from './replay-dlq';

const ALL_GROUPS = ['dwh-sync-application', 'dwh-sync-scoring', 'dwh-sync-disbursement', 'dwh-sync-bsa'];

describe('parseReplayArgs', () => {
  it('defaults to every dwh-sync group, no time bound, not a dry run', () => {
    expect(parseReplayArgs([])).toEqual({ groups: ALL_GROUPS, sinceMs: undefined, dryRun: false });
  });
  it('accepts repeated --group, --since as ISO or epoch ms, and --dry-run', () => {
    expect(parseReplayArgs(['--group', 'dwh-sync-scoring', '--group', 'dwh-sync-bsa', '--since', '2026-11-18T00:00:00Z', '--dry-run']))
      .toEqual({ groups: ['dwh-sync-scoring', 'dwh-sync-bsa'], sinceMs: Date.parse('2026-11-18T00:00:00Z'), dryRun: true });
    expect(parseReplayArgs(['--since', '1763424000000']).sinceMs).toBe(1763424000000);
  });
  it('rejects a non-dwh group (replay must never touch another service\'s dead letters) and an invalid --since', () => {
    expect(() => parseReplayArgs(['--group', 'origination-notification'])).toThrow(/not a dwh-sync consumer group/);
    expect(() => parseReplayArgs(['--since', 'yesterday'])).toThrow(/--since/);
    expect(() => parseReplayArgs(['--bogus'])).toThrow();
  });
});

describe.skipIf(!DWH_TEST_URL || !process.env.REDIS_URL)('replayDlq (Redis + DWH)', () => {
  const dlqStream = `los:events:dlq-test-${randomUUID()}`;
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true });
  let pool: pg.Pool; let db: DwhDatabase; let projector: DwhProjector;
  const dead = async (group: string, raw: unknown, payload = JSON.stringify(raw)) => {
    const r = raw as { eventId?: string; type?: string };
    return redis.xadd(dlqStream, '*', 'group', group, 'id', '1-0', 'error', 'x', 'eventId', r.eventId ?? '', 'type', r.type ?? '', 'payload', payload);
  };
  const remaining = async () => (await redis.xrange(dlqStream, '-', '+')).map(([id, f]) => ({ id, group: f[f.indexOf('group') + 1] }));
  const factCount = async (id: string) => Number((await pool.query('SELECT count(*)::int AS n FROM fact_application WHERE application_id = $1', [id])).rows[0].n);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DWH_TEST_URL, max: 2 });
    await applyDwhDdl(pool);
    db = createDwhDatabase(DWH_TEST_URL);
    projector = new DwhProjector(db);
  });
  beforeEach(async () => { await wipeDwh(pool); await redis.del(dlqStream); });
  afterAll(async () => { await redis.del(dlqStream); redis.disconnect(); await db?.close(); await pool?.end(); });

  it('applies dwh entries, removes them from the DLQ, keeps skipped ones and never touches other services\' entries', async () => {
    const good = ev('ApplicationSubmitted', { applicationId: 'app-r1', amount: 1000, productId: 'p-1' });
    const score = ev('ScoringCompleted', { applicationId: 'app-r1', selectedMethod: 'C', soscoScore: 600, dtiPercent: 25 });
    await dead('dwh-sync-application', good);
    await dead('dwh-sync-application', good); // dead-lettered twice → second is a duplicate
    await dead('dwh-sync-scoring', score);
    const foreign = await dead('origination-notification', ev('ApplicationSubmitted', { applicationId: 'app-foreign', amount: 1, productId: 'p-1' }));
    const v2 = await dead('dwh-sync-application', { ...ev('ApplicationReturned', { applicationId: 'app-v2', levelNo: 1, comment: 'x' }), version: 2 });
    const broken = await dead('dwh-sync-bsa', {}, '{not json');

    const report = await replayDlq(redis, projector, { groups: ALL_GROUPS, dlqStream });
    expect(report).toEqual({ scanned: 5, applied: 2, duplicate: 1, skipped: 2, failed: 0, removed: 3 });
    expect(await factCount('app-r1')).toBe(1);
    expect((await pool.query(`SELECT selected_method FROM fact_application WHERE application_id = 'app-r1'`)).rows[0].selected_method).toBe('C');
    expect(await factCount('app-foreign')).toBe(0);
    expect((await remaining()).map((r) => r.id).sort()).toEqual([foreign, v2, broken].sort());
  });

  it('is idempotent: a second run finds nothing to apply; an event already in the DWH is a duplicate, not a double write', async () => {
    const e = ev('ApplicationReturned', { applicationId: 'app-r2', levelNo: 1, comment: 'c' });
    await projector.handle('dwh-sync-application', e); // the live consumer got it after all
    await dead('dwh-sync-application', e);
    expect(await replayDlq(redis, projector, { groups: ALL_GROUPS, dlqStream })).toMatchObject({ applied: 0, duplicate: 1, removed: 1 });
    expect(await replayDlq(redis, projector, { groups: ALL_GROUPS, dlqStream })).toMatchObject({ scanned: 0, removed: 0 });
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1', [e.eventId])).rows[0].n)).toBe(1);
  });

  it('honours --group and --since (DLQ entry time), and --dry-run writes and removes nothing', async () => {
    await dead('dwh-sync-application', ev('ApplicationSubmitted', { applicationId: 'app-old', amount: 1, productId: 'p-1' }));
    await new Promise((r) => setTimeout(r, 20));
    // Redis assigns entry IDs from its own clock — derive --since from the stored ID, not local Date.now()
    const newId = await dead('dwh-sync-application', ev('ApplicationSubmitted', { applicationId: 'app-new', amount: 1, productId: 'p-1' }));
    const sinceMs = Number(newId!.split('-')[0]);
    await dead('dwh-sync-scoring', ev('ScoringCompleted', { applicationId: 'app-new', selectedMethod: 'A', soscoScore: 1, dtiPercent: 1 }));

    expect(await replayDlq(redis, projector, { groups: ['dwh-sync-application'], sinceMs, dlqStream, dryRun: true })).toMatchObject({ scanned: 1, applied: 0, removed: 0 });
    expect(await factCount('app-new')).toBe(0);
    expect(await replayDlq(redis, projector, { groups: ['dwh-sync-application'], sinceMs, dlqStream })).toMatchObject({ scanned: 1, applied: 1, removed: 1 });
    expect(await factCount('app-new')).toBe(1);
    expect(await factCount('app-old')).toBe(0);
    expect((await remaining()).map((r) => r.group).sort()).toEqual(['dwh-sync-application', 'dwh-sync-scoring']);
  });

  it('pages through a DLQ larger than one batch', async () => {
    for (let i = 0; i < 7; i++) await dead('dwh-sync-application', ev('ApplicationReturned', { applicationId: `app-p${i}`, levelNo: 1, comment: 'c' }));
    expect(await replayDlq(redis, projector, { groups: ALL_GROUPS, dlqStream, batch: 3 })).toMatchObject({ scanned: 7, applied: 7, removed: 7 });
  });

  it('aborts on a DWH outage (transient) and keeps every entry, so a rerun can finish the job', async () => {
    await dead('dwh-sync-application', ev('ApplicationReturned', { applicationId: 'app-o', levelNo: 1, comment: 'c' }));
    const downDb = createDwhDatabase('postgresql://dwh:dwh@127.0.0.1:1/none_test', { max: 1 });
    try {
      await expect(replayDlq(redis, new DwhProjector(downDb), { groups: ALL_GROUPS, dlqStream })).rejects.toThrow(/DWH unavailable/);
    } finally { await downDb.close(); }
    expect(await remaining()).toHaveLength(1);
  });
});
