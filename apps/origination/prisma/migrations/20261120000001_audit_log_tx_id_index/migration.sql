-- Audit seal: sealer/verify-ийн (tx_id, id COLLATE "C") курсор + ORDER BY-д таарах индекс (DB-ийн анхдагч collation биш — эс бөгөөс planner зөвхөн
-- tx_id угтварыг ашиглаж, нэг tx_id-тай хуучин мөрүүдийг batch бүрт бүхэлд нь уншиж эрэмбэлнэ). ЗӨВХӨН нэг statement: Prisma олон statement-тэй
-- миграцыг нэг implicit транзакцаар ажиллуулдаг, CONCURRENTLY транзакц дотор алдаа өгнө. Бүтэлгүйтвэл INVALID индекс үлдэнэ:
-- DROP INDEX CONCURRENTLY "origination"."audit_log_tx_id_id_idx"; хийгээд `prisma migrate resolve --rolled-back` → дахин deploy (docs/DECISIONS.md).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_tx_id_id_idx" ON "origination"."audit_log" ("tx_id", "id" COLLATE "C");
