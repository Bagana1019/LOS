// Requirement-driven: CLAUDE.md §3.3 events → DWH star schema (§4), idempotent (§3.2.6), versioned (§3.2.5). Real DWH Postgres.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyDwhDdl, DWH_TEST_URL, wipeDwh } from '../../test-utils/dwh-db';
import { ev } from '../../test-utils/events';
import { createDwhDatabase, type DwhDatabase } from '../etl/dwh-database';
import { consumeOnceInDwh } from './consume-once';
import { DwhProjector } from './dwh-projector';

const APP = 'dwh-sync-application';
const T1 = '2026-11-01T15:00:00.000Z'; // UB 2026-11-01 23:00
const T2 = '2026-11-01T17:00:00.000Z'; // UB 2026-11-02 01:00
const T3 = '2026-11-03T02:00:00.000Z';

describe.skipIf(!DWH_TEST_URL)('DwhProjector (DWH Postgres)', () => {
  let pool: pg.Pool;
  let db: DwhDatabase;
  let projector: DwhProjector;
  const app = async (id = 'app-1') => (await pool.query('SELECT * FROM fact_application WHERE application_id = $1', [id])).rows[0];
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DWH_TEST_URL, max: 2 });
    await applyDwhDdl(pool);
    await applyDwhDdl(pool); // DDL (01 + 02) must be re-runnable on an existing DWH
    db = createDwhDatabase(DWH_TEST_URL);
    projector = new DwhProjector(db);
  });
  afterAll(async () => { await db?.close(); await pool?.end(); });
  beforeEach(async () => { await wipeDwh(pool); });

  describe('ApplicationSubmitted → fact_application + inferred dim_product', () => {
    it('creates the fact row with amount, product, submit time and Ulaanbaatar date key', async () => {
      expect(await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 5_000_000, productId: 'p-1' }, T2))).toBe('APPLIED');
      const r = await app();
      expect(r).toMatchObject({ org_id: 'org-1', status: 'SUBMITTED', amount: '5000000.00', product_id: 'p-1', submitted_date_key: 20261102 });
      expect(r.submitted_at.toISOString()).toBe(T2);
      const p = (await pool.query('SELECT * FROM dim_product')).rows;
      expect(p).toEqual([expect.objectContaining({ product_id: 'p-1', org_id: 'org-1', product_type: 'UNKNOWN' })]);
    });
    it('never overwrites a real dim_product row with the inferred stub', async () => {
      await pool.query(`INSERT INTO dim_product (product_id, org_id, code, name, product_type) VALUES ('p-1','org-1','AUTO','Автомашины зээл','LOAN')`);
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p-1' }));
      expect((await pool.query('SELECT code, name, product_type FROM dim_product')).rows).toEqual([{ code: 'AUTO', name: 'Автомашины зээл', product_type: 'LOAN' }]);
    });
    it('re-submission (RETURNED → SUBMITTED) takes the newer amount/product; an older replay does not revert it', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1_000, productId: 'p-1' }, T1));
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 2_000, productId: 'p-2' }, T3));
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 9_999, productId: 'p-9' }, T2));
      expect(await app()).toMatchObject({ amount: '2000.00', product_id: 'p-2' });
      expect((await app()).submitted_at.toISOString()).toBe(T3);
    });
  });

  describe('ApplicationStatusChanged → fact_application.status (last writer by occurredAt)', () => {
    it('updates status and ignores an older transition delivered late', async () => {
      await projector.handle(APP, ev('ApplicationStatusChanged', { applicationId: 'app-1', from: 'SUBMITTED', to: 'IN_APPROVAL' }, T3));
      await projector.handle(APP, ev('ApplicationStatusChanged', { applicationId: 'app-1', from: 'DRAFT', to: 'SUBMITTED' }, T1));
      expect(await app()).toMatchObject({ status: 'IN_APPROVAL', org_id: 'org-1' });
    });
    it('a later ApplicationSubmitted does not override a status that already moved on', async () => {
      await projector.handle(APP, ev('ApplicationStatusChanged', { applicationId: 'app-1', from: 'SUBMITTED', to: 'APPROVED' }, T3));
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 10, productId: 'p-1' }, T1));
      expect(await app()).toMatchObject({ status: 'APPROVED', amount: '10.00' });
    });
  });

  describe('ApplicationApproved / ApplicationReturned → decision timestamps', () => {
    it('Approved sets approved_at + decided_date_key, even before any status event (status stays NULL, not invented)', async () => {
      await projector.handle(APP, ev('ApplicationApproved', { applicationId: 'app-1', contractNo: 'C-1' }, T2));
      const r = await app();
      expect(r).toMatchObject({ status: null, decided_date_key: 20261102 });
      expect(r.approved_at.toISOString()).toBe(T2);
    });
    it('Returned keeps the latest return time', async () => {
      await projector.handle(APP, ev('ApplicationReturned', { applicationId: 'app-1', levelNo: 1, comment: 'x' }, T3));
      await projector.handle(APP, ev('ApplicationReturned', { applicationId: 'app-1', levelNo: 1, comment: 'y' }, T1));
      expect((await app()).returned_at.toISOString()).toBe(T3);
    });
  });

  describe('ScoringCompleted → fact_application scoring columns', () => {
    it('stores method, Sosco score and DTI as a fraction (41.2 % → 0.412); newer scoring wins', async () => {
      await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { applicationId: 'app-1', selectedMethod: 'B', soscoScore: 712.5, dtiPercent: 41.2 }, T3));
      await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { applicationId: 'app-1', selectedMethod: 'A', soscoScore: 1, dtiPercent: 1 }, T1));
      expect(await app()).toMatchObject({ selected_method: 'B', sosco_score: '712.50', dti: '0.4120', status: null });
    });
    it('keeps nulls as nulls', async () => {
      await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { applicationId: 'app-1', selectedMethod: 'A', soscoScore: null, dtiPercent: null }));
      expect(await app()).toMatchObject({ selected_method: 'A', sosco_score: null, dti: null });
    });
  });

  describe('DisbursementApproved → fact_disbursement', () => {
    it('stores amount, core loan id, disbursement date and copies product from fact_application', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p-1' }, T1));
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 4_500_000, coreLoanId: 'CORE-9' }, T2));
      const r = (await pool.query('SELECT * FROM fact_disbursement')).rows[0];
      expect(r).toMatchObject({ application_id: 'app-1', org_id: 'org-1', disbursed_amount: '4500000.00', core_loan_id: 'CORE-9', product_id: 'p-1', disbursed_date_key: 20261102 });
    });
    it('backfills product when the application fact arrives after the disbursement (separate groups)', async () => {
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 1, coreLoanId: null }, T2));
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p-1' }, T1));
      expect((await pool.query('SELECT product_id, core_loan_id FROM fact_disbursement')).rows).toEqual([{ product_id: 'p-1', core_loan_id: null }]);
    });
  });

  describe('StatementImported → fact_bsa_analysis', () => {
    it('COMPLETED creates the analysis fact', async () => {
      await projector.handle('dwh-sync-bsa', ev('StatementImported', { analysisId: 'bsa-1', applicationId: 'app-1', rows: 27, status: 'COMPLETED' }, T2));
      const r = (await pool.query('SELECT * FROM fact_bsa_analysis')).rows[0];
      expect(r).toMatchObject({ analysis_id: 'bsa-1', org_id: 'org-1', application_id: 'app-1', suspicion_count: 0 });
      expect(r.analyzed_at.toISOString()).toBe(T2);
    });
    it('FAILED imports are not analyses: no fact row, but the event is marked processed', async () => {
      expect(await projector.handle('dwh-sync-bsa', ev('StatementImported', { analysisId: 'bsa-1', applicationId: 'app-1', rows: 0, status: 'FAILED' }))).toBe('APPLIED');
      expect(await count('fact_bsa_analysis')).toBe(0);
      expect(await count('processed_events')).toBe(1);
    });
  });

  describe('idempotency (processed_events in the DWH)', () => {
    it('the same eventId twice applies once; the second delivery is DUPLICATE and changes nothing', async () => {
      const e = ev('ApplicationReturned', { applicationId: 'app-1', levelNo: 1, comment: 'x' }, T1);
      expect(await projector.handle(APP, e)).toBe('APPLIED');
      await pool.query(`UPDATE fact_application SET returned_at = NULL`);
      expect(await projector.handle(APP, e)).toBe('DUPLICATE');
      expect((await app()).returned_at).toBeNull();
      expect((await pool.query('SELECT consumer, event_id FROM processed_events')).rows).toEqual([{ consumer: APP, event_id: e.eventId }]);
    });
    it('markers are per consumer group', async () => {
      const e = ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p' });
      await projector.handle('group-a', e);
      expect(await projector.handle('group-b', e)).toBe('APPLIED');
      expect(await count('processed_events')).toBe(2);
    });
    it('a failing write rolls back the marker too, so redelivery can succeed', async () => {
      const e = ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p' });
      await expect(consumeOnceInDwh(db, APP, e.eventId, async (c) => { await c.query(`INSERT INTO dim_branch (branch_id, org_id, code, name) VALUES ('b','o','c','n')`); throw new Error('boom'); })).rejects.toThrow('boom');
      expect(await count('processed_events')).toBe(0);
      expect(await count('dim_branch')).toBe(0);
      expect(await consumeOnceInDwh(db, APP, e.eventId, async () => {})).toBe(true);
      expect(await consumeOnceInDwh(db, APP, e.eventId, async () => {})).toBe(false);
    });
  });

  describe('validation and versioning', () => {
    it('unknown version → SKIPPED: no write, no marker, no throw', async () => {
      const e = { ...ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p' }), version: 2 };
      expect(await projector.handle(APP, e)).toBe('SKIPPED');
      expect(await count('fact_application')).toBe(0);
      expect(await count('processed_events')).toBe(0);
    });
    it('schema-invalid payload and catalog events without a DWH target → SKIPPED', async () => {
      expect(await projector.handle(APP, { ...ev('ApplicationSubmitted', { applicationId: 'a', amount: 1, productId: 'p' }), amount: 'lots' })).toBe('SKIPPED');
      expect(await projector.handle(APP, ev('KycCompleted', { applicationId: 'a', customerId: 'c', blacklisted: false }))).toBe('SKIPPED');
      expect(await count('fact_application')).toBe(0);
    });
    it('PII: no event writes dim_customer (register numbers / names never reach the DWH)', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { applicationId: 'app-1', amount: 1, productId: 'p' }));
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 1, coreLoanId: 'x' }));
      expect(await count('dim_customer')).toBe(0);
    });
  });
});
