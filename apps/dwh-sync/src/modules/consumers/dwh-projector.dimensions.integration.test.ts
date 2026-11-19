// N4 requirement-driven: fact dimensions (branch / customer / officer / rate / term / DSCR / LTV / BSA metrics) come ONLY from the
// event payload (CLAUDE.md §3.2.2); v1 events already in the stream without them still project; occurredAt guards still hold. Real DWH Postgres.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyDwhDdl, DWH_TEST_URL, wipeDwh } from '../../test-utils/dwh-db';
import { ev } from '../../test-utils/events';
import { createDwhDatabase, type DwhDatabase } from '../etl/dwh-database';
import { DwhProjector } from './dwh-projector';

const APP = 'dwh-sync-application';
const T1 = '2026-11-01T15:00:00.000Z';
const T2 = '2026-11-01T17:00:00.000Z';
const T3 = '2026-11-03T02:00:00.000Z';
const SUBMIT_OLD = { applicationId: 'app-1', amount: 5_000_000, productId: 'p-1' };
const SUBMIT_DIMS = { branchId: 'b-1', officerId: 'u-7', customerId: 'c-1', interestRatePercent: 23.99, termMonths: 12 };
const SCORE_OLD = { applicationId: 'app-1', selectedMethod: 'B_BUSINESS', soscoScore: 712, dtiPercent: 41.5 };
const BSA_OLD = { analysisId: 'an-1', applicationId: 'app-1', rows: 120, status: 'COMPLETED' as const };
const BSA_METRICS = { customerId: 'c-1', periodMonths: 6, monthlyIncome: 3_200_000, netCashFlowMonthly: 900_000.5, dtiPercent: 38.2, dtiLevel: 'MEDIUM' as const, pendingSuspiciousCount: 2 };

