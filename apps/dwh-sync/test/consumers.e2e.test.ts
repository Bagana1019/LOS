// End-to-end: Redis Streams → dwh-sync consumer groups → DWH Postgres, plus /api/health/ready reflecting consumer status.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createRedisEventBus, type EventBus } from '@los/database';
import { Redis } from 'ioredis';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { DWH_EVENT_BUS } from '../src/modules/consumers/consumers.module';
import { DWH_SUBSCRIPTIONS } from '../src/modules/consumers/decode';
import { applyDwhDdl, DWH_TEST_URL, wipeDwh } from '../src/test-utils/dwh-db';
import { ev } from '../src/test-utils/events';

const REDIS_URL = process.env.REDIS_URL ?? '';
const waitFor = async (fn: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return;
  throw new Error('timed out');
};

async function boot(bus: EventBus | null): Promise<INestApplication> {
  const app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DWH_EVENT_BUS).useValue(bus).compile()).createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

describe.skipIf(!DWH_TEST_URL || !REDIS_URL)('dwh-sync consumers (Redis + DWH)', () => {
  const stream = `los:events:dwh-e2e-${randomUUID()}`;
  let pool: pg.Pool;
  let publisher: EventBus;
  let redis: Redis;
  let app: INestApplication;
  const one = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows[0];

  beforeAll(async () => {
    process.env.DWH_DATABASE_URL = DWH_TEST_URL;
    pool = new pg.Pool({ connectionString: DWH_TEST_URL, max: 2 });
    await applyDwhDdl(pool);
    await wipeDwh(pool);
    publisher = createRedisEventBus(REDIS_URL, { stream });
    redis = new Redis(REDIS_URL);
    app = await boot(createRedisEventBus(REDIS_URL, { stream }));
  });
  afterAll(async () => {
    await app?.close();
    await publisher?.close();
    await redis?.del(stream, `${stream}:dlq`);
    redis?.disconnect();
    await pool?.end();
  });

  it('projects published events into the facts through every dwh-sync-* group', async () => {
    const id = `app-${randomUUID()}`;
    await publisher.publish(ev('ApplicationSubmitted', { applicationId: id, amount: 3_000_000, productId: 'p-1' }));
    await publisher.publish(ev('ScoringCompleted', { applicationId: id, selectedMethod: 'C', soscoScore: 650, dtiPercent: 30 }));
    await publisher.publish(ev('DisbursementApproved', { applicationId: id, amount: 3_000_000, coreLoanId: 'CORE-1' }));
    await publisher.publish(ev('StatementImported', { analysisId: `bsa-${id}`, applicationId: id, rows: 10, status: 'COMPLETED' }));
    await waitFor(async () => (await one('SELECT selected_method FROM fact_application WHERE application_id = $1', [id]))?.selected_method === 'C');
    await waitFor(async () => !!(await one('SELECT 1 FROM fact_disbursement WHERE application_id = $1', [id])));
    await waitFor(async () => !!(await one('SELECT 1 FROM fact_bsa_analysis WHERE application_id = $1', [id])));
    expect(await one('SELECT status, amount FROM fact_application WHERE application_id = $1', [id])).toEqual({ status: 'SUBMITTED', amount: '3000000.00' });
    const groups = (await pool.query('SELECT DISTINCT consumer FROM processed_events ORDER BY consumer')).rows.map((r) => r.consumer);
    expect(groups).toEqual(DWH_SUBSCRIPTIONS.map((s) => s.group).sort());
  });

  it('a redelivered event (same eventId) is applied once', async () => {
    const e = ev('ApplicationReturned', { applicationId: `app-${randomUUID()}`, levelNo: 1, comment: 'x' });
    await publisher.publish(e);
    await publisher.publish(e);
    await waitFor(async () => !!(await one('SELECT 1 FROM fact_application WHERE application_id = $1', [e.applicationId])));
    await new Promise((r) => setTimeout(r, 1500));
    expect(Number((await one('SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1', [e.eventId])).n)).toBe(1);
  });

  it('an unknown-version message does not stop the consumer: later events still land and health stays up', async () => {
    const bad = { ...ev('ApplicationStatusChanged', { applicationId: 'app-v2', from: 'DRAFT', to: 'SUBMITTED' }), version: 2 };
    await redis.xadd(stream, '*', 'eventId', bad.eventId, 'type', bad.type, 'payload', JSON.stringify(bad));
    const good = ev('ApplicationStatusChanged', { applicationId: `app-${randomUUID()}`, from: 'DRAFT', to: 'SUBMITTED' });
    await publisher.publish(good);
    await waitFor(async () => !!(await one('SELECT 1 FROM fact_application WHERE application_id = $1', [good.applicationId])));
    expect(await one(`SELECT 1 AS x FROM fact_application WHERE application_id = 'app-v2'`)).toBeUndefined();
    const res = await request(app.getHttpServer()).get('/api/health/ready');
    expect(res.status).toBe(200);
  });

  it('/api/health/ready reports the DWH, Redis and every consumer group as up', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ dwh: 'up', 'dwh-schema': 'up', redis: 'up', ...Object.fromEntries(DWH_SUBSCRIPTIONS.map((s) => [`consumer:${s.group}`, 'up'])) });
  });

  it('/api/consumers/status reports schema version and per-group subscription + dead-letter counts (information, not readiness)', async () => {
    const res = await request(app.getHttpServer()).get('/api/consumers/status');
    expect(res.status).toBe(200);
    expect(res.body.schema).toEqual({ ready: true, version: 4, required: 4 });
    expect(res.body.busEnabled).toBe(true);
    for (const s of DWH_SUBSCRIPTIONS) expect(res.body.groups[s.group]).toMatchObject({ subscribed: true, deadLettered: 0 });
  });

  it('without an event bus the service still boots but readiness is 503 with every consumer down', async () => {
    const noBus = await boot(null);
    try {
      const res = await request(noBus.getHttpServer()).get('/api/health/ready');
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain('"consumer:dwh-sync-application":"down"');
      expect((await request(noBus.getHttpServer()).get('/api/health')).status).toBe(200);
    } finally { await noBus.close(); }
  });
});

