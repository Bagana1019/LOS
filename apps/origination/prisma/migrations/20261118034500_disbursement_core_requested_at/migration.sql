-- H1 (FR-12.5): Core openLoan-ий lease / fencing token. APPROVED + core_requested_at = "Core руу илгээсэн, үр дүн тодорхойгүй".
-- Сэргээлт (reconcile / sweeper) зөвхөн lease хугацаа хэтэрсэн мөрийг авна; лавлагаа = disbursement_request.id (Core idempotency key).
ALTER TABLE "origination"."disbursement_request" ADD COLUMN "core_requested_at" TIMESTAMP(3);

CREATE INDEX "disbursement_request_status_core_requested_at_idx" ON "origination"."disbursement_request"("status", "core_requested_at");
