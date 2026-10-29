-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "iam";

-- CreateTable
CREATE TABLE "iam"."org" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."branch" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."role" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "iam"."user" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "roles" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iam"."audit_log" (
    "id" TEXT NOT NULL,
    "org_id" TEXT,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "before_json" JSONB,
    "after_json" JSONB,
    "application_id" TEXT,
    "correlation_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_code_key" ON "iam"."org"("code");

-- CreateIndex
CREATE UNIQUE INDEX "branch_org_id_code_key" ON "iam"."branch"("org_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "iam"."user"("username");

-- CreateIndex
CREATE INDEX "user_org_id_is_active_idx" ON "iam"."user"("org_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "session_refresh_token_hash_key" ON "iam"."session"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_revoked_at_idx" ON "iam"."session"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "session_family_id_idx" ON "iam"."session"("family_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "iam"."audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "iam"."audit_log"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_action_at_idx" ON "iam"."audit_log"("action", "at");

-- AddForeignKey
ALTER TABLE "iam"."branch" ADD CONSTRAINT "branch_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "iam"."org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."user" ADD CONSTRAINT "user_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "iam"."org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."user" ADD CONSTRAINT "user_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "iam"."branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iam"."session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

