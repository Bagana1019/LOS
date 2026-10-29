-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "origination";

-- CreateTable
CREATE TABLE "origination"."outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "origination"."audit_log" (
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

-- CreateTable
CREATE TABLE "origination"."setting" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."product" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MNT',
    "min_amount" DECIMAL(18,2) NOT NULL,
    "max_amount" DECIMAL(18,2) NOT NULL,
    "min_term" INTEGER NOT NULL,
    "max_term" INTEGER NOT NULL,
    "min_rate" DECIMAL(7,4) NOT NULL,
    "max_rate" DECIMAL(7,4) NOT NULL,
    "default_fee_rate" DECIMAL(7,4),
    "requires_collateral" BOOLEAN NOT NULL DEFAULT true,
    "max_ltv" DECIMAL(7,4),
    "max_dti" DECIMAL(7,4),
    "min_dscr" DECIMAL(7,4),
    "calc_weight_threshold" DECIMAL(7,4),
    "contract_template_id" TEXT,
    "document_checklist_json" JSONB,
    "collateral_checklist_json" JSONB,
    "haircut_json" JSONB,
    "external_valuation_threshold" DECIMAL(18,2),
    "cost_of_goods_rate" DECIMAL(7,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."approval_level" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT,
    "level_no" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "amount_from" DECIMAL(18,2) NOT NULL,
    "amount_to" DECIMAL(18,2),
    "quorum_type" TEXT NOT NULL DEFAULT 'MAJORITY',
    "sla_hours" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "approval_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."approval_level_member" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "approval_level_id" TEXT NOT NULL,
    "user_id" TEXT,
    "role" TEXT,
    "branch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "approval_level_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."contract_number_template" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "seq_scope" TEXT NOT NULL,
    "next_seq" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "contract_number_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."customer" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "register_no_hash" TEXT NOT NULL,
    "register_no_encrypted" TEXT NOT NULL,
    "customer_type" TEXT NOT NULL,
    "last_name" TEXT,
    "first_name" TEXT NOT NULL,
    "gender" TEXT,
    "birth_date" DATE,
    "phone" TEXT,
    "email" TEXT,
    "photo_file_id" TEXT,
    "family_size" INTEGER,
    "activity_sector" TEXT,
    "marital_status" TEXT,
    "segment" TEXT,
    "education" TEXT,
    "is_related_party" BOOLEAN NOT NULL DEFAULT false,
    "is_pep" BOOLEAN NOT NULL DEFAULT false,
    "aml_risk_score" INTEGER,
    "official_address_json" JSONB,
    "residence_address_json" JSONB,
    "employment_json" JSONB,
    "xyp_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."customer_contact" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "register_no_encrypted" TEXT,
    "last_name" TEXT,
    "first_name" TEXT NOT NULL,
    "phone" TEXT,
    "employment" TEXT,
    "home_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "customer_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."customer_bank_account" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "bank_code" TEXT NOT NULL,
    "account_no_encrypted" TEXT NOT NULL,
    "account_no_hash" TEXT NOT NULL,
    "iban" TEXT,
    "holder_name" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "customer_bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."loan_application" (
    "id" TEXT NOT NULL,
    "app_no" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "officer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "product_id" TEXT,
    "purpose" TEXT,
    "purpose_detail" TEXT,
    "cib_purpose_code" TEXT,
    "cib_sub_code" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'MNT',
    "amount" DECIMAL(18,2),
    "interest_rate" DECIMAL(7,4),
    "term_months" INTEGER,
    "fee_rate" DECIMAL(7,4),
    "down_payment" DECIMAL(18,2),
    "charges" DECIMAL(18,2),
    "insurance" DECIMAL(18,2),
    "officer_note" TEXT,
    "contract_no" TEXT,
    "decided_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "returned_at" TIMESTAMP(3),
    "disbursed_at" TIMESTAMP(3),
    "selected_calc_method" TEXT,
    "calc_snapshot_json" JSONB,
    "bsa_summary_json" JSONB,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "version" INTEGER NOT NULL DEFAULT 1,
    "parent_application_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "loan_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."loan_application_borrower" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "loan_application_borrower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."loan_application_step" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LOCKED',
    "completed_at" TIMESTAMP(3),
    "stale_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "loan_application_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."income_salary" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "employer" TEXT,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "salary" DECIMAL(18,2) NOT NULL,
    "contribution_paid" DECIMAL(18,2),
    "source" TEXT NOT NULL DEFAULT 'NDSH',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "income_salary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."income_manual" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "monthly_amount" DECIMAL(18,2) NOT NULL,
    "file_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "income_manual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."income_summary" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "period_from" DATE,
    "period_to" DATE,
    "avg_salary_monthly" DECIMAL(18,2),
    "business_ncf_monthly" DECIMAL(18,2),
    "household_expense_monthly" DECIMAL(18,2),
    "business_expense_monthly" DECIMAL(18,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "income_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."collateral" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "owner_customer_id" TEXT,
    "description_json" JSONB,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "market_value" DECIMAL(18,2),
    "haircut_rate" DECIMAL(7,4),
    "collateral_value" DECIMAL(18,2),
    "ownership_verified" BOOLEAN NOT NULL DEFAULT false,
    "ownership_check_json" JSONB,
    "encumbrance_check_json" JSONB,
    "encumbrance_status" TEXT,
    "registry_no" TEXT,
    "registry_date" DATE,
    "released_at" TIMESTAMP(3),
    "insurance_expires_at" DATE,
    "next_revaluation_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "collateral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."collateral_document" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "collateral_id" TEXT NOT NULL,
    "checklist_key" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "uploaded_by" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "collateral_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."repayment_schedule" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "params_json" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "repayment_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."repayment_schedule_row" (
    "id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "disbursement" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "principal" DECIMAL(18,2) NOT NULL,
    "interest" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "repayment_schedule_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."approval_request" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "level_no" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."approval_vote" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "approval_request_id" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "approval_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."decision_record" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "decision_no" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL,
    "minutes_text" TEXT,
    "file_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "decision_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."contract" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "contract_no" TEXT NOT NULL,
    "template_version" INTEGER,
    "generated_file_id" TEXT,
    "signed_file_id" TEXT,
    "signed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."official_letter" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "generated_file_id" TEXT,
    "printed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "official_letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."disbursement_request" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "approved_amount" DECIMAL(18,2) NOT NULL,
    "disburse_amount" DECIMAL(18,2) NOT NULL,
    "term_months" INTEGER NOT NULL,
    "interest_rate" DECIMAL(7,4) NOT NULL,
    "repayment_type" TEXT NOT NULL,
    "first_payment_date" DATE,
    "disburse_date" DATE,
    "bank_code" TEXT,
    "account_no_encrypted" TEXT,
    "holder_name" TEXT,
    "account_owner_type" TEXT,
    "name_check_json" JSONB,
    "reconciliation_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "core_loan_id" TEXT,
    "history_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "disbursement_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."blacklist" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "register_no_hash" TEXT NOT NULL,
    "register_no_encrypted" TEXT NOT NULL,
    "customer_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "list_type" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT,
    "registered_by" TEXT,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "blacklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."notification" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "application_id" TEXT,
    "payload_json" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."comment" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "origination"."outbox"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_org_id_entity_entity_id_idx" ON "origination"."audit_log"("org_id", "entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_application_id_idx" ON "origination"."audit_log"("application_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "origination"."audit_log"("actor_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "setting_org_id_key_key" ON "origination"."setting"("org_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "product_org_id_code_key" ON "origination"."product"("org_id", "code");

-- CreateIndex
CREATE INDEX "approval_level_org_id_level_no_idx" ON "origination"."approval_level"("org_id", "level_no");

-- CreateIndex
CREATE UNIQUE INDEX "approval_level_org_id_product_id_level_no_key" ON "origination"."approval_level"("org_id", "product_id", "level_no");

-- CreateIndex
CREATE INDEX "approval_level_member_approval_level_id_idx" ON "origination"."approval_level_member"("approval_level_id");

-- CreateIndex
CREATE INDEX "approval_level_member_user_id_idx" ON "origination"."approval_level_member"("user_id");

-- CreateIndex
CREATE INDEX "contract_number_template_org_id_idx" ON "origination"."contract_number_template"("org_id");

-- CreateIndex
CREATE INDEX "customer_org_id_last_name_first_name_idx" ON "origination"."customer"("org_id", "last_name", "first_name");

-- CreateIndex
CREATE UNIQUE INDEX "customer_org_id_register_no_hash_key" ON "origination"."customer"("org_id", "register_no_hash");

-- CreateIndex
CREATE INDEX "customer_contact_customer_id_idx" ON "origination"."customer_contact"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_bank_account_customer_id_bank_code_account_no_hash_key" ON "origination"."customer_bank_account"("customer_id", "bank_code", "account_no_hash");

-- CreateIndex
CREATE INDEX "loan_application_org_id_status_idx" ON "origination"."loan_application"("org_id", "status");

-- CreateIndex
CREATE INDEX "loan_application_officer_id_idx" ON "origination"."loan_application"("officer_id");

-- CreateIndex
CREATE INDEX "loan_application_branch_id_idx" ON "origination"."loan_application"("branch_id");

-- CreateIndex
CREATE INDEX "loan_application_product_id_idx" ON "origination"."loan_application"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "loan_application_org_id_app_no_key" ON "origination"."loan_application"("org_id", "app_no");

-- CreateIndex
CREATE UNIQUE INDEX "loan_application_org_id_contract_no_key" ON "origination"."loan_application"("org_id", "contract_no");

-- CreateIndex
CREATE INDEX "loan_application_borrower_customer_id_idx" ON "origination"."loan_application_borrower"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "loan_application_borrower_application_id_customer_id_role_key" ON "origination"."loan_application_borrower"("application_id", "customer_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "loan_application_step_application_id_step_key_key" ON "origination"."loan_application_step"("application_id", "step_key");

-- CreateIndex
CREATE INDEX "income_salary_application_id_customer_id_idx" ON "origination"."income_salary"("application_id", "customer_id");

-- CreateIndex
CREATE INDEX "income_manual_application_id_customer_id_idx" ON "origination"."income_manual"("application_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "income_summary_application_id_customer_id_key" ON "origination"."income_summary"("application_id", "customer_id");

-- CreateIndex
CREATE INDEX "collateral_application_id_idx" ON "origination"."collateral"("application_id");

-- CreateIndex
CREATE INDEX "collateral_org_id_registry_no_idx" ON "origination"."collateral"("org_id", "registry_no");

-- CreateIndex
CREATE INDEX "collateral_document_collateral_id_checklist_key_idx" ON "origination"."collateral_document"("collateral_id", "checklist_key");

-- CreateIndex
CREATE INDEX "repayment_schedule_application_id_generated_at_idx" ON "origination"."repayment_schedule"("application_id", "generated_at");

-- CreateIndex
CREATE INDEX "repayment_schedule_row_due_date_idx" ON "origination"."repayment_schedule_row"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "repayment_schedule_row_schedule_id_seq_key" ON "origination"."repayment_schedule_row"("schedule_id", "seq");

-- CreateIndex
CREATE INDEX "approval_request_status_due_at_idx" ON "origination"."approval_request"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_request_application_id_version_level_no_key" ON "origination"."approval_request"("application_id", "version", "level_no");

-- CreateIndex
CREATE INDEX "approval_vote_approver_id_idx" ON "origination"."approval_vote"("approver_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_vote_approval_request_id_approver_id_key" ON "origination"."approval_vote"("approval_request_id", "approver_id");

-- CreateIndex
CREATE INDEX "decision_record_application_id_idx" ON "origination"."decision_record"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "decision_record_org_id_decision_no_key" ON "origination"."decision_record"("org_id", "decision_no");

-- CreateIndex
CREATE UNIQUE INDEX "contract_application_id_key" ON "origination"."contract"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_org_id_contract_no_key" ON "origination"."contract"("org_id", "contract_no");

-- CreateIndex
CREATE INDEX "official_letter_application_id_idx" ON "origination"."official_letter"("application_id");

-- CreateIndex
CREATE INDEX "disbursement_request_application_id_idx" ON "origination"."disbursement_request"("application_id");

-- CreateIndex
CREATE INDEX "disbursement_request_status_disburse_date_idx" ON "origination"."disbursement_request"("status", "disburse_date");

-- CreateIndex
CREATE INDEX "blacklist_org_id_register_no_hash_idx" ON "origination"."blacklist"("org_id", "register_no_hash");

-- CreateIndex
CREATE INDEX "notification_user_id_read_at_created_at_idx" ON "origination"."notification"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "comment_application_id_created_at_idx" ON "origination"."comment"("application_id", "created_at");

-- AddForeignKey
ALTER TABLE "origination"."approval_level" ADD CONSTRAINT "approval_level_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "origination"."product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."approval_level_member" ADD CONSTRAINT "approval_level_member_approval_level_id_fkey" FOREIGN KEY ("approval_level_id") REFERENCES "origination"."approval_level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."customer_contact" ADD CONSTRAINT "customer_contact_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "origination"."customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."customer_bank_account" ADD CONSTRAINT "customer_bank_account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "origination"."customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."loan_application" ADD CONSTRAINT "loan_application_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "origination"."product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."loan_application" ADD CONSTRAINT "loan_application_parent_application_id_fkey" FOREIGN KEY ("parent_application_id") REFERENCES "origination"."loan_application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."loan_application_borrower" ADD CONSTRAINT "loan_application_borrower_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."loan_application_borrower" ADD CONSTRAINT "loan_application_borrower_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "origination"."customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."loan_application_step" ADD CONSTRAINT "loan_application_step_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."income_salary" ADD CONSTRAINT "income_salary_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."income_salary" ADD CONSTRAINT "income_salary_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "origination"."customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."income_manual" ADD CONSTRAINT "income_manual_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."income_manual" ADD CONSTRAINT "income_manual_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "origination"."customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."income_summary" ADD CONSTRAINT "income_summary_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."income_summary" ADD CONSTRAINT "income_summary_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "origination"."customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."collateral" ADD CONSTRAINT "collateral_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."collateral_document" ADD CONSTRAINT "collateral_document_collateral_id_fkey" FOREIGN KEY ("collateral_id") REFERENCES "origination"."collateral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."repayment_schedule" ADD CONSTRAINT "repayment_schedule_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."repayment_schedule_row" ADD CONSTRAINT "repayment_schedule_row_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "origination"."repayment_schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."approval_request" ADD CONSTRAINT "approval_request_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."approval_vote" ADD CONSTRAINT "approval_vote_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "origination"."approval_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."decision_record" ADD CONSTRAINT "decision_record_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."contract" ADD CONSTRAINT "contract_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."official_letter" ADD CONSTRAINT "official_letter_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."disbursement_request" ADD CONSTRAINT "disbursement_request_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."comment" ADD CONSTRAINT "comment_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