// MEDIUM (C3): an existing DWH volume (initdb already ran, so 02-event-ordering.sql never did) is brought up to date by dwh-sync itself.
describe.skipIf(!DWH_TEST_URL || !REDIS_URL)('dwh-sync startup DDL on an existing, outdated DWH', () => {
  const stream = `los:events:dwh-e2e-ddl-${randomUUID()}`;
  let pool: pg.Pool;
  let app: INestApplication;
  let publisher: EventBus;
  beforeAll(async () => {
    process.env.DWH_DATABASE_URL = DWH_TEST_URL;
    pool = new pg.Pool({ connectionString: DWH_TEST_URL, max: 2 });
    await applyDwhDdl(pool);
    // simulate a pre-02 volume: no version table, no ordering columns
    await pool.query('DROP TABLE IF EXISTS dwh_schema_version');
    await pool.query('ALTER TABLE fact_application DROP COLUMN IF EXISTS status_changed_at, DROP COLUMN IF EXISTS scored_at');
    publisher = createRedisEventBus(REDIS_URL, { stream });
    app = await boot(createRedisEventBus(REDIS_URL, { stream }));
  });
  afterAll(async () => {
    await app?.close();
    await publisher?.close();
    const r = new Redis(REDIS_URL); await r.del(stream, `${stream}:dlq`); r.disconnect();
    await pool?.end();
  });

  it('adds the missing columns at startup, records the version, is ready, and events that need them land', async () => {
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'fact_application'`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['status_changed_at', 'scored_at']));
    expect((await pool.query('SELECT version FROM dwh_schema_version ORDER BY version')).rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect((await request(app.getHttpServer()).get('/api/health/ready')).status).toBe(200);
    const id = `app-${randomUUID()}`;
    await publisher.publish(ev('ApplicationStatusChanged', { applicationId: id, from: 'DRAFT', to: 'SUBMITTED' }));
    await waitFor(async () => (await pool.query('SELECT status_changed_at FROM fact_application WHERE application_id = $1', [id])).rows[0]?.status_changed_at != null);
  });
});

describe.skipIf(!REDIS_URL)('dwh-sync with the DWH unreachable at startup', () => {
  it('boots, readiness is 503 with dwh and dwh-schema down, and no consumer group subscribes (messages stay unread)', async () => {
    const prev = process.env.DWH_DATABASE_URL;
    process.env.DWH_DATABASE_URL = 'postgresql://dwh:dwh@127.0.0.1:1/unreachable_test';
    const stream = `los:events:dwh-e2e-down-${randomUUID()}`;
    const down = await boot(createRedisEventBus(REDIS_URL, { stream }));
    try {
      const res = await request(down.getHttpServer()).get('/api/health/ready');
      expect(res.status).toBe(503);
      for (const check of ['"dwh":"down"', '"dwh-schema":"down"', '"consumer:dwh-sync-application":"down"']) expect(JSON.stringify(res.body)).toContain(check);
      const status = await request(down.getHttpServer()).get('/api/consumers/status');
      expect(status.body.schema).toMatchObject({ ready: false, error: expect.stringContaining('ECONNREFUSED') });
      const r = new Redis(REDIS_URL);
      try { expect(await r.exists(stream)).toBe(0); } finally { r.disconnect(); }
    } finally {
      await down.close();
      process.env.DWH_DATABASE_URL = prev;
    }
  });
});
