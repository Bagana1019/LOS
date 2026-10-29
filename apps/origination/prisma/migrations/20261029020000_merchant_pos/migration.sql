-- Мерчант POS (B2B2C) — docs/05-merchant-pos.md §7. Зөвхөн ӨСГӨГДӨХ (incremental) миграци: `prisma migrate diff`-ээр үүссэн merchant 6 хүснэгт + доорх CHECK invariant-ууд.
-- `origination` schema болон `outbox` нь baseline `20261028000000_init`-ээс ирнэ (docs/00-foundation.md: baseline-д хүрэхгүй).
-- Доорх "Invariants" хэсэг Prisma-д илэрхийлэгдэхгүй CHECK-үүд: статус/мөнгө/хувь/оролдлогын утгыг аппликейшний алдаанаас үл хамааран DB түвшинд хамгаална.

-- CreateTable
CREATE TABLE "origination"."merchant" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "company_register_no" TEXT,
    "category" TEXT,
    "contact_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "branch_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_reason" TEXT,
    "commission_rate" DECIMAL(7,4) NOT NULL,
    "max_ticket_amount" DECIMAL(18,2) NOT NULL,
    "daily_limit_amount" DECIMAL(18,2),
    "settlement_bank_code" TEXT NOT NULL,
    "settlement_account_encrypted" TEXT NOT NULL,
    "settlement_account_last4" TEXT NOT NULL,
    "settlement_holder_name" TEXT NOT NULL,
    "contract_no" TEXT,
    "contract_signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."merchant_store" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "merchant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_json" JSONB NOT NULL,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "merchant_store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."pos_lease_plan" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "merchant_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product_id" TEXT,
    "goods_categories_json" JSONB NOT NULL,
    "min_amount" DECIMAL(18,2) NOT NULL,
    "max_amount" DECIMAL(18,2) NOT NULL,
    "term_options_json" JSONB NOT NULL,
    "annual_rate" DECIMAL(7,4) NOT NULL,
    "fee_rate" DECIMAL(7,4) NOT NULL,
    "min_down_payment_rate" DECIMAL(7,4) NOT NULL,
    "commission_rate" DECIMAL(7,4),
    "policy_json" JSONB NOT NULL DEFAULT '{}',
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "pos_lease_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."pos_lease" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "lease_no" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "merchant_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "buyer_register_encrypted" TEXT NOT NULL,
    "buyer_register_hash" TEXT NOT NULL,
    "buyer_register_masked" TEXT NOT NULL,
    "buyer_phone" TEXT NOT NULL,
    "buyer_last_name" TEXT,
    "buyer_first_name" TEXT,
    "goods_category" TEXT NOT NULL,
    "goods_name" TEXT NOT NULL,
    "goods_serial_no" TEXT,
    "goods_price" DECIMAL(18,2) NOT NULL,
    "quote_json" JSONB NOT NULL,
    "down_payment" DECIMAL(18,2) NOT NULL,
    "financed_amount" DECIMAL(18,2) NOT NULL,
    "fee_amount" DECIMAL(18,2) NOT NULL,
    "principal" DECIMAL(18,2) NOT NULL,
    "term_months" INTEGER NOT NULL,
    "annual_rate" DECIMAL(7,4) NOT NULL,
    "monthly_payment" DECIMAL(18,2) NOT NULL,
    "merchant_commission_amount" DECIMAL(18,2) NOT NULL,
    "merchant_net_amount" DECIMAL(18,2) NOT NULL,
    "decision" TEXT,
    "decision_reasons_json" JSONB NOT NULL DEFAULT '[]',
    "dti_ratio" DECIMAL(12,4),
    "affordability_json" JSONB,
    "screening_json" JSONB,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" TEXT,
    "decision_comment" TEXT,
    "consent_verified_at" TIMESTAMPTZ(6),
    "consent_text_version" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "delivered_by" TEXT,
    "settled_at" TIMESTAMPTZ(6),
    "settlement_ref" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "application_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "pos_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."pos_lease_otp" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "lease_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_to_masked" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_lease_otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."pos_lease_event" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "lease_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor_id" TEXT,
    "actor_label" TEXT NOT NULL,
    "data_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_lease_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_org_id_status_idx" ON "origination"."merchant"("org_id", "status");

-- CreateIndex
CREATE INDEX "merchant_branch_id_idx" ON "origination"."merchant"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_org_id_code_key" ON "origination"."merchant"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_store_merchant_id_code_key" ON "origination"."merchant_store"("merchant_id", "code");

