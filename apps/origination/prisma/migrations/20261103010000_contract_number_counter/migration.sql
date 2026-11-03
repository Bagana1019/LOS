-- Модуль 10 (BR-11): гэрээний дугаарын дарааллын тоолуур (загвар × хүрээ). Шинэ хүснэгт л.
CREATE TABLE "origination"."contract_number_counter" (
  "template_id" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "next_seq" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "contract_number_counter_pkey" PRIMARY KEY ("template_id", "scope_key")
);
