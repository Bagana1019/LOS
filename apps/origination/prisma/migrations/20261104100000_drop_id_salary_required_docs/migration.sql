-- Иргэний үнэмлэхний хуулбар (id_card) ба Цалингийн тодорхойлолт (salary_statement) нь заавал баримт биш болсон: бүтээгдэхүүний checklist-ээс хасна.
UPDATE "origination"."product"
SET "document_checklist_json" = COALESCE((
  SELECT jsonb_agg(e) FROM jsonb_array_elements("document_checklist_json") e
  WHERE e->>'key' NOT IN ('id_card', 'salary_statement')
), '[]'::jsonb)
WHERE jsonb_typeof("document_checklist_json") = 'array';
