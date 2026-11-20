-- Audit seal: sealer/verify-ийн (tx_id, id COLLATE "C") курсор + ORDER BY-д таарах индекс (DB-ийн анхдагч collation биш — эс бөгөөс planner зөвхөн
-- tx_id угтварыг ашиглаж, нэг tx_id-тай хуучин мөрүүдийг batch бүрт бүхэлд нь уншиж эрэмбэлнэ).
-- CONCURRENTLY БИШ — зориудаар: CREATE INDEX CONCURRENTLY нь баазын бусад бүх нээлттэй транзакц дуустал хүлддэг, харин Prisma-ийн зэрэгцээ
-- `migrate deploy` нь advisory lock дээр хүлээх хугацаандаа яг тийм транзакц болдог → deadlock (CI, 2026-11-20: "deadlock detected"; давтагдсан).
-- Энгийн CREATE INDEX нь үүсгэх хугацаанд бичилтийг хаадаг (жижиг хүснэгтэд миллисекунд); lock_timeout нь урт транзакцын ард дараалалд зогсохоос сэргийлнэ
-- (бүтэлгүйтвэл аюулгүй, дахин ажиллуул). Том хүснэгтэд гараар concurrent үүсгэх зам: docs/DEPLOY-MIGRATIONS.md §7.
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS "audit_log_tx_id_id_idx" ON "kyc"."audit_log" ("tx_id", "id" COLLATE "C");