describe.skipIf(!DWH_TEST_URL)('DwhProjector — N4 fact dimensions (DWH Postgres)', () => {
  let pool: pg.Pool;
  let db: DwhDatabase;
  let projector: DwhProjector;
  const row = async (table: string, key: string, id: string) => (await pool.query(`SELECT * FROM ${table} WHERE ${key} = $1`, [id])).rows[0];
  const app = () => row('fact_application', 'application_id', 'app-1');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DWH_TEST_URL, max: 2 });
    await applyDwhDdl(pool);
    await applyDwhDdl(pool); // 01 + 02 + 03 re-runnable
    db = createDwhDatabase(DWH_TEST_URL);
    projector = new DwhProjector(db);
  });
  afterAll(async () => { await db?.close(); await pool?.end(); });
  beforeEach(async () => { await wipeDwh(pool); });

  describe('ApplicationSubmitted', () => {
    it('enriched payload lands branch, officer, primary customer, rate (fraction) and term', async () => {
      expect(await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }, T2))).toBe('APPLIED');
      expect(await app()).toMatchObject({ branch_id: 'b-1', officer_id: 'u-7', customer_id: 'c-1', interest_rate: '0.2399', term_months: 12, product_id: 'p-1', status: 'SUBMITTED' });
    });
    it('creates inferred dim_branch / dim_customer members (ids only, no PII) so the FKs hold', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }));
      expect((await pool.query('SELECT branch_id, org_id, code, name FROM dim_branch')).rows).toEqual([{ branch_id: 'b-1', org_id: 'org-1', code: 'b-1', name: 'b-1' }]);
      expect((await pool.query('SELECT customer_id, org_id, customer_type, gender, birth_year FROM dim_customer')).rows)
        .toEqual([{ customer_id: 'c-1', org_id: 'org-1', customer_type: 'UNKNOWN', gender: null, birth_year: null }]);
    });
    it('never overwrites real dimension rows with the inferred stubs', async () => {
      await pool.query(`INSERT INTO dim_branch (branch_id, org_id, code, name) VALUES ('b-1','org-1','UB01','Төв салбар')`);
      await pool.query(`INSERT INTO dim_customer (customer_id, org_id, customer_type, segment) VALUES ('c-1','org-1','INDIVIDUAL','RETAIL')`);
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }));
      expect((await pool.query('SELECT code, name FROM dim_branch')).rows).toEqual([{ code: 'UB01', name: 'Төв салбар' }]);
      expect((await pool.query('SELECT customer_type, segment FROM dim_customer')).rows).toEqual([{ customer_type: 'INDIVIDUAL', segment: 'RETAIL' }]);
    });
    it('old v1 payload (already in the stream) still projects; the new columns stay NULL and no stub dims appear', async () => {
      expect(await projector.handle(APP, ev('ApplicationSubmitted', SUBMIT_OLD, T2))).toBe('APPLIED');
      expect(await app()).toMatchObject({ amount: '5000000.00', branch_id: null, officer_id: null, customer_id: null, interest_rate: null, term_months: null });
      expect(Number((await pool.query('SELECT count(*) AS n FROM dim_branch')).rows[0].n) + Number((await pool.query('SELECT count(*) AS n FROM dim_customer')).rows[0].n)).toBe(0);
    });
    it('system-created application (officerId null) and missing primary borrower keep officer/customer NULL', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS, officerId: null, customerId: null }));
      expect(await app()).toMatchObject({ branch_id: 'b-1', officer_id: null, customer_id: null });
    });
    it('an older submission delivered late cannot overwrite the newer re-submission (rate/term/dims)', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS, interestRatePercent: 21, termMonths: 24 }, T3));
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS, branchId: 'b-9', officerId: 'u-9', interestRatePercent: 30, termMonths: 6 }, T1));
      expect(await app()).toMatchObject({ branch_id: 'b-1', officer_id: 'u-7', interest_rate: '0.2100', term_months: 24 });
    });
    it('a newer re-submission replaces rate/term; a newer payload without dimension keys does not erase known keys', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }, T1));
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, amount: 6_000_000 }, T3));
      expect(await app()).toMatchObject({ amount: '6000000.00', branch_id: 'b-1', officer_id: 'u-7', customer_id: 'c-1', interest_rate: null, term_months: null });
    });
    it('a status event arriving first does not block the dimensions, and status stays last-writer-wins', async () => {
      await projector.handle(APP, ev('ApplicationStatusChanged', { applicationId: 'app-1', from: 'SUBMITTED', to: 'IN_APPROVAL' }, T3));
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }, T2));
      expect(await app()).toMatchObject({ status: 'IN_APPROVAL', branch_id: 'b-1', term_months: 12 });
    });
    it('backfills branch/customer on a fact_disbursement that an old-shape DisbursementApproved created first', async () => {
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 5_000_000, coreLoanId: 'CORE-1' }, T3));
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }, T1));
      expect(await row('fact_disbursement', 'application_id', 'app-1')).toMatchObject({ branch_id: 'b-1', customer_id: 'c-1', product_id: 'p-1' });
    });
  });

  describe('DisbursementApproved', () => {
    it('enriched payload sets branch/product/customer directly, even before fact_application exists', async () => {
      expect(await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 5_000_000, coreLoanId: 'CORE-1', branchId: 'b-1', productId: 'p-1', customerId: 'c-1' }, T3))).toBe('APPLIED');
      expect(await row('fact_disbursement', 'application_id', 'app-1')).toMatchObject({ branch_id: 'b-1', product_id: 'p-1', customer_id: 'c-1', disbursed_amount: '5000000.00' });
      expect((await pool.query('SELECT product_type FROM dim_product')).rows).toEqual([{ product_type: 'UNKNOWN' }]);
    });
    it('old v1 payload still copies the keys from fact_application (unchanged behaviour)', async () => {
      await projector.handle(APP, ev('ApplicationSubmitted', { ...SUBMIT_OLD, ...SUBMIT_DIMS }, T1));
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 1, coreLoanId: null }, T3));
      expect(await row('fact_disbursement', 'application_id', 'app-1')).toMatchObject({ branch_id: 'b-1', product_id: 'p-1', customer_id: 'c-1' });
    });
    it('an older disbursement replay cannot overwrite the newer one', async () => {
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 2, coreLoanId: 'NEW', branchId: 'b-1', productId: 'p-1', customerId: 'c-1' }, T3));
      await projector.handle('dwh-sync-disbursement', ev('DisbursementApproved', { applicationId: 'app-1', amount: 1, coreLoanId: 'OLD', branchId: 'b-9', productId: 'p-9', customerId: 'c-9' }, T1));
      expect(await row('fact_disbursement', 'application_id', 'app-1')).toMatchObject({ core_loan_id: 'NEW', branch_id: 'b-1', product_id: 'p-1', customer_id: 'c-1' });
    });
  });

  describe('ScoringCompleted', () => {
    it('enriched payload lands DSCR and LTV', async () => {
      await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { ...SCORE_OLD, dscr: 1.31, ltv: 0.6234 }, T2));
      expect(await app()).toMatchObject({ dscr: '1.3100', ltv: '0.6234', dti: '0.4150', selected_method: 'B_BUSINESS' });
    });
    it('old v1 payload still projects with DSCR/LTV NULL', async () => {
      expect(await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', SCORE_OLD, T2))).toBe('APPLIED');
      expect(await app()).toMatchObject({ dscr: null, ltv: null, sosco_score: '712.00' });
    });
    it('an older calculation delivered late cannot overwrite the newer DSCR/LTV', async () => {
      await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { ...SCORE_OLD, dscr: 1.5, ltv: 0.4 }, T3));
      await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { ...SCORE_OLD, dscr: 0.9, ltv: 0.9 }, T1));
      expect(await app()).toMatchObject({ dscr: '1.5000', ltv: '0.4000' });
    });
    it('a ratio outside numeric(7,4) (near-zero debt → DSCR 5000) is stored NULL instead of poisoning the stream', async () => {
      expect(await projector.handle('dwh-sync-scoring', ev('ScoringCompleted', { ...SCORE_OLD, dscr: 5000, ltv: 0.5 }, T2))).toBe('APPLIED');
      expect(await app()).toMatchObject({ dscr: null, ltv: '0.5000' });
    });
  });

  describe('StatementImported → fact_bsa_analysis', () => {
    it('enriched COMPLETED payload lands customer, period, income, cash flow, DTI (fraction), level and suspicion count', async () => {
      await projector.handle('dwh-sync-bsa', ev('StatementImported', { ...BSA_OLD, ...BSA_METRICS }, T2));
      expect(await row('fact_bsa_analysis', 'analysis_id', 'an-1')).toMatchObject({
        customer_id: 'c-1', period_months: 6, monthly_income: '3200000.00', net_cash_flow_monthly: '900000.50', dti: '0.3820', dti_level: 'MEDIUM', suspicion_count: 2, total_income: null,
      });
      expect((await pool.query('SELECT customer_type FROM dim_customer')).rows).toEqual([{ customer_type: 'UNKNOWN' }]);
    });
    it('old v1 payload still projects: metrics NULL, suspicion_count 0', async () => {
      expect(await projector.handle('dwh-sync-bsa', ev('StatementImported', BSA_OLD, T2))).toBe('APPLIED');
      expect(await row('fact_bsa_analysis', 'analysis_id', 'an-1')).toMatchObject({ customer_id: null, period_months: null, dti: null, dti_level: null, suspicion_count: 0 });
    });
    it('an older import delivered late cannot overwrite the newer metrics', async () => {
      await projector.handle('dwh-sync-bsa', ev('StatementImported', { ...BSA_OLD, ...BSA_METRICS, periodMonths: 12, pendingSuspiciousCount: 0 }, T3));
      await projector.handle('dwh-sync-bsa', ev('StatementImported', { ...BSA_OLD, ...BSA_METRICS, periodMonths: 3, pendingSuspiciousCount: 9 }, T1));
      expect(await row('fact_bsa_analysis', 'analysis_id', 'an-1')).toMatchObject({ period_months: 12, suspicion_count: 0 });
    });
    it('FAILED import is still ignored', async () => {
      await projector.handle('dwh-sync-bsa', ev('StatementImported', { ...BSA_OLD, status: 'FAILED', rows: 0 }, T2));
      expect(await row('fact_bsa_analysis', 'analysis_id', 'an-1')).toBeUndefined();
    });
  });
});
