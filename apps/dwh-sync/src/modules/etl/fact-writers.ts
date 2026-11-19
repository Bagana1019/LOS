// Event → star-schema upserts (CLAUDE.md §4). Keyed by the business id; each column family is guarded by the occurredAt of the event
// that last wrote it, so replays and cross-group reordering never move a fact backwards. PII never reaches these tables.
import type { DwhEvent } from '../consumers/decode';
import { dateKeyOf } from './date-key';
import type { DwhClient } from './dwh-database';

type Of<T extends DwhEvent['type']> = Extract<DwhEvent, { type: T }>;

/** numeric(7,4) holds |x| < 1000. An out-of-range ratio (e.g. DSCR on near-zero debt) would be a deterministic insert error → DLQ; store NULL instead. */
const RATIO_LIMIT = 1000;
const ratio = (v: number | null | undefined, divisor = 1): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const x = v / divisor;
  return Math.abs(x) < RATIO_LIMIT ? x : null;
};

interface DimKeys { branchId?: string | null; customerId?: string | null; productId?: string | null }

/** Inferred dimension members (N4): ids only, real attributes come from CDC; ON CONFLICT DO NOTHING never overwrites a real row. FKs need them. */
async function inferDimensions(c: DwhClient, orgId: string, k: DimKeys): Promise<void> {
  if (k.productId) await c.query(`INSERT INTO dim_product (product_id, org_id, code, name, product_type) VALUES ($1, $2, $1, $1, 'UNKNOWN') ON CONFLICT (product_id) DO NOTHING`, [k.productId, orgId]);
  if (k.branchId) await c.query('INSERT INTO dim_branch (branch_id, org_id, code, name) VALUES ($1, $2, $1, $1) ON CONFLICT (branch_id) DO NOTHING', [k.branchId, orgId]);
  if (k.customerId) await c.query(`INSERT INTO dim_customer (customer_id, org_id, customer_type) VALUES ($1, $2, 'UNKNOWN') ON CONFLICT (customer_id) DO NOTHING`, [k.customerId, orgId]);
}

async function applicationSubmitted(c: DwhClient, e: Of<'ApplicationSubmitted'>) {
  const keys = { productId: e.productId, branchId: e.branchId ?? null, customerId: e.customerId ?? null };
  await inferDimensions(c, e.orgId, keys);
  // Status: first status seen only if none yet (status_changed_at stays NULL so any ApplicationStatusChanged wins).
  // N4: rate/term belong to this submission (terms are editable only before submit) → replaced; dimension keys are stable per application,
  // so a payload without them (v1, already in the stream) keeps the known keys instead of erasing them. All guarded by submitted_at.
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, product_id, branch_id, officer_id, customer_id, status, amount, interest_rate, term_months,
       submitted_at, submitted_date_key, updated_at)
     VALUES ($1, $2, $3, $7, $8, $9, 'SUBMITTED', $4, $10, $11, $5, $6, now())
     ON CONFLICT (application_id) DO UPDATE SET product_id = EXCLUDED.product_id, amount = EXCLUDED.amount, submitted_at = EXCLUDED.submitted_at,
       submitted_date_key = EXCLUDED.submitted_date_key, status = COALESCE(fa.status, EXCLUDED.status),
       branch_id = COALESCE(EXCLUDED.branch_id, fa.branch_id), officer_id = COALESCE(EXCLUDED.officer_id, fa.officer_id), customer_id = COALESCE(EXCLUDED.customer_id, fa.customer_id),
       interest_rate = EXCLUDED.interest_rate, term_months = EXCLUDED.term_months, updated_at = now()
     WHERE fa.submitted_at IS NULL OR EXCLUDED.submitted_at >= fa.submitted_at`,
    [e.applicationId, e.orgId, e.productId, e.amount, e.occurredAt, dateKeyOf(e.occurredAt), keys.branchId, e.officerId ?? null, keys.customerId,
      ratio(e.interestRatePercent, 100), e.termMonths ?? null],
  );
  // dwh-sync-disbursement may have run first (separate group): backfill the dimension keys it could not know.
  await c.query(
    'UPDATE fact_disbursement SET product_id = COALESCE(product_id, $2), branch_id = COALESCE(branch_id, $3), customer_id = COALESCE(customer_id, $4) WHERE application_id = $1',
    [e.applicationId, e.productId, keys.branchId, keys.customerId],
  );
}

async function applicationStatusChanged(c: DwhClient, e: Of<'ApplicationStatusChanged'>) {
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, status, status_changed_at, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (application_id) DO UPDATE SET status = EXCLUDED.status, status_changed_at = EXCLUDED.status_changed_at, updated_at = now()
     WHERE fa.status_changed_at IS NULL OR EXCLUDED.status_changed_at >= fa.status_changed_at`,
    [e.applicationId, e.orgId, e.to, e.occurredAt],
  );
}

async function applicationApproved(c: DwhClient, e: Of<'ApplicationApproved'>) {
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, approved_at, decided_date_key, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (application_id) DO UPDATE SET approved_at = EXCLUDED.approved_at, decided_date_key = EXCLUDED.decided_date_key, updated_at = now()
     WHERE fa.approved_at IS NULL OR EXCLUDED.approved_at >= fa.approved_at`,
    [e.applicationId, e.orgId, e.occurredAt, dateKeyOf(e.occurredAt)],
  );
}

async function applicationReturned(c: DwhClient, e: Of<'ApplicationReturned'>) {
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, returned_at, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (application_id) DO UPDATE SET returned_at = EXCLUDED.returned_at, updated_at = now()
     WHERE fa.returned_at IS NULL OR EXCLUDED.returned_at >= fa.returned_at`,
    [e.applicationId, e.orgId, e.occurredAt],
  );
}

