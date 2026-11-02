-- Модуль 2: хүсэлтийн дугаарын тоолуур (org × он). Шинэ хүснэгт л — baseline-д хүрэхгүй.
CREATE TABLE "origination"."application_sequence" (
  "org_id" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "next_seq" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "application_sequence_pkey" PRIMARY KEY ("org_id", "year")
);
