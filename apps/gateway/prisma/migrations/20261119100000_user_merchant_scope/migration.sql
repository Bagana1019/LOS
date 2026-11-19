-- docs/05-merchant-pos.md §2, §8: merchant POS users (MERCHANT_ADMIN / MERCHANT_STAFF) carry merchant/store scope; string ids, no cross-schema FK.
ALTER TABLE "iam"."user" ADD COLUMN "merchant_id" TEXT, ADD COLUMN "store_id" TEXT;
CREATE INDEX "user_merchant_id_idx" ON "iam"."user"("merchant_id");
