-- FIN-SYNC: ERP-д дамжуулах үйл явдлын outbox (modules/erp-sync). Өмнөх migration `20261029050000_blacklist_aml`-ийн дараа ажиллана.

-- CreateTable
CREATE TABLE "origination"."erp_event" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "contract_no" TEXT,
    "core_loan_id" TEXT,
    "customer_id" TEXT,
    "currency" VARCHAR(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_error_code" TEXT,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "external_ref" TEXT,
    "target" TEXT,
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "erp_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."erp_delivery_attempt" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "external_ref" TEXT,
    "target" TEXT,
    "actor_id" TEXT,
    "note" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "erp_delivery_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erp_event_seq_key" ON "origination"."erp_event"("seq");

-- CreateIndex
CREATE INDEX "erp_event_status_next_attempt_at_seq_idx" ON "origination"."erp_event"("status", "next_attempt_at", "seq");

-- CreateIndex
CREATE INDEX "erp_event_application_id_seq_idx" ON "origination"."erp_event"("application_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "erp_event_org_id_idempotency_key_key" ON "origination"."erp_event"("org_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "erp_delivery_attempt_event_id_started_at_idx" ON "origination"."erp_delivery_attempt"("event_id", "started_at");

-- AddForeignKey
ALTER TABLE "origination"."erp_delivery_attempt" ADD CONSTRAINT "erp_delivery_attempt_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "origination"."erp_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
