# approval

Модуль 10 · Шийдвэр, батлах урсгал (FR-10, BR-7, BR-8, BR-13, G1–G3).

- `POST /api/applications/:id/transition {to:'SUBMITTED'}` — илгээмэгц эхний түвшин нээгдэж `IN_APPROVAL` болно (`APPROVAL_FLOW` порт).
- `GET /api/applications/:id/decision` — хураангуй карт, 7/7 бүрдэлт, timeline (түвшин, санал, SLA), хувилбарын түүх, decision_record.
- `POST /api/applications/:id/approval/vote {decision, comment?}` — Батлах / Буцаах (RETURN-д тайлбар заавал); олонхиор түвшин ахина.
- `GET /api/approvals/mine` — "Миний батлах" таб; `POST /api/approvals/sla-sweep` (ADMIN).
- APPROVED: гэрээний дугаар (`contract_number_template`, BR-11) + `decision_record` + 2-р үе шат нээгдэнэ; `ApplicationApproved` event.
- Дүрмүүд (`approval.rules.ts`) цэвэр функц. Таамаг: docs/DECISIONS.md 2026-11-03 (Модуль 10).
