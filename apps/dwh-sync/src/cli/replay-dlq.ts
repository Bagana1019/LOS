// HIGH (C3): replay events the bus dead-lettered (`los:events:dlq`) for the dwh-sync-* groups into the DWH.
// Applied through DwhProjector (processed_events → idempotent, safe to rerun); never re-XADDs to los:events, which would redeliver the
// event to every other service's consumer groups. Applied/duplicate entries are removed from the DLQ; skipped (invalid/unsupported
// version) and failed ones stay. Other services' DLQ entries are never read.
//   node apps/dwh-sync/dist/cli/replay-dlq.js [--group dwh-sync-application ...] [--since 2026-11-18T00:00:00Z|<epoch ms>] [--dry-run]
//   env: REDIS_URL, DWH_DATABASE_URL (DATABASE_URL optional, only to refuse the operational DB)
import { parseArgs } from 'node:util';
import { DEAD_LETTER_STREAM } from '@los/database';
import { Redis } from 'ioredis';
import { DWH_SUBSCRIPTIONS } from '../modules/consumers/decode';
import { DwhProjector } from '../modules/consumers/dwh-projector';
import { resolveDwhUrl } from '../modules/etl/dwh-config';
import { createDwhDatabase } from '../modules/etl/dwh-database';
import { DwhSchemaService } from '../modules/etl/dwh-schema';
import { isTransientDwhError } from '../modules/consumers/transient-error';

const DWH_GROUPS = DWH_SUBSCRIPTIONS.map((s) => s.group);
const DEFAULT_BATCH = 100;

export interface ReplayOptions { readonly groups: readonly string[]; readonly sinceMs?: number; readonly dryRun?: boolean; readonly dlqStream?: string; readonly batch?: number }
export interface ReplayReport { scanned: number; applied: number; duplicate: number; skipped: number; failed: number; removed: number }

export function parseReplayArgs(argv: readonly string[]): { groups: string[]; sinceMs: number | undefined; dryRun: boolean } {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { group: { type: 'string', multiple: true }, since: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const groups = values.group?.length ? values.group : DWH_GROUPS;
  for (const g of groups) if (!DWH_GROUPS.includes(g)) throw new Error(`"${g}" is not a dwh-sync consumer group (${DWH_GROUPS.join(', ')})`);
  let sinceMs: number | undefined;
  if (values.since !== undefined) {
    sinceMs = /^\d+$/.test(values.since) ? Number(values.since) : Date.parse(values.since);
    if (!Number.isFinite(sinceMs)) throw new Error(`--since must be an ISO timestamp or epoch ms, got "${values.since}"`);
  }
  return { groups: [...groups], sinceMs, dryRun: values['dry-run'] === true };
}

const toMap = (f: string[]) => { const m: Record<string, string> = {}; for (let i = 0; i + 1 < f.length; i += 2) m[f[i]!] = f[i + 1]!; return m; };
const parsePayload = (s: string | undefined): unknown => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };

export async function replayDlq(redis: Redis, projector: Pick<DwhProjector, 'handle'>, opts: ReplayOptions): Promise<ReplayReport> {
  const stream = opts.dlqStream ?? DEAD_LETTER_STREAM;
  const wanted = new Set(opts.groups);
  const batch = opts.batch ?? DEFAULT_BATCH;
  const report: ReplayReport = { scanned: 0, applied: 0, duplicate: 0, skipped: 0, failed: 0, removed: 0 };
  let start = opts.sinceMs !== undefined ? `${opts.sinceMs}-0` : '-';
  for (;;) {
    const entries = await redis.xrange(stream, start, '+', 'COUNT', batch);
    for (const [id, fields] of entries) {
      const m = toMap(fields);
      if (!m.group || !wanted.has(m.group)) continue;
      report.scanned++;
      if (opts.dryRun) continue;
      let outcome: Awaited<ReturnType<DwhProjector['handle']>>;
      try {
        outcome = await projector.handle(m.group, parsePayload(m.payload));
      } catch (err) {
        if (isTransientDwhError(err)) throw new Error(`DWH unavailable, replay aborted (rerun later): ${err instanceof Error ? err.message : String(err)}`);
        report.failed++;
        continue;
      }
      if (outcome === 'SKIPPED') { report.skipped++; continue; }
      if (outcome === 'APPLIED') report.applied++; else report.duplicate++;
      report.removed += await redis.xdel(stream, id);
    }
    if (entries.length < batch) return report;
    start = `(${entries[entries.length - 1]![0]}`;
  }
}

async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const db = createDwhDatabase(resolveDwhUrl(process.env), { max: 2 });
  try {
    const schema = new DwhSchemaService(db);
    if (!(await schema.ensure())) throw new Error(schema.status().error ?? 'DWH schema not ready');
    const report = await replayDlq(redis, new DwhProjector(db), args);
    process.stdout.write(`${JSON.stringify({ ...args, ...report })}\n`);
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    redis.disconnect();
    await db.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`replay-dlq failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
