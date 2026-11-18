-- NFR-4 · docs/05-compliance-aml.md §5: AML hit шийдвэрийн аудит (kyc schema). Нэмэлт миграци — өмнөх хүснэгтүүдийг хөндөхгүй.
CREATE TABLE "kyc"."audit_log" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before_json" JSONB,
    "after_json" JSONB,
    "application_id" TEXT,
    "correlation_id" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_org_id_entity_entity_id_idx" ON "kyc"."audit_log"("org_id", "entity", "entity_id");
CREATE INDEX "audit_log_application_id_idx" ON "kyc"."audit_log"("application_id");
CREATE INDEX "audit_log_actor_id_at_idx" ON "kyc"."audit_log"("actor_id", "at");
