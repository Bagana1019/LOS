-- id_card ба salary_statement нь заавал баримт биш болсон: үндсэн checklist-ээс хасна.
DELETE FROM "dms"."document_checklist" WHERE "key" IN ('id_card', 'salary_statement') AND "related_entity" = 'BORROWER';
