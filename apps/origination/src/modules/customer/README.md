# customer

Харилцагч — **FR-2.1…2.6**, **FR-13.1** (хар жагсаалтын хайлт). Модуль 1. Хүснэгт: `customer`, `customer_contact` (docs/03; `customer_bank_account` Модуль 11/12-д).

| Endpoint (`/api/origination/…` gateway-ээр) | Эрх | Тайлбар |
| --- | --- | --- |
| `GET /customers?q&registerNo&customerType&page&pageSize` | `customer:read` | Хайлт. Регистр зөвхөн далдлагдсан (`УБ****0112`) |
| `GET /customers/lookup?registerNo=` | `customer:read` | Байгаа эсэх + хар жагсаалт (FR-2.2: дахин бүртгэхгүй) |
| `POST /customers/xyp-otp` `{registerNo}` | `customer:write` | Иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ → `XypOtpResult {sent, requestedAt, existing, warnings}`. Утасны дугаар хүлээн авахгүй (400). Бүртгэлтэй харилцагчид SMS явахгүй (`sent:false`, `existing`). 429 `XYP_OTP_RATE_LIMITED` (регистр тус бүрт ≥ 1 мин зай, 15 мин-д 3, 24 цагт 6), 404 `XYP_NOT_FOUND`, 503 `XYP_UNAVAILABLE` |
| `POST /customers/xyp-fetch` `{registerNo, otp}` | `customer:write` | 2-р алхам: иргэний кодоор kyc-ээс ХУР татаж маягтын өгөгдөл + `missing` + `snapshotToken` (хадгалахгүй). 422 `XYP_OTP_INVALID`, 409 `XYP_OTP_NOT_REQUESTED` (код хүсээгүй / 15 мин өнгөрсөн), 429 `XYP_OTP_ATTEMPTS_EXHAUSTED` (илгээсэн код тус бүрт 3 оролдлого) / `XYP_OTP_RATE_LIMITED` |
| `POST /customers` | `customer:write` | Үүсгэх. `source: "XYP"` үед `xypSnapshotToken` ЗААВАЛ (`xyp-fetch`-ийн тэмдэг; ХУР-ыг дахин дуудахгүй). 409 `CUSTOMER_EXISTS`, 400 `XYP_SNAPSHOT_INVALID` (хугацаа дууссан / засварласан / өөр ажилтан, регистр), 400 `VALIDATION_FAILED` (талбар бүрийн `path`) |
| `GET /customers/:id` | `customer:read` | Карт (FR-2.6): бүх талбар, холбоо барих хүмүүс, `warnings`, өмнөх зээл (хүсэлтийн харагдах хүрээгээр, NFR-3) |
| `PUT /customers/:id` | `customer:write` | Өгсөн талбарыг л солино; регистр/төрөл өөрчлөгдөхгүй; `contacts` өгвөл бүхэлд нь солино |

Дүрэм
* Заавал талбар (FR-2.3) — `@los/contracts` `CustomerInput` (UI мөн ижил схемээр шалгана). Байгууллагад хүйс, төрсөн огноо, ам бүл, гэрлэлт, боловсрол, зураг, хөдөлмөр шаардахгүй.
* Регистр: DB-д `register_no_encrypted` (AES-256-GCM, AAD-гүй) + `register_no_hash` (blind index, `(org_id, hash)` unique). Лог/аудитад орохгүй.
* Хар жагсаалт (BR-9): `BlacklistLookupService` → `warnings[]`; хадгалахыг хориглохгүй.
* ХУР: `source=XYP` үед `lastName, firstName, gender, birthDate, officialAddress` нь ХУР-ынх (ЗЭЗ-ийн утгыг дарна); `maritalStatus, familySize, activitySector` нь зөвхөн хоосон бол нөхөгдөнө. `xyp_fetched_at` серверээс.
* Иргэний зөвшөөрөл (нэг удаагийн код): `xyp-otp` → иргэний ХУР-д бүртгэлтэй утсанд SMS (ажилтан утас СОНГОХГҮЙ) → `xyp-fetch` кодоор. Код нэг удаагийнх тул `create` ХУР-ыг дахин дуудахгүй: `xyp-fetch`-ийн `snapshotToken` нь ХУР-ын иргэнийг битүүмжилсэн (AES-GCM, AAD = байгууллага + ажилтан + регистр, 30 мин) тэмдэг — `create` үүнийг нээж ХУР-ын талбарыг авна (`xyp-snapshot.ts`).
* Хязгаар ба аудит (`xyp-consent.ts`): код хүсэх: регистр тус бүрт ≥ 1 мин зай, 15 мин-д 3, 24 цагт 6; кодоор татах: 15 мин дотор илгээсэн код байх ёстой, код тус бүрт 3 оролдлого (өдөрт ≤ 6 код × 3 таамаг); ажилтан тус бүрт цагт 20 / 30 (advisory lock дотор, ХУР-аас ӨМНӨ бүртгэнэ). Тоолуур = `audit_log` (entity `XYP_CONSENT`; `entityId` = регистрийн blind index). Аудитад код, түүхий регистр орохгүй. kyc-ийн `/xyp/citizen[/otp]` нь gateway-д ажилтанд хаалттай — хязгаарыг тойрохгүй.
* Аудит: `CUSTOMER_CREATED` / `CUSTOMER_UPDATED` (өөрчлөгдсөн талбар л) — `audit_log`, бизнес бичлэгтэй нэг транзакцид.
* Event гаргахгүй (catalog-д `Customer*` байхгүй); DWH `dim_customer`-ийг CDC-ээр (CLAUDE.md §2).

Хүсэлттэй холбох (`loan_application_borrower`, дүр PRIMARY/CO_BORROWER/…) — Модуль 2 (`client` алхам).