async function scoringCompleted(c: DwhClient, e: Of<'ScoringCompleted'>) {
  // DDL stores ratios as fractions (0.55 = 55 %); the event carries percent.
  // N4: dscr / ltv belong to the same calculation → replaced together (NULL on a v1 payload), guarded by scored_at.
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, selected_method, sosco_score, dti, dscr, ltv, scored_at, updated_at) VALUES ($1, $2, $3, $4, $5, $7, $8, $6, now())
     ON CONFLICT (application_id) DO UPDATE SET selected_method = EXCLUDED.selected_method, sosco_score = EXCLUDED.sosco_score, dti = EXCLUDED.dti,
       dscr = EXCLUDED.dscr, ltv = EXCLUDED.ltv, scored_at = EXCLUDED.scored_at, updated_at = now()
     WHERE fa.scored_at IS NULL OR EXCLUDED.scored_at >= fa.scored_at`,
    [e.applicationId, e.orgId, e.selectedMethod, e.soscoScore, ratio(e.dtiPercent, 100), e.occurredAt, ratio(e.dscr), ratio(e.ltv)],
  );
}

async function disbursementApproved(c: DwhClient, e: Of<'DisbursementApproved'>) {
  // N4: keys from the payload when present; otherwise (v1) copied from fact_application (DWH-only read), missing ones backfilled by applicationSubmitted.
  await inferDimensions(c, e.orgId, { branchId: e.branchId, productId: e.productId, customerId: e.customerId });
  await c.query(
    `INSERT INTO fact_disbursement AS fd (application_id, org_id, branch_id, product_id, customer_id, disbursed_amount, core_loan_id, disbursed_date_key, disbursed_at)
     SELECT $1::text, $2::text, COALESCE($7::text, fa.branch_id), COALESCE($8::text, fa.product_id), COALESCE($9::text, fa.customer_id), $3::numeric, $4::text, $5::int, $6::timestamptz
     FROM (VALUES (1)) AS one LEFT JOIN fact_application fa ON fa.application_id = $1::text
     ON CONFLICT (application_id) DO UPDATE SET disbursed_amount = EXCLUDED.disbursed_amount, core_loan_id = EXCLUDED.core_loan_id,
       disbursed_date_key = EXCLUDED.disbursed_date_key, disbursed_at = EXCLUDED.disbursed_at,
       branch_id = COALESCE(fd.branch_id, EXCLUDED.branch_id), product_id = COALESCE(fd.product_id, EXCLUDED.product_id), customer_id = COALESCE(fd.customer_id, EXCLUDED.customer_id)
     WHERE EXCLUDED.disbursed_at >= fd.disbursed_at`,
    [e.applicationId, e.orgId, e.amount, e.coreLoanId, dateKeyOf(e.occurredAt), e.occurredAt, e.branchId ?? null, e.productId ?? null, e.customerId ?? null],
  );
}

async function statementImported(c: DwhClient, e: Of<'StatementImported'>) {
  if (e.status !== 'COMPLETED') return; // a FAILED import produced no analysis; the DDL has no status column for it
  // N4: INT-4 summary snapshot of this import; all metrics replaced together (NULL / 0 on a v1 payload), guarded by analyzed_at.
  await inferDimensions(c, e.orgId, { customerId: e.customerId });
  await c.query(
    `INSERT INTO fact_bsa_analysis AS b (analysis_id, org_id, application_id, analyzed_at, customer_id, period_months, monthly_income, net_cash_flow_monthly, dti, dti_level, suspicion_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (analysis_id) DO UPDATE SET application_id = EXCLUDED.application_id, analyzed_at = EXCLUDED.analyzed_at,
       customer_id = COALESCE(EXCLUDED.customer_id, b.customer_id), period_months = EXCLUDED.period_months, monthly_income = EXCLUDED.monthly_income,
       net_cash_flow_monthly = EXCLUDED.net_cash_flow_monthly, dti = EXCLUDED.dti, dti_level = EXCLUDED.dti_level, suspicion_count = EXCLUDED.suspicion_count
     WHERE b.analyzed_at IS NULL OR EXCLUDED.analyzed_at >= b.analyzed_at`,
    [e.analysisId, e.orgId, e.applicationId, e.occurredAt, e.customerId ?? null, e.periodMonths ?? null, e.monthlyIncome ?? null, e.netCashFlowMonthly ?? null,
      ratio(e.dtiPercent, 100), e.dtiLevel ?? null, e.pendingSuspiciousCount ?? 0],
  );
}

/** Applies one validated event inside the caller's DWH transaction. */
export async function applyToDwh(c: DwhClient, e: DwhEvent): Promise<void> {
  switch (e.type) {
    case 'ApplicationSubmitted': return applicationSubmitted(c, e);
    case 'ApplicationStatusChanged': return applicationStatusChanged(c, e);
    case 'ApplicationApproved': return applicationApproved(c, e);
    case 'ApplicationReturned': return applicationReturned(c, e);
    case 'ScoringCompleted': return scoringCompleted(c, e);
    case 'DisbursementApproved': return disbursementApproved(c, e);
    case 'StatementImported': return statementImported(c, e);
  }
}