-- CreateIndex
CREATE INDEX "pos_lease_plan_org_id_merchant_id_idx" ON "origination"."pos_lease_plan"("org_id", "merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pos_lease_plan_org_id_code_key" ON "origination"."pos_lease_plan"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "pos_lease_lease_no_key" ON "origination"."pos_lease"("lease_no");

-- CreateIndex
CREATE INDEX "pos_lease_merchant_id_status_idx" ON "origination"."pos_lease"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "pos_lease_merchant_id_created_at_idx" ON "origination"."pos_lease"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_lease_store_id_created_at_idx" ON "origination"."pos_lease"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_lease_org_id_created_at_idx" ON "origination"."pos_lease"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "pos_lease_branch_id_idx" ON "origination"."pos_lease"("branch_id");

-- CreateIndex
CREATE INDEX "pos_lease_buyer_register_hash_idx" ON "origination"."pos_lease"("buyer_register_hash");

-- CreateIndex
CREATE INDEX "pos_lease_status_expires_at_idx" ON "origination"."pos_lease"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_lease_merchant_id_idempotency_key_key" ON "origination"."pos_lease"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "pos_lease_otp_lease_id_purpose_sent_at_idx" ON "origination"."pos_lease_otp"("lease_id", "purpose", "sent_at");

-- CreateIndex
CREATE INDEX "pos_lease_event_lease_id_at_idx" ON "origination"."pos_lease_event"("lease_id", "at");

-- AddForeignKey
ALTER TABLE "origination"."merchant_store" ADD CONSTRAINT "merchant_store_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "origination"."merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pos_lease_plan" ADD CONSTRAINT "pos_lease_plan_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "origination"."merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pos_lease" ADD CONSTRAINT "pos_lease_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "origination"."merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pos_lease" ADD CONSTRAINT "pos_lease_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "origination"."merchant_store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pos_lease" ADD CONSTRAINT "pos_lease_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "origination"."pos_lease_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pos_lease_otp" ADD CONSTRAINT "pos_lease_otp_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "origination"."pos_lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "origination"."pos_lease_event" ADD CONSTRAINT "pos_lease_event_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "origination"."pos_lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invariants (CHECK) ----------------------------------------------------------------------------------------------------------

ALTER TABLE "origination"."merchant"
  ADD CONSTRAINT "merchant_status_check" CHECK ("status" IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
  ADD CONSTRAINT "merchant_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "merchant_commission_rate_check" CHECK ("commission_rate" >= 0 AND "commission_rate" <= 1),
  ADD CONSTRAINT "merchant_max_ticket_amount_check" CHECK ("max_ticket_amount" > 0),
  ADD CONSTRAINT "merchant_daily_limit_amount_check" CHECK ("daily_limit_amount" IS NULL OR "daily_limit_amount" > 0);

ALTER TABLE "origination"."merchant_store"
  ADD CONSTRAINT "merchant_store_version_check" CHECK ("version" >= 1);

ALTER TABLE "origination"."pos_lease_plan"
  ADD CONSTRAINT "pos_lease_plan_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "pos_lease_plan_amount_range_check" CHECK ("min_amount" >= 0 AND "max_amount" >= "min_amount"),
  ADD CONSTRAINT "pos_lease_plan_rates_check" CHECK (
    "annual_rate" >= 0 AND "annual_rate" <= 1
    AND "fee_rate" >= 0 AND "fee_rate" <= 1
    AND "min_down_payment_rate" >= 0 AND "min_down_payment_rate" <= 1
    AND ("commission_rate" IS NULL OR ("commission_rate" >= 0 AND "commission_rate" <= 1))
  ),
  ADD CONSTRAINT "pos_lease_plan_validity_check" CHECK ("valid_from" IS NULL OR "valid_to" IS NULL OR "valid_to" >= "valid_from");

ALTER TABLE "origination"."pos_lease"
  ADD CONSTRAINT "pos_lease_status_check" CHECK ("status" IN ('DRAFT', 'REFERRED', 'APPROVED', 'DECLINED', 'ACCEPTED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED')),
  ADD CONSTRAINT "pos_lease_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('APPROVE', 'REFER', 'DECLINE')),
  ADD CONSTRAINT "pos_lease_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "pos_lease_money_check" CHECK (
    "goods_price" > 0 AND "down_payment" >= 0 AND "down_payment" <= "goods_price"
    AND "financed_amount" >= 0 AND "fee_amount" >= 0 AND "principal" >= 0 AND "monthly_payment" >= 0
    AND "merchant_commission_amount" >= 0 AND "merchant_net_amount" >= 0
  ),
  ADD CONSTRAINT "pos_lease_term_rate_check" CHECK ("term_months" > 0 AND "annual_rate" >= 0 AND "annual_rate" <= 1),
  -- Амьдралын мөчлөг: төлөв нь холбогдох цагийн тэмдэгтэй зөрчилдөхгүй.
  ADD CONSTRAINT "pos_lease_lifecycle_check" CHECK (
    ("status" NOT IN ('ACCEPTED', 'DELIVERED', 'SETTLED') OR "accepted_at" IS NOT NULL)
    AND ("status" NOT IN ('DELIVERED', 'SETTLED') OR "delivered_at" IS NOT NULL)
    AND ("status" <> 'SETTLED' OR "settled_at" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
  );

ALTER TABLE "origination"."pos_lease_otp"
  ADD CONSTRAINT "pos_lease_otp_purpose_check" CHECK ("purpose" IN ('CONSENT', 'ACCEPT')),
  ADD CONSTRAINT "pos_lease_otp_attempts_check" CHECK ("attempts" >= 0);
