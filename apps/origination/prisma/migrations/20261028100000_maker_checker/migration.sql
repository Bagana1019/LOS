-- Maker-Checker (docs/05-maker-checker.md). Эхний хэсэг нь `prisma migrate diff`-ээр үүссэн; доорх "Invariants" хэсэг нь
-- Prisma-д илэрхийлэгдэхгүй, гэхдээ 4 нүдний зарчмыг аппликейшний алдаанаас үл хамааран DB түвшинд хамгаалдаг.
-- `origination` schema болон outbox нь өмнөх `20261028090000_baseline` migration-аас ирнэ. Дүрүүдийн (TEXT[]) багана NOT NULL —
-- NULL нь доорх CHECK-үүдийг тойрч гардаг тул (CHECK нь NULL-д "тэнцэхгүй" биш "үл мэдэгдэх" гэж үнэлэгддэг).

-- CreateEnum
CREATE TYPE "origination"."change_request_status" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "origination"."change_request_mode" AS ENUM ('FOUR_EYES', 'DIRECT');

-- CreateEnum
CREATE TYPE "origination"."change_request_event" AS ENUM ('SUBMITTED', 'APPLIED', 'DIRECT_APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "origination"."change_request" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "application_id" TEXT,
    "mode" "origination"."change_request_mode" NOT NULL DEFAULT 'FOUR_EYES',
    "status" "origination"."change_request_status" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "before" JSONB,
    "base_version" TEXT,
    "reason" TEXT NOT NULL,
    "maker_id" TEXT NOT NULL,
    "maker_roles" TEXT[] NOT NULL,
    "required_checker_roles" TEXT[] NOT NULL,
    "checker_id" TEXT,
    "checker_roles" TEXT[] NOT NULL,
    "checker_comment" TEXT,
    "failure_reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "change_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."change_request_history" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "event" "origination"."change_request_event" NOT NULL,
    "from_status" "origination"."change_request_status",
    "to_status" "origination"."change_request_status" NOT NULL,
    "actor_id" TEXT,
    "actor_roles" TEXT[] NOT NULL,
    "comment" TEXT,
    "data" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_request_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "origination"."maker_checker_policy" (
    "id" UUID NOT NULL,
    "org_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "checker_roles" TEXT[] NOT NULL,
    "expires_in_hours" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "maker_checker_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "change_request_org_id_status_expires_at_idx" ON "origination"."change_request"("org_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "change_request_org_id_target_type_target_id_idx" ON "origination"."change_request"("org_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "change_request_maker_id_status_idx" ON "origination"."change_request"("maker_id", "status");

-- CreateIndex
CREATE INDEX "change_request_checker_id_idx" ON "origination"."change_request"("checker_id");

-- CreateIndex
CREATE INDEX "change_request_application_id_idx" ON "origination"."change_request"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_request_history_change_request_id_seq_key" ON "origination"."change_request_history"("change_request_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "maker_checker_policy_org_id_target_type_action_key" ON "origination"."maker_checker_policy"("org_id", "target_type", "action");

-- AddForeignKey
ALTER TABLE "origination"."change_request_history" ADD CONSTRAINT "change_request_history_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "origination"."change_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ Invariants ═══════════════════════════════════════════════════════════════

-- MC-BR-1: хүсэлт гаргагч өөрөө шийднэ гэж DB-д ч байж болохгүй (дүр, ADMIN ч тойрохгүй)
ALTER TABLE "origination"."change_request"
  ADD CONSTRAINT "change_request_maker_ne_checker"   CHECK (checker_id IS NULL OR checker_id <> maker_id),
  ADD CONSTRAINT "change_request_direct_no_checker"  CHECK (mode <> 'DIRECT' OR (checker_id IS NULL AND status = 'APPLIED')),
  -- FOUR_EYES горимд APPLIED/REJECTED/FAILED бүр checker-тэй
  ADD CONSTRAINT "change_request_decided_has_checker" CHECK (mode <> 'FOUR_EYES' OR status NOT IN ('APPLIED', 'REJECTED', 'FAILED') OR checker_id IS NOT NULL),
  -- MC-BR-4: татгалзахад тайлбар, maker-т шалтгаан заавал
  ADD CONSTRAINT "change_request_reject_comment"     CHECK (status <> 'REJECTED' OR length(btrim(coalesce(checker_comment, ''))) >= 3),
  ADD CONSTRAINT "change_request_reason_present"     CHECK (length(btrim(reason)) >= 3),
  ADD CONSTRAINT "change_request_required_roles"     CHECK (mode = 'DIRECT' OR cardinality(required_checker_roles) > 0),
  ADD CONSTRAINT "change_request_pending_undecided"  CHECK (status <> 'PENDING' OR (checker_id IS NULL AND decided_at IS NULL));

-- MC-BR-5: нэг зорилтод нэг л хүлээгдэж буй хүсэлт
CREATE UNIQUE INDEX "change_request_one_pending_per_target"
  ON "origination"."change_request" ("org_id", "target_type", "target_id")
  WHERE status = 'PENDING';

-- MC-BR-10 + MC-BR-3: терминал төлөвөөс буцахгүй; maker-ийн илгээсэн агуулга өөрчлөгдөхгүй; устгахгүй
CREATE FUNCTION "origination"."change_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'change_request % cannot be deleted', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'change_request % is % and can no longer be modified', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.action IS DISTINCT FROM OLD.action OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.before IS DISTINCT FROM OLD.before
     OR NEW.base_version IS DISTINCT FROM OLD.base_version OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.maker_id IS DISTINCT FROM OLD.maker_id OR NEW.maker_roles IS DISTINCT FROM OLD.maker_roles
     OR NEW.required_checker_roles IS DISTINCT FROM OLD.required_checker_roles
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'submitted content of change_request % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "change_request_guard" BEFORE UPDATE OR DELETE ON "origination"."change_request"
  FOR EACH ROW EXECUTE FUNCTION "origination"."change_request_guard"();

-- MC-BR-9: аудит түүх append-only
CREATE FUNCTION "origination"."change_request_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER "change_request_history_append_only" BEFORE UPDATE OR DELETE ON "origination"."change_request_history"
  FOR EACH ROW EXECUTE FUNCTION "origination"."change_request_append_only"();
CREATE TRIGGER "change_request_history_no_truncate" BEFORE TRUNCATE ON "origination"."change_request_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "origination"."change_request_append_only"();
CREATE TRIGGER "change_request_no_truncate" BEFORE TRUNCATE ON "origination"."change_request"
  FOR EACH STATEMENT EXECUTE FUNCTION "origination"."change_request_append_only"();

-- Policy: мэдэгдэж буй дүр, хүчинтэй TTL
ALTER TABLE "origination"."maker_checker_policy"
  ADD CONSTRAINT "maker_checker_policy_roles"  CHECK (cardinality(checker_roles) > 0 AND checker_roles <@ ARRAY['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN']),
  ADD CONSTRAINT "maker_checker_policy_ttl"    CHECK (expires_in_hours BETWEEN 1 AND 720);
