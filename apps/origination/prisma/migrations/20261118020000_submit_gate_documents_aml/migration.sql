-- G1 / FR-9.2 / FR-3.4 (H4, C4). Cross-schema FK байхгүй: kyc шалгалтыг `screening_id` string-ээр.

-- 1) Илгээх үеийн AML шалгалтын лавлагаа (хүсэлт × харилцагч тутамд сүүлийн шийдвэр; түүх нь audit_log `AML_SCREENED`).
CREATE TABLE "origination"."application_aml_screening" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "borrower_role" TEXT NOT NULL,
    "screening_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "risk_level" TEXT NOT NULL,
    "hit_count" INTEGER NOT NULL,
    "list_versions" JSONB NOT NULL,
    "screened_at" TIMESTAMP(3) NOT NULL,
    "reused" BOOLEAN NOT NULL DEFAULT false,
    "application_version" INTEGER NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL,
    -- kyc-д илгээхээс ӨМНӨ уншсан customer.updated_at (шалгасан identity-ийн snapshot). Түгжээн дотор одоогийнхтой ТЭНЦҮҮ байх ёстой.
    "customer_updated_at" TIMESTAMP(3) NOT NULL,
    "checked_by" TEXT,
    CONSTRAINT "application_aml_screening_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_aml_screening_application_id_customer_id_key" ON "origination"."application_aml_screening"("application_id", "customer_id");
CREATE INDEX "application_aml_screening_org_id_screening_id_idx" ON "origination"."application_aml_screening"("org_id", "screening_id");

-- 2) FR-9.2: seed нь `update: {}` хийдэг тул аль хэдийн seed-лэгдсэн `br7.required_steps`-д `document` нэмнэ.
--    Зөвхөн хуучин анхдагч утгатай ЯГ тэнцүү мөрийг (admin өөрчлөөгүй) шинэчилнэ; тохируулсан утгыг хөндөхгүй.
UPDATE "origination"."setting"
   SET "value_json" = "value_json" || '["document"]'::jsonb, "updated_at" = CURRENT_TIMESTAMP, "updated_by" = 'migration:20261118020000'
 WHERE "key" = 'br7.required_steps'
   AND "value_json" = '["client", "inquiry", "income", "loan", "collateral", "installment", "score"]'::jsonb;
