-- M1 follow-up (FR-1): POST /applications `Idempotency-Key`. Хүрээ = байгууллага × үүсгэгч хэрэглэгч (created_by).
-- Хоёр багана NULL-тэй: хуучин мөр болон толгойгүй хүсэлт өөрчлөгдөхгүй. Postgres-ийн unique индекс NULL-ийг давхардал гэж үзэхгүй
-- тул түлхүүргүй мөр хязгааргүй байж болно. Cross-schema FK байхгүй.
ALTER TABLE "origination"."loan_application"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "idempotency_request_hash" TEXT;

CREATE UNIQUE INDEX "loan_application_org_id_created_by_idempotency_key_key"
  ON "origination"."loan_application"("org_id", "created_by", "idempotency_key");

-- Түлхүүр байвал hash заавал байна (replay-ийн бие тулгалт hash-гүйгээр худал 422 өгөхөөс сэргийлнэ).
ALTER TABLE "origination"."loan_application"
  ADD CONSTRAINT "loan_application_idempotency_pair_check"
  CHECK (("idempotency_key" IS NULL) = ("idempotency_request_hash" IS NULL));
