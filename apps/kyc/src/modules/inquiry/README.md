# inquiry — лавлагаа (FR-3, Модуль 3)

ЗМС (CIB), FICO, ӨОХ (DTI), малын тоо, ХУР-ын 6 лавлагаа, хар жагсаалтын мөр, ЗМС-д бүртгэлгүй зээл. Шаардлага: FR-3.1–3.5 (docs/01), docs/03 `inquiry`, `unregistered_loan`.
Дуудагч: origination (sync REST; хүсэлтийн эрхийг тэнд шалгасан). Регистр зөвхөн POST body-д — хадгалахгүй, лог-д бичихгүй.

| Method path | Эрх | Үүрэг |
| --- | --- | --- |
| `POST /api/inquiry/fetch` | customer:write | 11 (эсвэл `sources`) лавлагаа татаж хадгална; `{items, failures}` |
| `GET /api/inquiry?applicationId=&customerId?` | customer:read | (харилцагч × эх сурвалж)-ийн хамгийн сүүлийн мөр + бүртгэлгүй зээл |
| `GET /api/inquiry/credit-history?applicationId=&customerId=` | customer:read | Тооцоололд: `ficoScore`, `activeLoanCount`, `overdueHistoryMonths`, `existingDebtServiceMonthly` (ЗМС сарын төлбөр + бүртгэлгүй зээл), мэдэгдэхгүй = `null` |
| `POST /api/inquiry/unregistered-loans`, `DELETE …/:id?applicationId=` | customer:write | FR-3.2 |

- `integrations/inquiry/`: `InquiryProvider` interface + `MockInquiryProvider` (DEMO, deterministic) + `RealInquiryProvider` (fail closed); `INTEGRATION_MODE`.
- `raw_json` = шифрлэгдсэн (`{v:1, enc}`), `summary_json` = snake_case хураангуй (docs/03). Дахин татах = шинэ мөр.
- `BLACKLIST` мөр: origination тулгаж дамжуулсан үр дүн (hit → RED, хориг БИШ).
- Тест: `src/**/*.test.ts` (rules, mock), `test/inquiry.e2e.test.ts` (DB).
