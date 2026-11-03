-- M11 (FR-12): хүсэлт тутамд нэг олголтын хүсэлт (docs/03 §relations 1—1). Өгөгдөл байхгүй (олголтын код анх удаа) тул давхардал үүсэхгүй.
DROP INDEX "origination"."disbursement_request_application_id_idx";
CREATE UNIQUE INDEX "disbursement_request_application_id_key" ON "origination"."disbursement_request"("application_id");
