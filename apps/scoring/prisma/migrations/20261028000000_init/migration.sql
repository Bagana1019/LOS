-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "scoring";

-- CreateTable
CREATE TABLE "scoring"."outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "scoring"."calculation" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inputs_json" JSONB NOT NULL,
    "method_a_json" JSONB,
    "method_b_json" JSONB,
    "method_c_json" JSONB,
    "auto_selected_method" TEXT,
    "selected_method" TEXT,
    "selected_by" TEXT,
    "policy_check_json" JSONB,
    "stress_json" JSONB,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "calculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."sosco_model" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "weights_json" JSONB NOT NULL,
    "grade_thresholds_json" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "sosco_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."sosco_result" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "inputs_json" JSONB,
    "breakdown_json" JSONB,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "sosco_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."bsa_analysis" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "officer_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'LOS',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "period_from" DATE,
    "period_to" DATE,
    "period_months" INTEGER,
    "proposed_monthly_payment" DECIMAL(18,2),
    "cost_of_goods_rate" DECIMAL(7,4),
    "summary_json" JSONB,
    "analyzed_at" TIMESTAMP(3),
    "pushed_to_los_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "bsa_analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."bsa_import_job" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "bank_code" TEXT,
    "format" TEXT,
    "account_no_encrypted" TEXT,
    "iban" TEXT,
    "holder_name" TEXT,
    "period_from" DATE,
    "period_to" DATE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "rows_done" INTEGER NOT NULL DEFAULT 0,
    "errors_json" JSONB,
    "parser_ok" BOOLEAN,
    "verifier_ok" BOOLEAN,
    "qr_verified" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "bsa_import_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."bsa_transaction" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "txn_date" DATE NOT NULL,
    "txn_time" TEXT,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "balance_after" DECIMAL(18,2),
    "description" TEXT,
    "counterparty_account_encrypted" TEXT,
    "counterparty_account_hash" TEXT,
    "counterparty_name" TEXT,
    "channel" TEXT,
    "category_code" TEXT,
    "category_group" TEXT,
    "confidence" DECIMAL(5,2),
    "is_own_transfer" BOOLEAN NOT NULL DEFAULT false,
    "manual_override" BOOLEAN NOT NULL DEFAULT false,
    "override_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bsa_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."bsa_category" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "group_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" DECIMAL(7,4) NOT NULL,
    "dti_role" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "bsa_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."bsa_rule" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "match_type" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "category_code" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "bsa_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring"."bsa_suspicion" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "flag" TEXT NOT NULL,
    "transaction_ids" TEXT[],
    "confidence" DECIMAL(5,2),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "action" TEXT,
    "comment" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "bsa_suspicion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "scoring"."outbox"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "calculation_application_id_computed_at_idx" ON "scoring"."calculation"("application_id", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "sosco_model_org_id_version_key" ON "scoring"."sosco_model"("org_id", "version");

-- CreateIndex
CREATE INDEX "sosco_result_application_id_customer_id_computed_at_idx" ON "scoring"."sosco_result"("application_id", "customer_id", "computed_at");

-- CreateIndex
CREATE INDEX "bsa_analysis_org_id_status_idx" ON "scoring"."bsa_analysis"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bsa_analysis_application_id_customer_id_version_key" ON "scoring"."bsa_analysis"("application_id", "customer_id", "version");

-- CreateIndex
CREATE INDEX "bsa_import_job_analysis_id_idx" ON "scoring"."bsa_import_job"("analysis_id");

-- CreateIndex
CREATE INDEX "bsa_import_job_status_idx" ON "scoring"."bsa_import_job"("status");

-- CreateIndex
CREATE INDEX "bsa_transaction_analysis_id_txn_date_idx" ON "scoring"."bsa_transaction"("analysis_id", "txn_date");

-- CreateIndex
CREATE INDEX "bsa_transaction_analysis_id_category_code_idx" ON "scoring"."bsa_transaction"("analysis_id", "category_code");

-- CreateIndex
CREATE INDEX "bsa_transaction_import_job_id_idx" ON "scoring"."bsa_transaction"("import_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "bsa_category_org_id_code_key" ON "scoring"."bsa_category"("org_id", "code");

-- CreateIndex
CREATE INDEX "bsa_rule_org_id_direction_priority_idx" ON "scoring"."bsa_rule"("org_id", "direction", "priority");

-- CreateIndex
CREATE INDEX "bsa_suspicion_analysis_id_status_idx" ON "scoring"."bsa_suspicion"("analysis_id", "status");

-- AddForeignKey
ALTER TABLE "scoring"."sosco_result" ADD CONSTRAINT "sosco_result_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "scoring"."sosco_model"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring"."bsa_import_job" ADD CONSTRAINT "bsa_import_job_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "scoring"."bsa_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring"."bsa_transaction" ADD CONSTRAINT "bsa_transaction_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "scoring"."bsa_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring"."bsa_transaction" ADD CONSTRAINT "bsa_transaction_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "scoring"."bsa_import_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring"."bsa_suspicion" ADD CONSTRAINT "bsa_suspicion_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "scoring"."bsa_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

