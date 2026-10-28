-- AlterTable
ALTER TABLE "origination"."blacklist" ADD COLUMN     "branch_id" TEXT;

-- CreateIndex
CREATE INDEX "blacklist_org_id_is_active_idx" ON "origination"."blacklist"("org_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "blacklist_org_id_register_no_hash_list_type_key" ON "origination"."blacklist"("org_id", "register_no_hash", "list_type");

