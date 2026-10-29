# report — Тайлан ба Dashboard (9 зээлийн тайлан · Excel · KPI)

LOS-ийн хүсэлт, ЭТХ, төлбөр, барьцаа, олголтын өгөгдлөөс 9 тайлан гаргаж, Excel болгон татаж, удирдлагын KPI dashboard үзүүлнэ.
Модуль нь **зөвхөн унших** (өгөгдөл өөрчлөхгүй); бичдэг ганц зүйл нь экспортын аудит (`report_run`).
Шаардлага: FR-13.3 (9 тайлан, Excel), FR-1.3 (шүүх, эрэмбэлэх, 10/20/50/100), NFR-1 (≤ 2с), NFR-3 (хүрээ), NFR-4/5 (экспорт = хувийн мэдээлэл гаргах үйлдэл),
NFR-9 (Excel), docs/01 §2.1, docs/04 Модуль 13.

## Endpoint
Бүгд `ADMIN`, `OFFICER`, `BRANCH_MANAGER`, `APPROVER` (CUSTOMER → 403, нэвтрээгүй → 401). Global prefix `api`.

| Method path | Хариу |
| --- | --- |
| `GET reports` | `ReportDefinitionView[]` — 9 тайлангийн нэр, багана (`sortable`, `options`), шүүлт, `dataSource`, `defaultSort`. `productId` шүүлтийн сонголтыг бүтээгдэхүүний каталогоос нөхнө |
| `GET reports/dashboard/summary` | `DashboardSummary` (`DashboardQuery`: `currency`=MNT, `branchId`, `asOf`) |
| `GET reports/:key` | `ReportResult` (`ReportQuery`); үл мэдэгдэх түлхүүр → 404 `REPORT_NOT_FOUND` |
| `GET reports/:key/export` | `.xlsx` (`ReportExportQuery` = `ReportQuery` − хуудаслалт); `Content-Disposition: attachment; filename="LOS_<key>_<asOf YYYYMMDD>.xlsx"; filename*=UTF-8''…` |

`reports/dashboard/summary` нь `reports/:key`-ээс **өмнө** зарлагдсан (замын мөргөлдөөнгүй); `reports/dashboard` нь тайлан биш тул 404.
Алдааны код: 400 `VALIDATION_FAILED` · `INVALID_FILTER` · `INVALID_SORT` · `INVALID_DATE_RANGE`; 403 `FORBIDDEN` · `BRANCH_REQUIRED`;
422 `EXPORT_TOO_LARGE`; 429 `EXPORT_BUSY` (олон экспорт зэрэг) · `REPORT_BUSY` (dashboard дараалал дүүрсэн); 504 `REPORT_TIMEOUT` (DB `statement_timeout`);
503 `INTEGRATION_NOT_CONFIGURED` (Core тохируулаагүй); 501 `INTEGRATION_NOT_IMPLEMENTED` (deposit-balances: real горим, мөн **production + mock** үед экспорт).

## 9 тайлан
| key | Агуулга | Анхдагч эрэмбэ |
| --- | --- | --- |
| `upcoming-repayments` | `[dateFrom ?? asOf, dateTo ?? asOf+30]` хугацаанд төлөх, үлдэгдэлтэй ЭТХ-ийн мөр (утас хамт) | `dueDate` ↑ |
| `overdue-loans` | зээл тутамд хамгийн эртний хэтэрсэн мөрөөс DPD, хэтэрсэн мөр/дүн, ангилал (`agingBucket`) | `dpd` ↓ |
| `outstanding-balance` | ACTIVE/MIGRATED: олгосон, төлсөн үндсэн, үлдэгдэл үндсэн/хүү, дараагийн төлөлт | `outstandingPrincipal` ↓ |
| `closed-loans` | CLOSED зээл, хаагдсан огноо, нийт төлсөн | `closedDate` ↓ |
| `disbursed-loans` | `disburse_date` хугацаанд APPROVED/SENT_TO_CORE олголт, `coreLoanId` | `disburseDate` ↓ |
| `interest-payments` | `paid_at` `[dateFrom, dateTo]`-д орсон төлбөрүүдийг зээл тутамд нэгтгэнэ: төлсөн хүү/үндсэн (allocation Σ), хуваарилагдаагүй, нийт; `provider`-оор шүүнэ | `lastPaidDate` ↓ |
| `collateral-assets` | барьцаа: төрөл, өмчлөгч, үнэлгээ, haircut, LTV, ЭБ, даатгал/дахин үнэлгээ, статус (30 хоногт дуусах = анхааруулга) | `insuranceExpiresAt` ↑ |
| `pipeline-progress` | бүх хүсэлт төлвөөр, одоогийн алхам, төлөвт хэдэн хоног, бүрдэлт X/12 | `daysInStatus` ↓ |
| `deposit-balances` | үндсэн/хамтран зээлдэгчийн Core депозит данс (`CoreDepositPort`; mock = `core-mock`) | `balance` ↓ |

