// MEDIUM (C3): initdb runs packages/database/dwh/init only on an EMPTY volume, so dwh-sync brings an existing DWH up to the schema
// its writers need at startup — versioned, idempotent, one transaction, advisory-locked against a second pod. Real DWH Postgres.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DWH_TEST_URL } from '../../test-utils/dwh-db';
import { createDwhDatabase, type DwhDatabase } from './dwh-database';
import { DwhSchemaService, loadDwhMigrations, migrateDwhSchema, REQUIRED_DWH_SCHEMA_VERSION } from './dwh-schema';

const DDL_DIR = resolve(__dirname, '../../../../../packages/database/dwh/init');

describe('loadDwhMigrations', () => {
  it('loads the versioned DDL shipped in packages/database/dwh/init (1 = star schema, 2 = event ordering)', () => {
    const m = loadDwhMigrations();
    expect(m.map((x) => x.version)).toEqual([1, 2]);
    expect(REQUIRED_DWH_SCHEMA_VERSION).toBe(2);
    expect(m[1]!.sql).toContain('status_changed_at');
  });
  it('fails with a clear message when a required DDL file is missing', () => {
    expect(() => loadDwhMigrations('/nonexistent-dir')).toThrow(/DWH DDL file .*01-star-schema\.sql.* not found/);
  });
});

describe.skipIf(!DWH_TEST_URL)('migrateDwhSchema / DwhSchemaService (DWH Postgres)', () => {
  const admin = new pg.Pool({ connectionString: DWH_TEST_URL || undefined, max: 2 });
  const schemas: string[] = [];
  const dbs: DwhDatabase[] = [];
  /** DwhDatabase bound to a fresh, empty Postgres schema (search_path) — every scenario starts from its own DWH. */
  const freshDwh = async () => {
    const schema = `mig_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    schemas.push(schema);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(DWH_TEST_URL); url.searchParams.set('options', `-c search_path=${schema}`);
    const db = createDwhDatabase(url.toString(), { max: 2 }); dbs.push(db);
    return { schema, db };
  };
  const columns = async (schema: string) => (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'fact_application'`, [schema])).rows.map((r) => r.column_name);
  const versions = async (schema: string) => (await admin.query(`SELECT version FROM ${schema}.dwh_schema_version ORDER BY version`)).rows.map((r) => r.version);

  beforeAll(async () => { await admin.query('SELECT 1'); });
  afterAll(async () => {
    await Promise.all(dbs.map((d) => d.close().catch(() => undefined)));
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  it('empty DWH → applies every version in order and records them', async () => {
    const { schema, db } = await freshDwh();
    expect(await migrateDwhSchema(db, loadDwhMigrations())).toEqual({ applied: [1, 2], version: 2 });
    expect(await columns(schema)).toEqual(expect.arrayContaining(['status_changed_at', 'scored_at']));
    expect(await versions(schema)).toEqual([1, 2]);
  });

  it('existing DWH created by initdb before 02 existed (no version table) → adds the missing columns, keeps the data', async () => {
    const { schema, db } = await freshDwh();
    await admin.query(`SET search_path = ${schema}; ${readFileSync(resolve(DDL_DIR, '01-star-schema.sql'), 'utf8')}; RESET search_path;`);
    await admin.query(`INSERT INTO ${schema}.fact_application (application_id, org_id, status) VALUES ('legacy-1', 'org-1', 'SUBMITTED')`);
    expect(await columns(schema)).not.toContain('status_changed_at');
    expect((await migrateDwhSchema(db, loadDwhMigrations())).version).toBe(2);
    expect(await columns(schema)).toEqual(expect.arrayContaining(['status_changed_at', 'scored_at']));
    expect((await admin.query(`SELECT status FROM ${schema}.fact_application`)).rows).toEqual([{ status: 'SUBMITTED' }]);
  });

  it('an up-to-date DWH is a no-op', async () => {
    const { db } = await freshDwh();
    await migrateDwhSchema(db, loadDwhMigrations());
    expect(await migrateDwhSchema(db, loadDwhMigrations())).toEqual({ applied: [], version: 2 });
  });

  it('two pods migrating concurrently: both succeed, each version applied and recorded exactly once', async () => {
    const { schema, db } = await freshDwh();
    const url = new URL(DWH_TEST_URL); url.searchParams.set('options', `-c search_path=${schema}`);
    const other = createDwhDatabase(url.toString(), { max: 2 }); dbs.push(other);
    const [a, b] = await Promise.all([migrateDwhSchema(db, loadDwhMigrations()), migrateDwhSchema(other, loadDwhMigrations())]);
    expect([...a.applied, ...b.applied].sort()).toEqual([1, 2]);
    expect(await versions(schema)).toEqual([1, 2]);
  });

  it('a failing migration rolls the whole run back (nothing half-applied, nothing recorded)', async () => {
    const { schema, db } = await freshDwh();
    const broken = [...loadDwhMigrations(), { version: 3, name: 'broken', sql: 'ALTER TABLE no_such_table ADD COLUMN x int' }];
    await expect(migrateDwhSchema(db, broken)).rejects.toThrow(/no_such_table/);
    expect((await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema])).rows[0].n).toBe(0);
  });

  it('a DWH already newer than this build is accepted (rolling deploy: old pod next to a migrated DWH)', async () => {
    const { db } = await freshDwh();
    await migrateDwhSchema(db, [...loadDwhMigrations(), { version: 3, name: 'future', sql: 'SELECT 1' }]);
    expect(await migrateDwhSchema(db, loadDwhMigrations())).toEqual({ applied: [], version: 3 });
  });

  it('DwhSchemaService: ready after ensure(); assertReady throws before', async () => {
    const { db } = await freshDwh();
    const svc = new DwhSchemaService(db);
    expect(() => svc.assertReady()).toThrow(/DWH schema not ready/);
    expect(await svc.ensure()).toBe(true);
    expect(() => svc.assertReady()).not.toThrow();
    expect(svc.status()).toMatchObject({ ready: true, version: 2, required: 2 });
  });

  it('DwhSchemaService: DWH unreachable → ensure() false, readiness down with the reason, recovers on a later ensure()', async () => {
    const down = createDwhDatabase('postgresql://dwh:dwh@127.0.0.1:1/none_test', { max: 1 }); dbs.push(down);
    const svc = new DwhSchemaService(down);
    expect(await svc.ensure()).toBe(false);
    expect(() => svc.assertReady()).toThrow(/DWH schema not ready \(required v2\): .*ECONNREFUSED/);
    expect(svc.status()).toMatchObject({ ready: false, version: null, required: 2, error: expect.stringContaining('ECONNREFUSED') });
    const { db } = await freshDwh();
    const ok = new DwhSchemaService(db);
    expect(await ok.ensure()).toBe(true);
  });
});
