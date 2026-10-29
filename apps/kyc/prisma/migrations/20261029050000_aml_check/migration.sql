-- CreateTable
CREATE TABLE "kyc"."aml_check" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "application_id" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "risk_score" DECIMAL(5,2) NOT NULL,
    "risk_level" TEXT NOT NULL,
    "risk_factors_json" JSONB NOT NULL,
    "subject_name" TEXT NOT NULL,
    "register_no_masked" TEXT NOT NULL,
    "register_no_hash" TEXT NOT NULL,
    "register_no_encrypted" TEXT NOT NULL,
    "subject_json" JSONB NOT NULL,
    "list_versions_json" JSONB NOT NULL,
    "screened_at" TIMESTAMP(3) NOT NULL,
    "screened_by" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aml_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc"."aml_hit" (
    "id" UUID NOT NULL,
    "screening_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "list" TEXT NOT NULL,
    "match_type" TEXT NOT NULL,
    "score" DECIMAL(5,4) NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entry_ref" TEXT NOT NULL,
    "entry_name" TEXT NOT NULL,
    "matched_value" TEXT,
    "details_json" JSONB NOT NULL,
    "list_version" TEXT NOT NULL,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aml_hit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc"."blacklist_projection" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "register_no_hash" TEXT NOT NULL,
    "customer_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "list_type" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blacklist_projection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aml_check_org_id_customer_id_screened_at_idx" ON "kyc"."aml_check"("org_id", "customer_id", "screened_at" DESC);

-- CreateIndex
CREATE INDEX "aml_check_org_id_register_no_hash_idx" ON "kyc"."aml_check"("org_id", "register_no_hash");

-- CreateIndex
CREATE INDEX "aml_hit_screening_id_position_idx" ON "kyc"."aml_hit"("screening_id", "position");

-- CreateIndex
CREATE INDEX "aml_hit_status_list_idx" ON "kyc"."aml_hit"("status", "list");

-- CreateIndex
CREATE INDEX "blacklist_projection_org_id_register_no_hash_idx" ON "kyc"."blacklist_projection"("org_id", "register_no_hash");

-- AddForeignKey
ALTER TABLE "kyc"."aml_hit" ADD CONSTRAINT "aml_hit_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "kyc"."aml_check"("id") ON DELETE CASCADE ON UPDATE CASCADE;

