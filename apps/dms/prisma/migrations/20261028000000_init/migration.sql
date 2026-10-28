-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "dms";

-- CreateTable
CREATE TABLE "dms"."outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dms"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "dms"."file" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by" TEXT,
    "retention_until" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dms"."document" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "related_entity" TEXT NOT NULL,
    "related_id" TEXT,
    "note" TEXT,
    "file_id" TEXT NOT NULL,
    "checklist_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dms"."contract_template" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "docx_file_id" TEXT NOT NULL,
    "placeholders_json" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "contract_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dms"."document_checklist" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "related_entity" TEXT NOT NULL,
    "asset_type" TEXT,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "document_checklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dms"."retention_policy" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "retention_years" INTEGER NOT NULL,
    "auto_delete" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "retention_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "dms"."outbox"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "file_org_id_sha256_idx" ON "dms"."file"("org_id", "sha256");

-- CreateIndex
CREATE INDEX "file_retention_until_idx" ON "dms"."file"("retention_until");

-- CreateIndex
CREATE UNIQUE INDEX "file_bucket_storage_key_key" ON "dms"."file"("bucket", "storage_key");

-- CreateIndex
CREATE INDEX "document_application_id_checklist_key_idx" ON "dms"."document"("application_id", "checklist_key");

-- CreateIndex
CREATE INDEX "contract_template_org_id_product_id_type_is_active_idx" ON "dms"."contract_template"("org_id", "product_id", "type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "document_checklist_org_id_product_id_key_key" ON "dms"."document_checklist"("org_id", "product_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policy_org_id_entity_type_key" ON "dms"."retention_policy"("org_id", "entity_type");

-- AddForeignKey
ALTER TABLE "dms"."document" ADD CONSTRAINT "document_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "dms"."file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dms"."contract_template" ADD CONSTRAINT "contract_template_docx_file_id_fkey" FOREIGN KEY ("docx_file_id") REFERENCES "dms"."file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

