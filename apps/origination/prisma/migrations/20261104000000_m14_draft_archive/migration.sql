-- M14 · FR-1.6: ноорог автоматаар архивлах тэмдэг (нэмэлт, буцааж болно)
ALTER TABLE "origination"."loan_application" ADD COLUMN "archived_at" TIMESTAMP(3);
CREATE INDEX "loan_application_status_archived_at_updated_at_idx" ON "origination"."loan_application"("status", "archived_at", "updated_at");