Тайлан нэмэх: `reports/<key>.report.ts` үүсгээд (`sqlReport({...})`) `report-registry.ts`-ийн `REPORT_DEFINITIONS`-д нэг мөр нэмнэ (key нь `ReportKey` enum-д байх ёстой).
Багана бүр `col(key, label, type, { width, sortable, options })`; SQL-ийн гаралтын нэр = `columns[].key`, нэмж `_id` (тогтвортой эрэмбийн түлхүүр) ба `currency`.

## Ерөнхий дүрэм
- **Хүрээ (NFR-3)** — `report-scope.ts`: ADMIN/APPROVER бүгд · BRANCH_MANAGER өөрийн салбар (салбаргүй → 403 `BRANCH_REQUIRED`) · OFFICER `officer_id = userId`.
  Олон дүртэй бол хамгийн өргөн нь. Хүрээнээс гадуур `branchId/officerId` шүүлтийг **үл тооно**; хүрээгүй талбарыг query нарийсгана. Бүх SQL `org_id`-ээр хязгаарлагдана.
- **asOf** — анхдагч `Clock.today()` (Asia/Ulaanbaatar, UTC+8, DST-гүй); query-н `asOf`-оор түүхэн байдлыг гаргаж болно. Төлбөр зөвхөн `paid_at < (asOf+1 өдрийн UB 00:00)`-ийг тооцно.
- **Одоогийн ЭТХ** — зээл бүрт `is_stale=false`-ийн хамгийн сүүлийн `generated_at` (`cur` CTE). ЭТХ-гүй зээлийн үлдэгдэл = зээлийн дүн, хэтрэлтгүй.
- **Төлсөн дүн** = `payment_allocation`-ийн Σ (хүү/үндсэн тус тусад), мөр бүрт `LEAST(paid, төлөх)`. Үлдэгдэл = `GREATEST(төлөх − төлсөн, 0)` (`@los/calc outstandingOf`-той ижил).
- **Валют холихгүй (FR-5.4)** — нийлбэр (`totals`) нь бүх шүүлттэй мөрөөр (хуудсаар биш). Мөрүүд >1 валюттай бол `totals` өгөхгүй, `mixedCurrency: true`.
- **Мөнгө** = 2 орон `number`; **хувь** = харьцаа (0.25 = 25%, 6 орон); **огноо** = `YYYY-MM-DD`; **status** = код (`column.options`-оос шошго).
- **PII** — регистр DB-д шифрлэгдсэн: JS-д тайлж `maskRegisterNo` (`УБ****0012`); хайлт `blindIndex`-ээр **яг** таарна; лог/аудитад бичихгүй. Депозит дансны дугаар нуугдмал.
- **SQL аюулгүй байдал** — бүх утга `Prisma.sql` параметр ($n); `Prisma.raw` зөвхөн манай тогтмол илэрхийлэлд; эрэмбэлэх багана `sortable` whitelist-ээс `ident()`-ээр; `LIKE` escape.

