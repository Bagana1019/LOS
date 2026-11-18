// Thin pg wrapper for the DWH Postgres (separate instance, CLAUDE.md §5). Only the DWH — never the operational DB.
import { Logger } from '@nestjs/common';
import pg from 'pg';

export interface DwhClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface DwhDatabase {
  /** Runs `fn` in one transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  transaction<T>(fn: (c: DwhClient) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
export const DWH_DATABASE = Symbol('DWH_DATABASE');

/** A blackholed DWH must fail fast (transient → retried), not hang a consumer or the startup migration. */
const CONNECT_TIMEOUT_MS = 5_000;

export function createDwhDatabase(url: string, opts: { max?: number } = {}): DwhDatabase {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  const log = new Logger('DwhDatabase');
  // An idle client dropping (DWH restart) must not crash the process; the next query reconnects.
  pool.on('error', (err) => log.error(`idle DWH connection error: ${err.message}`));
  return {
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async ping() { await pool.query('SELECT 1'); },
    async close() { await pool.end(); },
  };
}
