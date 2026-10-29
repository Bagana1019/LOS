-- Модуль 6 (FR-14.2, FR-14.3): үнэлгээний арга, системийн санал, haircut-ийн эх сурвалж, гадны үнэлгээ заавал эсэх, үнэлгээчний лицензийн дугаар.
ALTER TABLE "valuation"."collateral_valuation"
  ADD COLUMN "method" TEXT,
  ADD COLUMN "suggested_value" DECIMAL(18,2),
  ADD COLUMN "haircut_source" TEXT,
  ADD COLUMN "external_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "license_no" TEXT;
