-- Модуль 8 — Тооцоолол (A/B/C) ба дотоод Sosco Score (docs/05-scoring-sosco.md §4).
-- Baseline (20261028000000_init) болон BSA migration-ийг ӨӨРЧИЛӨХГҮЙ: зөвхөн ALTER TABLE / CREATE INDEX.
-- Одоо байгаа мөрүүдэд аюулгүй: бүх шинэ багана nullable (calculation-д Модуль 8-аас өмнө бичигч байгаагүй; sosco_model v1 seed-ийн
-- params_json = NULL => сервис DEFAULT_SOSCO_CURVES-ийг хэрэглэнэ).

-- AlterTable
ALTER TABLE "scoring"."calculation"
    ADD COLUMN "customer_id" TEXT,
    ADD COLUMN "result_json" JSONB,
    ADD COLUMN "selected_reason" TEXT,
    ADD COLUMN "selected_at" TIMESTAMP(3),
    ADD COLUMN "stale_reason" TEXT;

-- AlterTable
ALTER TABLE "scoring"."sosco_model" ADD COLUMN "params_json" JSONB;

-- CreateIndex
CREATE INDEX "calculation_org_id_application_id_computed_at_idx" ON "scoring"."calculation"("org_id", "application_id", "computed_at");
