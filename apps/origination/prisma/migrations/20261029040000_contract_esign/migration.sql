-- FR-11.4 цахим гарын үсэг: contract мөрт гарын үсгийн сувгийн/төлвийн багана нэмнэ (incremental; baseline-д хүрэхгүй).
ALTER TABLE "origination"."contract"
  ADD COLUMN "sign_channel" TEXT NOT NULL DEFAULT 'PAPER',
  ADD COLUMN "signing_request_id" TEXT,
  ADD COLUMN "signing_status" TEXT,
  ADD COLUMN "signing_failure_reason" TEXT,
  ADD COLUMN "signing_sent_at" TIMESTAMP(3);

-- CHECK constraints (гараар): enum-ууд @los/contracts-д тодорхойлогдсон тул Prisma enum биш, DB түвшинд хамгаална.
ALTER TABLE "origination"."contract"
  ADD CONSTRAINT "contract_sign_channel_check"
  CHECK ("sign_channel" IN ('PAPER', 'ESIGN'));

ALTER TABLE "origination"."contract"
  ADD CONSTRAINT "contract_signing_status_check"
  CHECK ("signing_status" IS NULL OR "signing_status" IN ('PENDING', 'IN_PROGRESS', 'FINALIZING', 'SIGNED', 'DECLINED', 'EXPIRED', 'FAILED', 'CANCELLED'));

ALTER TABLE "origination"."contract"
  ADD CONSTRAINT "contract_signing_failure_reason_check"
  CHECK ("signing_failure_reason" IS NULL OR "signing_failure_reason" IN ('DECLINED', 'EXPIRED', 'IDENTITY_MISMATCH', 'INTEGRITY_ERROR', 'PROVIDER_ERROR', 'CANCELLED'));

-- SIGNED төлөв заавал гарын үсэгтэй файлтай байна — G4 олголтын хаалга signed_file_id-аар шалгадаг тул хоёр талбар зөрөх боломжгүй.
ALTER TABLE "origination"."contract"
  ADD CONSTRAINT "contract_signed_requires_file_check"
  CHECK ("signing_status" IS DISTINCT FROM 'SIGNED' OR "signed_file_id" IS NOT NULL);
