-- Модуль 6/9 (Барьцаа, баримт): давхар барьцааны түлхүүр, үнэлгээний хуулбар, баримтын файлын мета. Нэмэлт багана л — baseline-д хүрэхгүй.
ALTER TABLE "origination"."collateral"
  ADD COLUMN "asset_key" TEXT,
  ADD COLUMN "xyp_ref" TEXT,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "valuation_id" TEXT,
  ADD COLUMN "valuation_source" TEXT,
  ADD COLUMN "valued_at" TIMESTAMP(3),
  ADD COLUMN "valuation_valid_until" TIMESTAMP(3),
  ADD COLUMN "valuation_override_reason" TEXT,
  ADD COLUMN "external_valuation_required" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "origination"."collateral_document"
  ADD COLUMN "file_name" TEXT,
  ADD COLUMN "mime" TEXT,
  ADD COLUMN "size" INTEGER,
  ADD COLUMN "note" TEXT;

-- FR-6.6: нэг хүсэлтэд нэг хөрөнгө давхардахгүй (NULL asset_key давхцаж болно)
CREATE UNIQUE INDEX "collateral_application_id_asset_key_key" ON "origination"."collateral"("application_id", "asset_key");
CREATE INDEX "collateral_org_id_asset_key_idx" ON "origination"."collateral"("org_id", "asset_key");
