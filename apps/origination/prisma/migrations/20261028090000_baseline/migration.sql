-- Baseline: `origination` schema + transactional outbox (apps/origination/prisma/schema.prisma-ийн Outbox). `prisma migrate diff --from-empty`-ээр үүсгэсэн.
-- Docker initdb (packages/database/init/00-schemas.sql) өгөгдлийн сангийн эхний төлөвийг үүсгэдэг; `prisma migrate dev` түүнийг drift гэж үзээд schema-г дахин үүсгэхийг асууна — энэ хэвийн.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "origination";

-- CreateTable
CREATE TABLE "origination"."outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

