-- H8 / PRT-FR-5.3: портал төлбөрийн Idempotency-Key-г тусгай баганад (note биш) — (org_id, key) UNIQUE нь origination-ий олон pod
-- зэрэг ижил түлхүүрээр ирэхэд нэг л invoice (нэг QPay дуудлага) үүсгэнэ. NULL олон байж болно (ажилтны invoice).
ALTER TABLE "origination"."payment_invoice" ADD COLUMN "portal_idempotency_key" TEXT;
ALTER TABLE "origination"."payment_invoice" ADD COLUMN "portal_request_hash" TEXT;

-- Хуучин `note = portal:v1:<amountType>:<keyHash>:<bodyHash>` тэмдгийг шилжүүлнэ; давхардсан бол хамгийн эхнийх нь түлхүүрийг авна.
UPDATE "origination"."payment_invoice" AS p
SET "portal_idempotency_key" = t.key_hash, "portal_request_hash" = t.amount_type || ':' || t.body_hash
FROM (
  SELECT DISTINCT ON ("org_id", (regexp_match("note", '^portal:v1:(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):([0-9a-f]{32}):([0-9a-f]{32})$'))[2])
    "id",
    (regexp_match("note", '^portal:v1:(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):([0-9a-f]{32}):([0-9a-f]{32})$'))[1] AS amount_type,
    (regexp_match("note", '^portal:v1:(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):([0-9a-f]{32}):([0-9a-f]{32})$'))[2] AS key_hash,
    (regexp_match("note", '^portal:v1:(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):([0-9a-f]{32}):([0-9a-f]{32})$'))[3] AS body_hash
  FROM "origination"."payment_invoice"
  WHERE "note" ~ '^portal:v1:(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):[0-9a-f]{32}:[0-9a-f]{32}$'
  ORDER BY "org_id", (regexp_match("note", '^portal:v1:(INSTALLMENT|OVERDUE|PAYOFF|CUSTOM):([0-9a-f]{32}):([0-9a-f]{32})$'))[2], "created_at", "id"
) AS t
WHERE p."id" = t."id";

CREATE UNIQUE INDEX "payment_invoice_org_id_portal_idempotency_key_key" ON "origination"."payment_invoice"("org_id", "portal_idempotency_key");
