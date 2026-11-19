-- M10 · NFR-4: "kyc"."audit_log" append-only. UPDATE / DELETE / TRUNCATE-г trigger хориглоно (хуучин мөрийг хөндөхгүй; хоосон ба мөртэй DB-д адил).
-- Retention purge шаардлага docs/-д байхгүй тул production escape hatch БАЙХГҮЙ (docs/DECISIONS.md 2026-11-19 · 6-р үе шат).
-- Тестийн цэвэрлэгээ: @los/database purgeAuditLogForTests (SET LOCAL session_replication_role = replica — superuser л, NODE_ENV=test л).
CREATE FUNCTION "kyc"."audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only (% rejected)', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "audit_log_append_only" BEFORE UPDATE OR DELETE ON "kyc"."audit_log"
  FOR EACH ROW EXECUTE FUNCTION "kyc"."audit_log_append_only"();
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "kyc"."audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "kyc"."audit_log_append_only"();
