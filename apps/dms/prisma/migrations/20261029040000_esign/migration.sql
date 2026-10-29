-- CreateTable
CREATE TABLE "dms"."signing_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "contract_no" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "provider_ref" TEXT,
    "challenge_code" TEXT,
    "deep_link" TEXT,
    "session_expires_at" TIMESTAMPTZ(3),
    "source_file_id" TEXT NOT NULL,
    "signed_file_id" TEXT,
    "signature_file_id" TEXT,
    "original_sha256" TEXT NOT NULL,
    "signed_sha256" TEXT,
    "signer_customer_id" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_register_encrypted" TEXT NOT NULL,
    "signer_phone_encrypted" TEXT NOT NULL,
    "signer_register_masked" TEXT NOT NULL,
    "signer_phone_masked" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "link_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "verification_code" TEXT,
    "document_viewed_at" TIMESTAMPTZ(3),
    "consent_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "certificate" JSONB,
    "provider_txn_id" TEXT,
    "provider_mock" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "failure_detail" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_at" TIMESTAMPTZ(3),

    CONSTRAINT "signing_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dms"."signing_event" (
    "id" BIGSERIAL NOT NULL,
    "signing_request_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "signing_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signing_request_token_hash_key" ON "dms"."signing_request"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "signing_request_verification_code_key" ON "dms"."signing_request"("verification_code");

-- CreateIndex
CREATE INDEX "signing_request_application_id_idx" ON "dms"."signing_request"("application_id");

-- CreateIndex
CREATE INDEX "signing_request_contract_id_status_idx" ON "dms"."signing_request"("contract_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "signing_request_provider_provider_ref_key" ON "dms"."signing_request"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "signing_event_signing_request_id_at_idx" ON "dms"."signing_event"("signing_request_id", "at");

-- AddForeignKey
ALTER TABLE "dms"."signing_event" ADD CONSTRAINT "signing_event_signing_request_id_fkey" FOREIGN KEY ("signing_request_id") REFERENCES "dms"."signing_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CHECK constraints (hand-written): enum-ууд @los/contracts-д тодорхойлогдсон тул Prisma enum биш, DB түвшинд хамгаална.
ALTER TABLE "dms"."signing_request"
  ADD CONSTRAINT "signing_request_status_check"
  CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'FINALIZING', 'SIGNED', 'DECLINED', 'EXPIRED', 'FAILED', 'CANCELLED'));

ALTER TABLE "dms"."signing_request"
  ADD CONSTRAINT "signing_request_provider_check"
  CHECK ("provider" IS NULL OR "provider" IN ('TRIDUM', 'MONPASS'));

ALTER TABLE "dms"."signing_request"
  ADD CONSTRAINT "signing_request_failure_reason_check"
  CHECK ("failure_reason" IS NULL OR "failure_reason" IN ('DECLINED', 'EXPIRED', 'IDENTITY_MISMATCH', 'INTEGRITY_ERROR', 'PROVIDER_ERROR', 'CANCELLED'));

ALTER TABLE "dms"."signing_request"
  ADD CONSTRAINT "signing_request_attempts_check"
  CHECK ("attempts" >= 0);

-- SIGNED төлөв бүрэн байна: ContractSigned event (origination-ы G4 хаалга) эдгээр талбарыг заавал шаарддаг.
ALTER TABLE "dms"."signing_request"
  ADD CONSTRAINT "signing_request_signed_complete_check"
  CHECK ("status" <> 'SIGNED' OR (
    "signed_file_id" IS NOT NULL AND "signature_file_id" IS NOT NULL AND "signed_sha256" IS NOT NULL
    AND "verification_code" IS NOT NULL AND "signed_at" IS NOT NULL
  ));

-- Нэг гэрээнд ЗӨВХӨН нэг идэвхтэй (PENDING | IN_PROGRESS | FINALIZING) хүсэлт — race condition-оос DB түвшинд хамгаална.
-- Төгсгөлийн төлөвтэй (SIGNED, DECLINED, EXPIRED, FAILED, CANCELLED) түүх хязгааргүй хадгалагдана.
-- Prisma partial index-ийг мэдэхгүй тул schema.prisma-д тусгаагүй.
CREATE UNIQUE INDEX "signing_request_active_contract_key"
  ON "dms"."signing_request" ("contract_id")
  WHERE "status" IN ('PENDING', 'IN_PROGRESS', 'FINALIZING');
