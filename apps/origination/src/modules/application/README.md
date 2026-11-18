# application (Модуль 2)

Хүсэлт (`loan_application`) үүсгэх, жагсаалт (9 таб), дэлгэрэнгүй (12 алхам), төлвийн машин. FR-1, docs/01 §4.

- `POST /api/applications` — шинэ хүсэлт (DRAFT, ЗЭЗ+салбар, 12 алхам: 1-р үе шат PENDING, 2-р үе шат LOCKED)
  - Заавал биш `Idempotency-Key` толгой (8–128 тэмдэгт `[A-Za-z0-9_-]`), хүрээ = байгууллага × үүсгэгч. Шинэ → `201`; ижил түлхүүр + ижил бие → анхны хүсэлт `200` (шинэ мөр, audit, дугаар үүсэхгүй);
    өөр бие → `422 IDEMPOTENCY_KEY_REUSED`; буруу түлхүүр → `400 IDEMPOTENCY_KEY_INVALID`; толгойгүй бол өмнөх шигээ. Зэрэгцээ хүсэлтийг unique индекс шийднэ (P2002 → дахин унших).
- `GET /api/applications` — жагсаалт (`status`, `q`, `sort`, `dir`, `page`, `pageSize` 10/20/50/100), `GET /api/applications/export` — Excel
- `GET /api/applications/:id`, `/history`; `POST /api/applications/:id/transition` (HTTP-ээр зөвхөн `SUBMITTED`)
- `ApplicationStateMachine.apply(tx, ctx, id, to, { via })` — бусад модуль (M10 батлах урсгал, M11 олголт) төлөв солихдоо зөвхөн үүнийг дуудна.
- Хүрээ (NFR-3): ЗЭЗ өөрийнхөө, салбарын захирал салбараа, батлагч/админ бүгдийг.
