-- FR-13 · Хэрэглэгчийн удирдлага: нууц үг заавал солих туг, идэвхгүй болгосон хугацаа (incremental)
ALTER TABLE "iam"."user" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "iam"."user" ADD COLUMN "deactivated_at" TIMESTAMP(3);
