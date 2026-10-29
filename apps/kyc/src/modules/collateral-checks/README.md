# collateral-checks (kyc)

Барьцаа хөрөнгийн ачаалал шалгах: ЗМС (зээлийн мэдээллийн сан) + ЭБ (барьцаа хөрөнгийн бүртгэл) — **FR-6.6** (Модуль 6, `docs/05-collateral-documents.md` §5).

| Endpoint | Эрх | Тайлбар |
| --- | --- | --- |
| `POST /api/collateral-checks/encumbrance` `{assetType, identifier}` | `customer:read` | → `EncumbranceCheckResult {status, sources, checkedAt}`. 422 `ENCUMBRANCE_CHECK_NOT_APPLICABLE` (VEHICLE, APARTMENT, HOUSE, LAND, EQUIPMENT-ээс бусад), 503 `ENCUMBRANCE_UNAVAILABLE`, 501 `INTEGRATION_NOT_IMPLEMENTED` |

* `encumbrance.rules.ts` — цэвэр дүрэм: `DISPUTED > ENCUMBERED > CLEAR`; ЗМС, ЭБ хоёр бүрийн хариу байх ёстой (үгүй бол `EncumbranceIncompleteError`).
* `CollateralChecksService` — registry-ийн хариуг дахин баталгаажуулж (zod), **fail closed**: эх сурвалж унасан/дутуу/буруу хэлбэртэй/тодорхойгүй алдаа бүр 503 (хэзээ ч `CLEAR` биш). `checkedAt` нь `Clock`-оос. Дугаарыг лог-д бичихгүй.
* Registry: `integrations/encumbrance/` — `EncumbranceRegistry` port, `MockEncumbranceRegistry` (DEMO: сүүлийн цифр 7 → ENCUMBERED, 9 → DISPUTED, `ERR` төгсгөл → унасан), `RealEncumbranceRegistry` (501). `INTEGRATION_MODE=mock|real`.

Fixture-ийн хүснэгт, жишээ: `apps/kyc/README.md`.
