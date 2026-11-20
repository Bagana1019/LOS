// MEDIUM (C3): Postgres initdb runs packages/database/dwh/init only on an EMPTY volume. dwh-sync therefore applies the DDL its writers
// need at startup: versioned (dwh_schema_version), one transaction, pg_advisory_xact_lock so two pods never race. The SQL files stay the
// single source (they are idempotent, so re-applying them on a DWH that initdb already built is safe). Readiness is down until done.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DWH_DATABASE, type DwhDatabase } from './dwh-database';

export interface DwhMigration { readonly version: number; readonly name: string; readonly sql: string }

/** Append-only. The writers in fact-writers.ts require every version listed here. */
const MIGRATION_FILES: readonly { version: number; file: string }[] = [
  { version: 1, file: '01-star-schema.sql' },
  { version: 2, file: '02-event-ordering.sql' },
  { version: 3, file: '03-fact-dimensions.sql' },
  { version: 4, file: '04-total-income-view.sql' },
];
export const REQUIRED_DWH_SCHEMA_VERSION = MIGRATION_FILES[MIGRATION_FILES.length - 1]!.version;
/** Same relative depth from src/modules/etl and dist/modules/etl; the Docker image copies the whole repo (packages/config/Dockerfile.nest). */
const DEFAULT_DDL_DIR = resolve(__dirname, '../../../../../packages/database/dwh/init');
const LOCK_KEY = 'dwh-sync:schema';

export function loadDwhMigrations(dir = process.env.DWH_DDL_DIR || DEFAULT_DDL_DIR): DwhMigration[] {
  return MIGRATION_FILES.map(({ version, file }) => {
    const path = resolve(dir, file);
    if (!existsSync(path)) throw new Error(`DWH DDL file ${path} not found (set DWH_DDL_DIR)`);
    return { version, name: file, sql: readFileSync(path, 'utf8') };
  });
}

/** Applies every migration newer than the recorded version, all-or-nothing. Returns the versions applied now and the resulting version. */
export async function migrateDwhSchema(db: DwhDatabase, migrations: readonly DwhMigration[]): Promise<{ applied: number[]; version: number }> {
  return db.transaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    await c.query('CREATE TABLE IF NOT EXISTS dwh_schema_version (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await c.query('SELECT COALESCE(max(version), 0)::int AS v FROM dwh_schema_version');
    const current = Number(rows[0]?.v ?? 0);
    const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version > current);
    for (const m of pending) {
      await c.query(m.sql);
      await c.query('INSERT INTO dwh_schema_version (version, name) VALUES ($1, $2)', [m.version, m.name]);
    }
    return { applied: pending.map((m) => m.version), version: Math.max(current, ...pending.map((m) => m.version)) };
  });
}

const describeError = (err: unknown) => {
  const e = err as { code?: unknown; message?: unknown } | null;
  return [typeof e?.code === 'string' ? e.code : '', typeof e?.message === 'string' ? e.message : String(err)].filter(Boolean).join(' ').slice(0, 300);
};

export interface DwhSchemaStatus { readonly ready: boolean; readonly version: number | null; readonly required: number; readonly error?: string }

@Injectable()
export class DwhSchemaService {
  private readonly log = new Logger('DwhSchema');
  private state: DwhSchemaStatus = { ready: false, version: null, required: REQUIRED_DWH_SCHEMA_VERSION, error: 'not migrated yet' };
  private inFlight: Promise<boolean> | null = null;

  constructor(@Inject(DWH_DATABASE) private readonly db: DwhDatabase) {}

  /** Brings the DWH up to date; `false` (reason in status()/assertReady) instead of throwing. Single-flight; a no-op once ready. */
  ensure(): Promise<boolean> {
    if (this.state.ready) return Promise.resolve(true);
    this.inFlight ??= this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  assertReady(): void {
    if (!this.state.ready) throw new Error(`DWH schema not ready (required v${this.state.required}): ${this.state.error ?? 'unknown'}`);
  }

  status(): DwhSchemaStatus { return this.state; }

  private async run(): Promise<boolean> {
    try {
      const { applied, version } = await migrateDwhSchema(this.db, loadDwhMigrations());
      this.state = { ready: version >= REQUIRED_DWH_SCHEMA_VERSION, version, required: REQUIRED_DWH_SCHEMA_VERSION };
      if (applied.length) this.log.log(`DWH schema migrated to v${version} (applied ${applied.join(', ')})`);
      return this.state.ready;
    } catch (err) {
      this.state = { ...this.state, ready: false, error: describeError(err) };
      this.log.error(`DWH schema not ready: ${this.state.error}`);
      return false;
    }
  }
}
