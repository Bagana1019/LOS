-- Q-131/Q-132/Q-133/Q-134: хугацаа, 4 нүдээр Хар болгох хүлээлт, идэвхгүй болгох шалтгаан, эх сурвалж.
ALTER TABLE "origination"."blacklist" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE "origination"."blacklist" ADD COLUMN "valid_until" TIMESTAMP(3);
ALTER TABLE "origination"."blacklist" ADD COLUMN "deactivation_reason" TEXT;
ALTER TABLE "origination"."blacklist" ADD COLUMN "pending_severity" TEXT;
ALTER TABLE "origination"."blacklist" ADD CONSTRAINT "blacklist_source_check" CHECK ("source" IN ('COURT', 'CIB', 'INTERNAL', 'OTHER_NBFI'));
ALTER TABLE "origination"."blacklist" ADD CONSTRAINT "blacklist_pending_severity_check" CHECK ("pending_severity" IS NULL OR "pending_severity" IN ('BLACK', 'GREY'));
CREATE INDEX "blacklist_is_active_valid_until_idx" ON "origination"."blacklist"("is_active", "valid_until");
