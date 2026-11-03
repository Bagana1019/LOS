-- M12c: сэжигтэй гүйлгээний дохио (BSA-FR-5). Incremental — baseline `20261028000000_init` хөндөгдөөгүй.
-- bsa_suspicion хүснэгтэд өмнө нь бичигч байгаагүй (хоосон) тул NOT NULL багана default-гүй нэмэх аюулгүй.
ALTER TABLE "scoring"."bsa_suspicion" ADD COLUMN "detect_key" TEXT NOT NULL;
ALTER TABLE "scoring"."bsa_suspicion" ADD COLUMN "new_category_code" TEXT;
CREATE UNIQUE INDEX "bsa_suspicion_detect_key_uq" ON "scoring"."bsa_suspicion"("analysis_id", "detect_key");