## SQL бүтэц ба гүйцэтгэл (NFR-1)
`report-sql.ts`-ийн хуваалцдаг CTE: `loans` (хүрээ/шүүлттэй хүсэлт + үндсэн зээлдэгч + бүтээгдэхүүн) → `cur` (одоогийн ЭТХ) → `inst` (мөр бүр + төлсөн Σ).
`executeSqlReport` нь нэг хуудас + нийт тоо + нийлбэрийг **нэг SQL**-ээр авна (`WITH q AS MATERIALIZED (base)` → `agg` ба `pg`), `SET LOCAL jit = off` ба `SET LOCAL statement_timeout`-тэй гүйлгээнд
(жагсаалт/dashboard 30с, экспорт 120с; тасрахад 504 `REPORT_TIMEOUT` — хэт удаан query нийтлэг Prisma pool-ыг барихгүй). `ReportInput.maxRows` (экспорт) өгөгдвөл нийт тоо түүнээс их үед `pg` хоосон болж мөр DB-ээс гарахгүй, JS-д задлагдахгүй.
JIT-ийг унтраасан шалтгаан: том нэгтгэлийн төлөвлөгөөнд JIT-ийн эмхэтгэл 1–3 секунд нэмж байсан (10k зээл дээр хэмжсэн).
`inst` дотор allocation-ыг мөр бүрээр GROUP BY хийхгүй: хүрээн доторх төлбөрөөр (`payment.application_id ∈ loans`) урьдчилан нэгтгээд hash join хийнэ.
Хэмжилт (`report.perf.integration.test.ts`, 10,000 зээл × 12 мөр, бүгд хугацаа хэтэрсэн = хамгийн хүнд): overdue ≈ 0.7с, outstanding ≈ 0.7с, upcoming ≈ 0.3с (анхны хүсэлт ≈ 1.1с), dashboard ≈ 0.65с, бусад < 0.4с; Excel 10k мөр ≈ 2.3с (event loop-ийн гацалт ≈ 0.2с).

## Excel (NFR-9) ба аудит (NFR-4/5)
`excel.exporter.ts` (ExcelJS **streaming** `WorkbookWriter`): 1–4-р мөр = гарчиг, огноо, шүүлт, үүсгэсэн; 5-р мөр = толгой (bold, freeze, autofilter); дараа нь өгөгдөл (`#,##0.00`, `#,##0`, `0.00%`, `yyyy-mm-dd`), төгсгөлд "Нийт" мөр.
Мөр бүрийг commit хийж шууд шахна, `EXPORT_YIELD_EVERY` (500) мөр тутамд event loop-д амс өгнө (хэмжилт 49k мөр × 23 багана: peak heap 1.0GB → ≈0.25GB, RSS 1.5GB → ≈0.5GB,
event loop-ийн гацалт ≈20с → ≈1.4с — үлдсэн нь Prisma-ийн том хариуг задлах синхрон хугацаа; 20k мөрөнд ≈0.5с). `sql-report` дахь мөр хөрвүүлэлт ч 1000 мөр тутамд амс өгнө.
Excel ба JSON нэг `run` функцээр гарна (тестээр мөрийн тоо, утга тулгасан). Мөрийн тоо `report.max_export_rows` (анхдагч 50,000) -оос хэтэрвэл 422 `EXPORT_TOO_LARGE` —
**нийт тоогоор мөр уншихаас өмнө** шалгана (`ReportInput.maxRows`), тиймээс татгалзах нь хямд (49k+ мөрөнд ≈4с, event loop гацалтгүй).
Экспорт процесс тутамд `EXPORT_CONCURRENCY` (2) зэрэг, `EXPORT_MAX_QUEUE` (4) хүлээнэ; илүүд 429 `EXPORT_BUSY`.
Амжилттай экспорт бүр `report_run` мөр бичнэ (`reportKey`, `format='XLSX'`, `rowCount`, `runBy`, `paramsJson` = шүүлт + хүрээ + `dataSource` + `registerMasked:true`; `search` нуугдмал). Амжилтгүй экспорт аудитад орохгүй. JSON харалт аудитгүй.
**Өгөгдлийн эх сурвалж**: `ReportResult.dataSource` (`origination` | `core-mock` | `core`). `core-mock` (deposit-balances, Core-д холбоогүй) үед Excel-ийн гарчиг, хуудасны нэр (`MOCK …`),
"Огноо", "Үүсгэсэн" мөрөнд "ЗОХИОМОЛ (MOCK) ӨГӨГДӨЛ — Core-оос биш" гэж бичигдэж, `report_run.params_json.dataSource`-д бүртгэгдэнэ. `NODE_ENV=production` үед mock өгөгдлийг экспортлохгүй (501 `INTEGRATION_NOT_IMPLEMENTED`); JSON харалт үлдэнэ.

