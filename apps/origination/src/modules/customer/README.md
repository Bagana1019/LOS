# customer

Харилцагч — **FR-2.1…2.6**, **FR-13.1** (хар жагсаалтын хайлт). Модуль 1. Хүснэгт: `customer`, `customer_contact` (docs/03; `customer_bank_account` Модуль 11/12-д).

| Endpoint (`/api/origination/…` gateway-ээр) | Эрх | Тайлбар |
| --- | --- | --- |
| `GET /customers?q&registerNo&customerType&page&pageSize` | `customer:read` | Хайлт. Регистр зөвхөн далдлагдсан (`УБ****0112`) |
| `GET /customers/lookup?registerNo=` | `customer:read` | Байгаа эсэх + хар жагсаалт (FR-2.2: дахин бүртгэхгүй) |
| `POST /customers/xyp-fetch` `{registerNo}` | `customer:write` | kyc-ээс ХУР татаж маягтын өгөгдөл + `missing` (хадгалахгүй) |
| `POST /customers` | `customer:write` | Үүсгэх. `source: "XYP"` үед сервер ХУР-аас нөхнө. 409 `CUSTOMER_EXISTS`, 400 `VALIDATION_FAILED` (талбар бүрийн `path`) |
| `GET /customers/:id` | `customer:read` | Карт (FR-2.6): бүх талбар, холбоо барих хүмүүс, `warnings`, өмнөх зээл (хүсэлтийн харагдах хүрээгээр, NFR-3) |
| `PUT /customers/:id` | `customer:write` | Өгсөн талбарыг л солино; регистр/төрөл өөрчлөгдөхгүй; `contacts` өгвөл бүхэлд нь солино |

Дүрэм
* Заавал талбар (FR-2.3) — `@los/contracts` `CustomerInput` (UI мөн ижил схемээр шалгана). Байгууллагад хүйс, төрсөн огноо, ам бүл, гэрлэлт, боловсрол, зураг, хөдөлмөр шаардахгүй.
* Регистр: DB-д `register_no_encrypted` (AES-256-GCM, AAD-гүй) + `register_no_hash` (blind index, `(org_id, hash)` unique). Лог/аудитад орохгүй.
* Хар жагсаалт (BR-9): `BlacklistLookupService` → `warnings[]`; хадгалахыг хориглохгүй.
* ХУР: `source=XYP` үед `lastName, firstName, gender, birthDate, officialAddress` нь ХУР-ынх (ЗЭЗ-ийн утгыг дарна); `maritalStatus, familySize, activitySector` нь зөвхөн хоосон бол нөхөгдөнө. `xyp_fetched_at` серверээс.
* Аудит: `CUSTOMER_CREATED` / `CUSTOMER_UPDATED` (өөрчлөгдсөн талбар л) — `audit_log`, бизнес бичлэгтэй нэг транзакцид.
* Event гаргахгүй (catalog-д `Customer*` байхгүй); DWH `dim_customer`-ийг CDC-ээр (CLAUDE.md §2).

Хүсэлттэй холбох (`loan_application_borrower`, дүр PRIMARY/CO_BORROWER/…) — Модуль 2 (`client` алхам).
