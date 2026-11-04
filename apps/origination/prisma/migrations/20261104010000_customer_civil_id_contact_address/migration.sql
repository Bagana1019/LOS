-- Customer form fixes: ХУР-аас ирэх ургийн овог, иргэний бүртгэлийн дугаар; яаралтай холбоо барих хүний гэрийн хаяг 4 түвшинтэй (нэмэлт)
ALTER TABLE "origination"."customer" ADD COLUMN "clan_name" TEXT;
ALTER TABLE "origination"."customer" ADD COLUMN "civil_id" TEXT;
ALTER TABLE "origination"."customer_contact" ADD COLUMN "home_address_json" JSONB;
-- Хуучин нэг мөр текстийг дэлгэрэнгүй хаяг болгож хадгална (бусад түвшин "-")
UPDATE "origination"."customer_contact"
   SET "home_address_json" = jsonb_build_object('province', '-', 'district', '-', 'khoroo', '-', 'detail', "home_address")
 WHERE "home_address" IS NOT NULL AND btrim("home_address") <> '';
