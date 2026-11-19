# consumers

`los:events` (Redis Streams) → DWH. Subscribe only; dwh-sync publishes nothing and never connects to the operational DB.

| Consumer group | Event (v1) | DWH target |
| --- | --- | --- |
| `dwh-sync-application` | ApplicationSubmitted | `fact_application` (amount, product_id, submitted_at/date_key; status only if none yet) + inferred `dim_product` stub (`product_type='UNKNOWN'`, never overwrites) |
| | ApplicationStatusChanged | `fact_application.status` (guard `status_changed_at`) |
| | ApplicationApproved | `fact_application.approved_at`, `decided_date_key` |
| | ApplicationReturned | `fact_application.returned_at` (latest) |
| `dwh-sync-scoring` | ScoringCompleted | `fact_application.selected_method`, `sosco_score`, `dti` (= dtiPercent / 100; guard `scored_at`) |
| `dwh-sync-disbursement` | DisbursementApproved | `fact_disbursement` (dimension keys copied from `fact_application`, backfilled later) |
| `dwh-sync-bsa` | StatementImported | `fact_bsa_analysis` (COMPLETED only; FAILED is marked processed, no row) |

Skipped on purpose (no target in the DDL): KycCompleted (emitted per borrower, so it cannot pick fact_application.customer_id), ValuationCompleted (per collateral; LTV is an origination calculation, not a sum in the DWH), DocumentUploaded and the rest of the catalog.

- Idempotency: `processed_events(consumer, event_id)` in the DWH, written in the same DWH transaction as the upserts (`consume-once.ts`). Upserts are keyed by business id and guarded by occurredAt, so out-of-order delivery across groups never moves a fact backwards.
- Versioning: `decode.ts` validates with the `@los/contracts` zod schema per type. A version other than 1 is logged and skipped. The bus rejects such payloads before the handler (DLQ after maxDeliveries), and that is not counted as a consumer failure.
- Failures: transient DWH errors (`transient-error.ts`: network, pg connection/shutdown/resource/auth classes, serialization/deadlock, schema behind the code) stay pending and do NOT consume a bus delivery attempt (`isTransientError`). Only deterministic failures count toward the DLQ (`los:events:dlq`, after maxDeliveries).
- DLQ replay: `node apps/dwh-sync/dist/cli/replay-dlq.js [--group dwh-sync-…]… [--since <ISO|epoch ms of the DLQ entry>] [--dry-run]` (env `REDIS_URL`, `DWH_DATABASE_URL`). Applies through the projector (idempotent via processed_events), removes APPLIED/DUPLICATE entries, keeps SKIPPED/failed ones, never reads other services' entries and never re-publishes to `los:events`. Aborts (entries kept) if the DWH is unavailable.
- Health: `/api/health/ready` → `dwh`, `dwh-schema`, `redis`, `consumer:<group>` (down if not subscribed or the bus is disabled). Groups subscribe only after the DWH schema is up to date. Dead-letter counts and consecutive failures are information on `GET /api/consumers/status`, never "down".
- PII: no event writes `dim_customer`/names/register numbers. Logs carry eventId/type/version only.
- N4: branch/officer/customer keys, rate/term, DSCR/LTV and BSA metrics come from optional event fields (v1 payloads still project, columns NULL). Inferred dim members (`UNKNOWN`) only; CDC for dim attributes (names, codes, customer type) is not implemented.
