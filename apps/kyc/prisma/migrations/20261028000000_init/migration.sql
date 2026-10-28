-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "kyc";

-- CreateTable
CREATE TABLE "kyc"."outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "kyc"."inquiry" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetched_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "raw_json" JSONB,
    "summary_json" JSONB,
    "warning_level" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc"."unregistered_loan" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "lender_name" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "monthly_payment" DECIMAL(18,2) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "unregistered_loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc"."kyc_check" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT,
    "customer_id" TEXT NOT NULL,
    "check_type" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "details_json" JSONB,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "kyc_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc"."aml_screening" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "list_name" TEXT NOT NULL,
    "match_score" DECIMAL(5,2),
    "risk_score" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'CLEAR',
    "raw_json" JSONB,
    "screened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "aml_screening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "kyc"."outbox"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "inquiry_application_id_customer_id_source_fetched_at_idx" ON "kyc"."inquiry"("application_id", "customer_id", "source", "fetched_at");

-- CreateIndex
CREATE INDEX "inquiry_customer_id_idx" ON "kyc"."inquiry"("customer_id");

-- CreateIndex
CREATE INDEX "unregistered_loan_application_id_customer_id_idx" ON "kyc"."unregistered_loan"("application_id", "customer_id");

-- CreateIndex
CREATE INDEX "kyc_check_customer_id_check_type_checked_at_idx" ON "kyc"."kyc_check"("customer_id", "check_type", "checked_at");

-- CreateIndex
CREATE INDEX "kyc_check_application_id_idx" ON "kyc"."kyc_check"("application_id");

-- CreateIndex
CREATE INDEX "aml_screening_customer_id_screened_at_idx" ON "kyc"."aml_screening"("customer_id", "screened_at");

