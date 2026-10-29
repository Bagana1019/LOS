-- CreateTable
CREATE TABLE "origination"."pricing_tier" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT,
    "version" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "min_score" INTEGER NOT NULL,
    "interest_rate" DECIMAL(7,4) NOT NULL,
    "fee_rate" DECIMAL(7,4) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "pricing_tier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_tier_org_id_product_id_is_active_idx" ON "origination"."pricing_tier"("org_id", "product_id", "is_active");

-- CreateIndex
CREATE INDEX "pricing_tier_org_id_product_id_version_idx" ON "origination"."pricing_tier"("org_id", "product_id", "version");
