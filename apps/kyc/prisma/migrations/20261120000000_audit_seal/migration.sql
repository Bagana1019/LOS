-- Audit seal (tamper evidence) · NFR-4, M10 follow-up · docs/DECISIONS.md 2026-11-19 "audit seal".
-- ALTER TABLE нь урт транзакцын ард дараалалд зогсож бүх аудит бичигчийг хаахгүйн тулд 5с-ээс илүү түгжээ хүлээхгүй (бүтэлгүйтвэл аюулгүй — дахин ажиллуул).
SET LOCAL lock_timeout = '5s';
-- 1) tx_id: мөрийг бичсэн транзакцын xid8. Trigger ХҮЧЭЭР тавина (клиентийн утгыг дарна) — sealer-ийн horizon
--    (pg_snapshot_xmin) нь "энэнээс доош бүх бичигч дууссан" гэсэн баталгаа өгнө; бичигчид нэмэлт түгжээ авахгүй.
--    Тогтмол DEFAULT '0' → metadata-only (хүснэгтийг дахин бичихгүй; volatile DEFAULT бол бүтэн rewrite + ACCESS EXCLUSIVE). Хуучин мөрүүд
--    tx_id = 0 (ямар ч horizon-оос доош) → эхний seal(-үүд)-д (0, id COLLATE "C") дарааллаар детерминист багтана. Шинэ мөрийн DEFAULT-ыг дараа нь солино.
ALTER TABLE "kyc"."audit_log" ADD COLUMN "tx_id" xid8 NOT NULL DEFAULT '0'::xid8;
ALTER TABLE "kyc"."audit_log" ALTER COLUMN "tx_id" SET DEFAULT pg_current_xact_id();
CREATE FUNCTION "kyc"."audit_log_stamp_tx_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."tx_id" := pg_current_xact_id();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "audit_log_stamp_tx_id" BEFORE INSERT ON "kyc"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "kyc"."audit_log_stamp_tx_id"();
-- (tx_id, id COLLATE "C") индекс: тусдаа миграц 20261120000001_audit_log_tx_id_index (CREATE INDEX CONCURRENTLY нь транзакц дотор ажиллахгүй).

-- 2) audit_seal: HMAC гинж (seq 1,2,3…). Зөвхөн @los/database sealAuditLog бичнэ; audit_log-той адил append-only.
CREATE TABLE "kyc"."audit_seal" (
    "seq" BIGINT NOT NULL,
    "key_id" TEXT NOT NULL,
    "last_tx_id" xid8 NOT NULL,
    "last_id" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "prev_mac" TEXT,
    "mac" TEXT NOT NULL,
    "sealed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_seal_pkey" PRIMARY KEY ("seq"),
    CONSTRAINT "audit_seal_row_count_check" CHECK ("row_count" > 0),
    CONSTRAINT "audit_seal_prev_mac_check" CHECK (("seq" = 1) = ("prev_mac" IS NULL))
);
CREATE TRIGGER "audit_seal_append_only" BEFORE UPDATE OR DELETE ON "kyc"."audit_seal"
  FOR EACH ROW EXECUTE FUNCTION "kyc"."audit_log_append_only"();
CREATE TRIGGER "audit_seal_no_truncate" BEFORE TRUNCATE ON "kyc"."audit_seal"
  FOR EACH STATEMENT EXECUTE FUNCTION "kyc"."audit_log_append_only"();
