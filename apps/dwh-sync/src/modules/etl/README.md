# etl

DWH Postgres access (`DWH_DATABASE_URL`, pg pool) and the event → star-schema upserts (`fact-writers.ts`).

- `dwh-config.ts` refuses to start when `DWH_DATABASE_URL` resolves to the same host/port/db as `DATABASE_URL` (never write to the operational DB).
- `date-key.ts`: `dim_date.date_key` = Asia/Ulaanbaatar (UTC+8) calendar day, or NULL outside the seeded 2020–2040 range.
- DDL: `packages/database/dwh/init/01-star-schema.sql` + `02-event-ordering.sql` (nullable `fact_application.status`, `status_changed_at`, `scored_at`) + `03-fact-dimensions.sql` (N4: `fact_bsa_analysis.monthly_income`, officer index). Re-runnable on an existing DWH.
- Startup migration (`dwh-schema.ts`): initdb runs those files only on an empty volume, so dwh-sync applies every version newer than `dwh_schema_version` at startup, in one transaction under `pg_advisory_xact_lock` (two pods never race). New DDL = new file + append to `MIGRATION_FILES`. On failure readiness `dwh-schema` stays down (reason in the log and `/api/consumers/status`) and it retries every 5 s. `DWH_DDL_DIR` overrides the file location.
- Tests: `DWH_TEST_DATABASE_URL` (db name must end in `test`) applies the real DDL. See `src/modules/consumers/*.integration.test.ts` and `test/consumers.e2e.test.ts`.
