-- Дансны хуулгын шинжилгээ (M12, docs/05): Модуль 0-ийн baseline (20261028000000_init)-ийн bsa_* хүснэгтүүд дээрх ӨСӨЛТ.
-- Baseline-ийн bsa_import_job / bsa_transaction / bsa_analysis хүснэгтэд энэ модулиас өмнө бичигдээгүй (хоосон) тул
-- NOT NULL багана default-гүй нэмэх нь аюулгүй. Plaintext PII багана (iban, holder_name, description, counterparty_name) устгагдаж
-- шифрлэгдсэн хувилбараар (`*_encrypted`) солигдоно (NFR-3, CLAUDE.md §6.5).

-- DropIndex
DROP INDEX "scoring"."bsa_analysis_org_id_status_idx";

-- DropIndex
DROP INDEX "scoring"."bsa_analysis_application_id_customer_id_version_key";

-- DropIndex
DROP INDEX "scoring"."bsa_import_job_status_idx";

-- AlterTable
ALTER TABLE "scoring"."bsa_analysis" ADD COLUMN     "borrower_id" TEXT,
ADD COLUMN     "customer_snapshot_encrypted" TEXT,
ADD COLUMN     "own_accounts_encrypted" TEXT,
ADD COLUMN     "register_no_hash" TEXT,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "scoring"."bsa_import_job" DROP COLUMN "holder_name",
DROP COLUMN "iban",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "branch_id" TEXT,
ADD COLUMN     "file_name_encrypted" TEXT NOT NULL,
ADD COLUMN     "finished_at" TIMESTAMP(3),
ADD COLUMN     "holder_name_encrypted" TEXT,
ADD COLUMN     "iban_encrypted" TEXT,
ADD COLUMN     "mime_type" TEXT NOT NULL,
ADD COLUMN     "sha256" TEXT NOT NULL,
ADD COLUMN     "size_bytes" INTEGER NOT NULL,
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "warnings_json" JSONB,
ALTER COLUMN "format" SET NOT NULL,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "scoring"."bsa_transaction" DROP COLUMN "counterparty_name",
DROP COLUMN "description",
ADD COLUMN     "branch_id" TEXT,
ADD COLUMN     "counterparty_name_encrypted" TEXT,
ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "dedupe_key" TEXT NOT NULL,
ADD COLUMN     "description_encrypted" TEXT NOT NULL,
ADD COLUMN     "seq" INTEGER NOT NULL,
ADD COLUMN     "statement_key" TEXT NOT NULL,
ADD COLUMN     "updated_by" TEXT,
ALTER COLUMN "channel" SET NOT NULL,
ALTER COLUMN "channel" SET DEFAULT 'OTHER',
ALTER COLUMN "confidence" SET NOT NULL,
ALTER COLUMN "confidence" SET DEFAULT 0,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "scoring"."bsa_category" ADD COLUMN     "branch_id" TEXT,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "scoring"."bsa_rule" ADD COLUMN     "branch_id" TEXT,
ALTER COLUMN "priority" DROP DEFAULT,
ALTER COLUMN "source" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "scoring"."bsa_analysis_event" (
    "id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "detail_json" JSONB,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "bsa_analysis_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bsa_analysis_event_history_idx" ON "scoring"."bsa_analysis_event"("analysis_id", "at" DESC);

-- CreateIndex
CREATE INDEX "bsa_analysis_list_idx" ON "scoring"."bsa_analysis"("org_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "bsa_analysis_application_idx" ON "scoring"."bsa_analysis"("org_id", "application_id");

-- CreateIndex
CREATE INDEX "bsa_analysis_register_idx" ON "scoring"."bsa_analysis"("org_id", "register_no_hash");

-- CreateIndex
CREATE INDEX "bsa_analysis_retention_idx" ON "scoring"."bsa_analysis"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bsa_analysis_version_uq" ON "scoring"."bsa_analysis"("org_id", "application_id", "customer_id", "version");

-- CreateIndex
CREATE INDEX "bsa_import_job_list_idx" ON "scoring"."bsa_import_job"("org_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bsa_import_job_file_uq" ON "scoring"."bsa_import_job"("analysis_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "bsa_transaction_dedupe_uq" ON "scoring"."bsa_transaction"("analysis_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "bsa_rule_natural_uq" ON "scoring"."bsa_rule"("org_id", "direction", "match_type", "pattern", "category_code", "source");

-- AddForeignKey
ALTER TABLE "scoring"."bsa_analysis_event" ADD CONSTRAINT "bsa_analysis_event_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "scoring"."bsa_analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "scoring"."bsa_import_job_analysis_id_idx" RENAME TO "bsa_import_job_analysis_idx";

-- RenameIndex
ALTER INDEX "scoring"."bsa_transaction_analysis_id_txn_date_idx" RENAME TO "bsa_transaction_date_idx";

-- RenameIndex
ALTER INDEX "scoring"."bsa_transaction_analysis_id_category_code_idx" RENAME TO "bsa_transaction_category_idx";

-- RenameIndex
ALTER INDEX "scoring"."bsa_transaction_import_job_id_idx" RENAME TO "bsa_transaction_job_idx";

-- RenameIndex
ALTER INDEX "scoring"."bsa_category_org_id_code_key" RENAME TO "bsa_category_code_uq";

-- RenameIndex
ALTER INDEX "scoring"."bsa_rule_org_id_direction_priority_idx" RENAME TO "bsa_rule_priority_idx";

