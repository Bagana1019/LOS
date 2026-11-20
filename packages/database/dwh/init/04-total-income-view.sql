-- N4 follow-up (owner chose "view", 2026-11-20): total income is derived, not stored.
-- fact_bsa_analysis.total_income was never written (always NULL; the event carries the monthly average, stored in monthly_income by 03).
-- A stored copy of monthly_income × period_months can drift from its inputs, so the column is dropped and exposed through a view instead.
-- Idempotent; dwh-sync applies it at startup as v4. 01 still creates the column on an empty DWH, this drops it right after.
-- Nothing in the repo reads the column (checked); there are no live users, so no compatibility shim.
ALTER TABLE fact_bsa_analysis DROP COLUMN IF EXISTS total_income;

-- Same columns as the table plus the derived total (NULL when the period or the monthly average is unknown).
-- Column list is explicit on purpose: `SELECT *` would freeze whatever columns exist today. A later migration that adds a column
-- to fact_bsa_analysis must append it here (CREATE OR REPLACE VIEW can only add columns at the end).
CREATE OR REPLACE VIEW v_fact_bsa_analysis AS
SELECT
  analysis_id, org_id, application_id, customer_id, period_months, net_cash_flow_monthly, dti, dti_level, suspicion_count, analyzed_at,
  monthly_income,
  (monthly_income * period_months)::numeric(18,2) AS total_income
FROM fact_bsa_analysis;
