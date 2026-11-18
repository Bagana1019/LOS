// DWH test database helper: applies the real DDL (packages/database/dwh/init/*.sql, in order) and wipes rows between tests.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export const DWH_TEST_URL = process.env.DWH_TEST_DATABASE_URL ?? '';
const DDL_DIR = resolve(__dirname, '../../../../packages/database/dwh/init');

export async function applyDwhDdl(pool: pg.Pool): Promise<void> {
  for (const f of readdirSync(DDL_DIR).filter((n) => n.endsWith('.sql')).sort()) await pool.query(readFileSync(resolve(DDL_DIR, f), 'utf8'));
}

export async function wipeDwh(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE fact_application, fact_disbursement, fact_bsa_analysis, dim_customer, dim_product, dim_branch, processed_events');
}
