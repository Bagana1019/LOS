-- AlterTable
ALTER TABLE "origination"."loan_application_borrower" ADD COLUMN     "consent_file_id" TEXT,
ADD COLUMN     "consent_signed_at" TIMESTAMP(3),
ADD COLUMN     "guarantee_amount" DECIMAL(18,2),
ADD COLUMN     "guarantee_type" TEXT,
ADD COLUMN     "income_included" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liability_share" DECIMAL(7,4),
ADD COLUMN     "note" TEXT,
ADD COLUMN     "relation_to_primary" TEXT;

-- CreateTable
CREATE TABLE "origination"."payment_invoice" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "schedule_row_id" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MNT',
    "sender_invoice_no" TEXT NOT NULL,
    "provider_invoice_id" TEXT,
    "qr_text" TEXT,
    "qr_image" TEXT,
    "deeplinks_json" JSONB,
    "bank_transfer_json" JSONB,
    "provider_response_json" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "payment_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."payment" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "provider" TEXT NOT NULL,
    "provider_payment_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MNT',
    "paid_at" TIMESTAMP(3) NOT NULL,
    "payer_name" TEXT,
    "payer_account_masked" TEXT,
    "unallocated_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."payment_allocation" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "schedule_row_id" TEXT NOT NULL,
    "interest_paid" DECIMAL(18,2) NOT NULL,
    "principal_paid" DECIMAL(18,2) NOT NULL,
    "total_paid" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."bank_transfer_entry" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "bank_code" TEXT NOT NULL,
    "bank_reference" TEXT NOT NULL,
    "account_no" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MNT',
    "value_date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "payer_name" TEXT,
    "payer_account_masked" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "payment_id" TEXT,
    "raw_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transfer_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."notification_template" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'mn',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."notification_delivery" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "address" TEXT,
    "application_id" TEXT,
    "branch_id" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "scheduled_for" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."notification_preference" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."push_device" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."report_run" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "report_key" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "params_json" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL,
    "run_by" TEXT,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_invoice_sender_invoice_no_key" ON "origination"."payment_invoice"("sender_invoice_no");

-- CreateIndex
CREATE INDEX "payment_invoice_application_id_idx" ON "origination"."payment_invoice"("application_id");

-- CreateIndex
CREATE INDEX "payment_invoice_status_expires_at_idx" ON "origination"."payment_invoice"("status", "expires_at");

-- CreateIndex
CREATE INDEX "payment_invoice_provider_provider_invoice_id_idx" ON "origination"."payment_invoice"("provider", "provider_invoice_id");

-- CreateIndex
CREATE INDEX "payment_application_id_paid_at_idx" ON "origination"."payment"("application_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_provider_payment_id_key" ON "origination"."payment"("provider", "provider_payment_id");

-- CreateIndex
CREATE INDEX "payment_allocation_payment_id_idx" ON "origination"."payment_allocation"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocation_schedule_row_id_idx" ON "origination"."payment_allocation"("schedule_row_id");

-- CreateIndex
CREATE INDEX "bank_transfer_entry_status_idx" ON "origination"."bank_transfer_entry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_entry_bank_code_bank_reference_key" ON "origination"."bank_transfer_entry"("bank_code", "bank_reference");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_org_id_type_channel_locale_key" ON "origination"."notification_template"("org_id", "type", "channel", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_dedupe_key_key" ON "origination"."notification_delivery"("dedupe_key");

-- CreateIndex
CREATE INDEX "notification_delivery_status_next_attempt_at_idx" ON "origination"."notification_delivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notification_delivery_application_id_idx" ON "origination"."notification_delivery"("application_id");

-- CreateIndex
CREATE INDEX "notification_delivery_recipient_type_recipient_id_idx" ON "origination"."notification_delivery"("recipient_type", "recipient_id");

-- CreateIndex
CREATE INDEX "notification_delivery_org_id_branch_id_scheduled_for_idx" ON "origination"."notification_delivery"("org_id", "branch_id", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_org_id_subject_type_subject_id_chan_key" ON "origination"."notification_preference"("org_id", "subject_type", "subject_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "push_device_token_key" ON "origination"."push_device"("token");

-- CreateIndex
CREATE INDEX "push_device_owner_type_owner_id_is_active_idx" ON "origination"."push_device"("owner_type", "owner_id", "is_active");

-- CreateIndex
CREATE INDEX "report_run_report_key_run_at_idx" ON "origination"."report_run"("report_key", "run_at");

-- CreateIndex
CREATE INDEX "loan_application_borrower_application_id_idx" ON "origination"."loan_application_borrower"("application_id");

-- AddForeignKey
ALTER TABLE "origination"."payment_invoice" ADD CONSTRAINT "payment_invoice_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."payment" ADD CONSTRAINT "payment_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "origination"."loan_application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."payment" ADD CONSTRAINT "payment_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "origination"."payment_invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "origination"."payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."payment_allocation" ADD CONSTRAINT "payment_allocation_schedule_row_id_fkey" FOREIGN KEY ("schedule_row_id") REFERENCES "origination"."repayment_schedule_row"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

