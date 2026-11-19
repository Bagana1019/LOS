-- N4: fact dimensions from event payloads (ApplicationSubmitted / DisbursementApproved / ScoringCompleted / StatementImported optional fields).
-- Idempotent; upgrades an existing DWH in place (dwh-sync startup migration v3). New columns are nullable: v1 events without them still project.
-- Ordering: the new columns join the existing column families, so the occurredAt guards of 02 (submitted_at, scored_at, disbursed_at, analyzed_at) cover them.
-- BSA: the event carries the monthly average (BsaSummary.totalMonthlyIncome); total_income stays NULL rather than a reconstructed product.
ALTER TABLE fact_bsa_analysis ADD COLUMN IF NOT EXISTS monthly_income numeric(18,2);
-- Officer slicing (reports by ЗЭЗ); branch already has fact_application_branch_idx.
CREATE INDEX IF NOT EXISTS fact_application_officer_idx ON fact_application (officer_id, submitted_date_key);
