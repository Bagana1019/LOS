-- dwh-sync event consumers (CLAUDE.md §3.1): at-least-once, and each fact has its own consumer group, so events for one
-- application arrive out of order across groups. Idempotent; safe to re-run on an existing DWH (initdb only runs on an empty volume).
-- 1) fact_application.status becomes nullable: ScoringCompleted / ApplicationApproved can land before the first status event.
--    NULL = "no status event seen yet", never a fabricated status.
ALTER TABLE fact_application ALTER COLUMN status DROP NOT NULL;
-- 2) Last-writer-wins guards per event stream (occurredAt of the event that last set the columns).
ALTER TABLE fact_application ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE fact_application ADD COLUMN IF NOT EXISTS scored_at timestamptz;
