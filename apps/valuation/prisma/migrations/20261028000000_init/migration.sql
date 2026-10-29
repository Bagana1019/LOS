-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "valuation";

-- CreateTable
CREATE TABLE "valuation"."outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuation"."processed_events" (
    "consumer" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "valuation"."collateral" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "collateral_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "product_id" TEXT,
    "asset_type" TEXT NOT NULL,
    "description_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "collateral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuation"."collateral_valuation" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "collateral_ref_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "appraiser" TEXT,
    "valued_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3),
    "market_value" DECIMAL(18,2) NOT NULL,
    "haircut_rate" DECIMAL(7,4),
    "collateral_value" DECIMAL(18,2),
    "method_json" JSONB,
    "report_file_id" TEXT,
    "override_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "collateral_valuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuation"."base_price" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "key_json" JSONB NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "valid_from" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "base_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "valuation"."haircut_rule" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_id" TEXT,
    "asset_type" TEXT NOT NULL,
    "haircut_rate" DECIMAL(7,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "haircut_rule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "valuation"."outbox"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "collateral_application_id_idx" ON "valuation"."collateral"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "collateral_org_id_collateral_id_key" ON "valuation"."collateral"("org_id", "collateral_id");

-- CreateIndex
CREATE INDEX "collateral_valuation_collateral_ref_id_valued_at_idx" ON "valuation"."collateral_valuation"("collateral_ref_id", "valued_at");

-- CreateIndex
CREATE INDEX "base_price_org_id_asset_type_valid_from_idx" ON "valuation"."base_price"("org_id", "asset_type", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "haircut_rule_org_id_product_id_asset_type_key" ON "valuation"."haircut_rule"("org_id", "product_id", "asset_type");

-- AddForeignKey
ALTER TABLE "valuation"."collateral_valuation" ADD CONSTRAINT "collateral_valuation_collateral_ref_id_fkey" FOREIGN KEY ("collateral_ref_id") REFERENCES "valuation"."collateral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

