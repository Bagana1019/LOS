# application (Модуль 2)

Хүсэлт (`loan_application`) үүсгэх, жагсаалт (9 таб), дэлгэрэнгүй (12 алхам), төлвийн машин. FR-1, docs/01 §4.

- `POST /api/applications` — шинэ хүсэлт (DRAFT, ЗЭЗ+салбар, 12 алхам: 1-р үе шат PENDING, 2-р үе шат LOCKED)
- `GET /api/applications` — жагсаалт (`status`, `q`, `sort`, `dir`, `page`, `pageSize` 10/20/50/100), `GET /api/applications/export` — Excel
- `GET /api/applications/:id`, `/history`; `POST /api/applications/:id/transition` (HTTP-ээр зөвхөн `SUBMITTED`)
- `ApplicationStateMachine.apply(tx, ctx, id, to, { via })` — бусад модуль (M10 батлах урсгал, M11 олголт) төлөв солихдоо зөвхөн үүнийг дуудна.
- Хүрээ (NFR-3): ЗЭЗ өөрийнхөө, салбарын захирал салбараа, батлагч/админ бүгдийг.