## Dashboard (`DashboardSummary`)
`applications` (төлвөөр тоо/дүн, энэ сарын илгээсэн/батлагдсан/буцаасан, `approvalRate` = батлагдсан ÷ (батлагдсан+буцаасан), `avgDecisionHours` сүүлийн 90 хоног) ·
`disbursements` (энэ сар/өмнөх сар/YTD, сүүлийн 12 сар — хоосон сар 0) · `portfolio` (идэвхтэй зээл, үлдэгдэл, хэтэрсэн дүн/тоо, `parRatio`, 5 хувин — ангилал `agingBucket`) ·
`collections` (энэ сард төлөх/цуглуулсан/хувь — энэ сард бүрэн төлөгдөж **CLOSED болсон зээлийг ч** хамарна, эс бөгөөс хамгийн сайн төлөгчид хасагдаж хувь доогуур гарна; дараагийн 7 хоног — зөвхөн ACTIVE/MIGRATED) · `topProducts` (топ 5, DRAFT-гүй). "Энэ сар" = asOf-ийг агуулсан UB сар, asOf өдрийн төгсгөл хүртэл. Хоосон өгөгдөл/0-д хуваалт → `null`.
**Ачаалал** (нийтлэг Prisma pool 4 цөмд 9 холболт; өмнө нь 6 query зэрэг → 50 зэрэгцээ хүсэлтэд P2024 → 500): ижил түлхүүр (org+хүрээ+валют+asOf)-ийн зэрэгцээ хүсэлт нэг тооцоололд нэгдэнэ (single-flight);
үр дүн 30с кэшлэгдэнэ (`REPORT_DASHBOARD_CACHE_SECONDS`, 0 = кэшгүй; хүрээ түлхүүрт орсон тул эрхийг давахгүй, эрхийн шалгалт кэшээс өмнө); нэг тооцоолол ≤ 2 query зэрэг;
өөр түлхүүртэй тооцоолол процесс даяар ≤ 2 зэрэг (дараалал 50, дүүрвэл 429 `REPORT_BUSY`) → pool-д хамгийн ихдээ 4 холболт; query бүр `statement_timeout`-той.

## Core депозит (`integrations/core-deposit/`)
`CoreDepositPort.listBalances` — mock (регистрээс sha256-аар deterministic данс/үлдэгдэл) ба real (`CORE_DEPOSIT_API_URL`, `CORE_DEPOSIT_API_KEY`; тохиргоогүй → 503, тохиргоотой ч **NotImplemented** → 501:
Core-ийн API баримт ирээгүй тул protocol зохиогоогүй — docs/04 "Хүний оролцоо" #1). Сонголт: `resolveIntegrationMode('core-deposit')` (`INTEGRATION_MODE_CORE_DEPOSIT`).

## Тест
`cd apps/origination && TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/los_test_report REDIS_URL=redis://127.0.0.1:6379/4 pnpm exec vitest run src/modules/report src/integrations/core-deposit`

- unit: `report-dates`, `report-scope`, `report-values`, `report-sql` (ангилал ↔ `agingBucket` 0..400, injection), `sql-report`, `report-registry`, `excel.exporter` (ExcelJS буцаан унших), `asset-description`
- `report.reports.integration` — 9 тайлан, гараар тооцсон өгөгдөл (`report.fixtures.ts` дахь тайлбар)
- `report.access.integration` — 401/403/404/400, injection, хүрээ, org тусгаарлалт, хуудаслалт, эрэмбэ, asOf, ЭТХ сонголт, Core real горим, хамтран зээлдэгч/батлан даагч
- `report.export.integration` — xlsx бүтэц/формат/хэв, JSON ↔ xlsx, аудит, `max_export_rows`, зэрэгцээ экспорт, mock өгөгдлийн тэмдэглэгээ (Excel/JSON/аудит/production)
- `report.load.integration` — dashboard single-flight/кэш/зэрэгцээ хязгаар/429, кэш эрхийн хүрээг давахгүй, `maxRows` (9 тайлан), `statement_timeout`
- `report.service.test` (DB-гүй) — экспортын semaphore (429), timeout → 504, production+mock → 503; `concurrency.test`, `report-db.test`
- `report.dashboard.integration` — KPI-ын гараар тооцсон утга, хүрээ, USD, түүхэн asOf, UB цагийн хил, хоосон өгөгдөл
- `report.perf.integration` — 10,000 зээл дээр ≤ 2с (NFR-1), экспортын event loop гацалт, 50 зэрэгцээ dashboard (нэмэлт ~40с)
