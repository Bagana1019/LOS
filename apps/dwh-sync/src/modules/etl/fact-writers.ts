// Event → star-schema upserts (CLAUDE.md §4). Keyed by the business id; each column family is guarded by the occurredAt of the event
// that last wrote it, so replays and cross-group reordering never move a fact backwards. PII never reaches these tables.
import type { DwhEvent } from '../consumers/decode';
import { dateKeyOf } from './date-key';
import type { DwhClient } from './dwh-database';

type Of<T extends DwhEvent['type']> = Extract<DwhEvent, { type: T }>;

async function applicationSubmitted(c: DwhClient, e: Of<'ApplicationSubmitted'>) {
  // Inferred dimension member: real attributes come from CDC (out of scope); never overwrites an existing row.
  await c.query(`INSERT INTO dim_product (product_id, org_id, code, name, product_type) VALUES ($1, $2, $1, $1, 'UNKNOWN') ON CONFLICT (product_id) DO NOTHING`, [e.productId, e.orgId]);
  // Status: first status seen only if none yet (status_changed_at stays NULL so any ApplicationStatusChanged wins).
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, product_id, status, amount, submitted_at, submitted_date_key, updated_at)
     VALUES ($1, $2, $3, 'SUBMITTED', $4, $5, $6, now())
     ON CONFLICT (application_id) DO UPDATE SET product_id = EXCLUDED.product_id, amount = EXCLUDED.amount, submitted_at = EXCLUDED.submitted_at,
       submitted_date_key = EXCLUDED.submitted_date_key, status = COALESCE(fa.status, EXCLUDED.status), updated_at = now()
     WHERE fa.submitted_at IS NULL OR EXCLUDED.submitted_at >= fa.submitted_at`,
    [e.applicationId, e.orgId, e.productId, e.amount, e.occurredAt, dateKeyOf(e.occurredAt)],
  );
  // dwh-sync-disbursement may have run first (separate group): backfill the dimension key.
  await c.query('UPDATE fact_disbursement SET product_id = $2 WHERE application_id = $1 AND product_id IS NULL', [e.applicationId, e.productId]);
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
  const dti = e.dtiPercent == null ? null : e.dtiPercent / 100;
  await c.query(
    `INSERT INTO fact_application AS fa (application_id, org_id, selected_method, sosco_score, dti, scored_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (application_id) DO UPDATE SET selected_method = EXCLUDED.selected_method, sosco_score = EXCLUDED.sosco_score, dti = EXCLUDED.dti,
       scored_at = EXCLUDED.scored_at, updated_at = now()
     WHERE fa.scored_at IS NULL OR EXCLUDED.scored_at >= fa.scored_at`,
    [e.applicationId, e.orgId, e.selectedMethod, e.soscoScore, dti, e.occurredAt],
  );
}

async function disbursementApproved(c: DwhClient, e: Of<'DisbursementApproved'>) {
  // Dimension keys are copied from fact_application (DWH-only read); missing ones are backfilled by applicationSubmitted.
  await c.query(
    `INSERT INTO fact_disbursement AS fd (application_id, org_id, branch_id, product_id, customer_id, disbursed_amount, core_loan_id, disbursed_date_key, disbursed_at)
     SELECT $1::text, $2::text, fa.branch_id, fa.product_id, fa.customer_id, $3::numeric, $4::text, $5::int, $6::timestamptz
     FROM (VALUES (1)) AS one LEFT JOIN fact_application fa ON fa.application_id = $1::text
     ON CONFLICT (application_id) DO UPDATE SET disbursed_amount = EXCLUDED.disbursed_amount, core_loan_id = EXCLUDED.core_loan_id,
       disbursed_date_key = EXCLUDED.disbursed_date_key, disbursed_at = EXCLUDED.disbursed_at,
       branch_id = COALESCE(fd.branch_id, EXCLUDED.branch_id), product_id = COALESCE(fd.product_id, EXCLUDED.product_id), customer_id = COALESCE(fd.customer_id, EXCLUDED.customer_id)
     WHERE EXCLUDED.disbursed_at >= fd.disbursed_at`,
    [e.applicationId, e.orgId, e.amount, e.coreLoanId, dateKeyOf(e.occurredAt), e.occurredAt],
  );
}

async function statementImported(c: DwhClient, e: Of<'StatementImported'>) {
  if (e.status !== 'COMPLETED') return; // a FAILED import produced no analysis; the DDL has no status column for it
  await c.query(
    `INSERT INTO fact_bsa_analysis AS b (analysis_id, org_id, application_id, analyzed_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (analysis_id) DO UPDATE SET application_id = EXCLUDED.application_id, analyzed_at = EXCLUDED.analyzed_at
     WHERE b.analyzed_at IS NULL OR EXCLUDED.analyzed_at >= b.analyzed_at`,
    [e.analysisId, e.orgId, e.applicationId, e.occurredAt],
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
