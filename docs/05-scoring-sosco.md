# 05 · Модуль 8 — Тооцоолол (A/B/C) ба дотоод Sosco Score

Шаардлага: docs/01 FR-8.1…8.6, BR-1…BR-5, FR-5.5 (Sosco → үнэ) · docs/04 Модуль 8 · CLAUDE.md §3 (origination → scoring sync REST).
Гэрээ (zod, цорын ганц эх): `packages/contracts/src/scoring.ts`. Цэвэр логик: `packages/calc/src/underwriting.ts`, `sosco-score.ts`.
Сервис: `apps/scoring/src/modules/{underwriting,sosco}`. Фасад: `apps/origination/src/modules/score`. UI: `apps/web/src/features/score` (wizard `/los/loan-application/:id/score`).

## 1. Хэрэгжилтийн төлөв (энэ PR)

| Хэсэг | Төлөв | Тэмдэглэл |
| --- | --- | --- |
| `@los/calc` underwriting (A/B/C, LTV, stress, боломжит дээд дүн) | ✅ | 100% coverage |
| `@los/calc` sosco-score (0–1000, A–E) | ✅ | жин/босго/муруй `sosco_model`-оос |
| scoring: `/api/underwrite`, `/api/sosco/*`, `calculation`/`sosco_result` хадгалалт, `ScoringCompleted` | ✅ | миграци `20261029070000_underwriting_sosco` |
| origination `score` фасад (оролт цуглуулах, scoring дуудах, алхам төлөв, `ScoringCompleted` засвар) | ✅ | Модуль 2–7 main-д ороогүй тул одоо байгаа хүснэгтээс уншина (§5) |
| web `score` алхам (харьцуулах хүснэгт, slider, шалгуур, stress, Sosco карт) | ✅ | |
| ЗМС/FICO бодит лавлагаа | ⛔ DEMO mock | Модуль 3 + бодит API (docs/04 «Хүний оролцоо» №1) |
| Төлбөрийн ЭТХ (Модуль 7) | ⛔ annuity-аар орлуулсан | `buildSchedule` TODO(M07) |

## 2. Тооцоолол (`underwrite`)

Оролт `ScoreRequest`, гаралт `UnderwriteResult`. Мөнгө ₮ (2 орон, ROUND_HALF_UP), харьцаа Decimal-аар (float drift-гүй).

| Арга | Суурь орлого | Харьцаа | Хязгаар (policy) | Хангана гэдэг |
| --- | --- | --- | --- | --- |
| A цалин | цалин | ӨОХ = (идэвхтэй зээлийн төлбөр + шинэ төлбөр) ÷ цалин | `maxDti` (BR-1, 0.55) | ӨОХ ≤ хязгаар |
| B бизнес | бизнесийн ЦМУ | ӨТЧХ = ЦМУ ÷ (идэвхтэй төлбөр + шинэ төлбөр) | `minDscr` (BR-2, 1.25) | ӨТЧХ ≥ хязгаар |
| C хосолсон | цалин + ЦМУ − өрхийн зардал (BR-5) | ӨТЧХ = суурь ÷ (идэвхтэй төлбөр + шинэ төлбөр) | `minDscr` | ӨТЧХ ≥ хязгаар |

* **LTV** (BR-3) = зээлийн дүн ÷ Σ барьцааны үнэлгээ ≤ `maxLtv` (0.7). `collateralRequired=false` ба хөрөнгөгүй бол LTV хамаарахгүй (`ltv=null`, `pass=true`, `maxAmount=null`). Шаардлагатай ч үнэлгээ 0 бол `NO_COLLATERAL_VALUE` (хангаагүй).
* **Автомат сонголт (BR-4)**: эерэг орлогын бүтэц `salaryShare = цалин⁺ ÷ (цалин⁺ + ЦМУ⁺)`; `salaryShare > weightThreshold` → A, үгүй бөгөөд `businessShare > weightThreshold` → B, үгүй бол C. Орлого огт байхгүй бол `autoSelected=null`, `NO_INCOME`. «Давбал» = хатуу `>` (яг 70% бол C).
* **Хэрэглэгдэх (`applicable`)**: A — цалин > 0; B — ЦМУ > 0; C — цалин > 0 эсвэл ЦМУ > 0. Хэрэглэгдэхгүй арга сонгогдохгүй (422 `METHOD_NOT_APPLICABLE`), `reasons`-д шалтгаан + алхам (FR-8.6): `NO_SALARY_INCOME` (income), `NO_BUSINESS_INCOME` / `NEGATIVE_BUSINESS_NCF` (income), `NO_INCOME`, `NON_POSITIVE_BASE_INCOME`.
* **Тоймлолтын дүрэм (ойлгомжтой, шалгагдахуйц)**: харуулах `ratio` нь **консерватив** — ӨОХ дээш (4 орон), ӨТЧХ доош (2 орон). `pass` нь бөөрөнхийлөөгүй утгаар шийдэгдэнэ; хязгаар харуулах нарийвчлалтай (0.55, 1.25) үед `ratio`-ийн харьцуулалт `pass`-тай үргэлж таарна. (AC: ӨТЧХ 15,205,822 ÷ 2,176,828 = 6.9853… → **6.98**; ӨОХ 55.89…% → **55.9%**.)
* **Боломжит дээд дүн**: `maxPayment` = A: `maxDti × цалин − идэвхтэй төлбөр`; B: `ЦМУ ÷ minDscr − идэвхтэй төлбөр`; C: `суурь ÷ minDscr − идэвхтэй төлбөр` (доод тал нь 0). `maxAffordable` = `maxPayment`-д тохирох annuity үндсэн дүн (хүү/хугацаа хэвээр, доош бүхэл ₮). `maxLoanAmount` = `min(maxAffordable, collateral.maxAmount)`. ЭТХ-ийн төрөл annuity гэж таамагласан (Q-M8-6).
* **Stress (FR-8.5)**: `stress` өгсөн үед хүү `+rateDeltaPoints` п.п. → шинэ сарын төлбөр (annuity), эерэг орлого (цалин, эерэг ЦМУ) `×(1+incomeChange)`, сөрөг ЦМУ, өрхийн зардал, идэвхтэй төлбөр хэвээр. Хоёр stress зэрэг. Үр дүн мэдээллийн шинжтэй (`pass` нь сонгох/илгээхийг хаахгүй).
* `eligible` = `applicable && pass && collateral.pass`. `burdenPercent` = `totalDebtService ÷ baseIncome × 100` (дээш, 1 орон; суурь ≤ 0 бол null) — Sosco-ийн `dtiPercent`, `ScoringCompleted.dtiPercent`.

## 3. Sosco Score (`soscoScore`)

0–1000 бүхэл оноо, A–E зэрэг. Бүрэлдэхүүн (docs/03 `SoscoWeights`): `fico, dti, reliability, suspicious, history, ltv`; жин нийлбэр 1.

| Бүрэлдэхүүн | Оролт | 0..1 болгох (DEMO муруй, `params_json`) |
| --- | --- | --- |
| fico | `ficoScore` | `(fico − 300) ÷ (850 − 300)` |
| dti | `dtiPercent` | ≤ 20% → 1; ≥ 80% → 0; шугаман |
| reliability | `incomeReliability` (BSA, 0..100) | `÷ 100` |
| suspicious | `pendingSuspiciousCount` | `1 − 0.2 × тоо` (доод 0) |
| history | `overdueHistoryMonths`, `activeLoanCount` | `1 − сар÷12 − 0.05×идэвхтэй зээл` (0..1) |
| ltv | `ltv` | ≤ 0.3 → 1; ≥ 1.0 → 0; шугаман |

* **Мэдэгдэхгүй (null) оролт** бүрэлдэхүүнийг оруулахгүй, жинг үлдсэн бүрэлдэхүүнд пропорциональ дахин хуваарилна (мэдэхгүй зүйлийг шагнахгүй, шийтгэхгүй). `coverage` = мэдэгдсэн жингийн нийлбэр; `coverage < minCoverage` (0.5) бол `INSUFFICIENT_DATA` (оноо `null`, хадгалахгүй) — үнэ тогтоолт (FR-5.5) default шатлалаар явна.
* `score = round(1000 × Σ(жин × утга) ÷ Σ(мэдэгдсэн жин))`. Зэрэг: A ≥ 800, B ≥ 700, C ≥ 600, D ≥ 500, E ≥ 0 (DEMO, `grade_thresholds_json`).
* `history` нь `overdueHistoryMonths` мэдэгдэх үед л байна (`activeLoanCount=null` → 0).
* Загвар `scoring.sosco_model` (хувилбартай, нэг идэвхтэй/байгууллага). `PUT /api/sosco/models` шинэ хувилбар үүсгэж идэвхжүүлнэ (өмнөх нь идэвхгүй). `sosco_result.model_id` нь тухайн оноог гаргасан хувилбарыг заана.

## 4. scoring API (дотоод; origination дууддаг)

Gateway-ээс `underwrite`, `sosco/score`, `sosco/results` **гаргахгүй** (`INTERNAL_ONLY_PREFIXES`) — scoring нь `applicationId`-ийн хүрээг (NFR-3) мэдэхгүй тул хүрээг origination шалгана. `sosco/models` gateway-ээр нээлттэй (унших — `application:read`, бичих — `settings:manage`, route-policy байгаа).

| Endpoint | Эрх | Тайлбар |
| --- | --- | --- |
| `POST /api/underwrite/preview` | application:read | `ScoreRequest` → `UnderwriteResult`. Хадгалахгүй, event-гүй (slider) |
| `POST /api/underwrite` | application:write | `UnderwritePersistRequest` → `CalculationRecord`. Шинэ `calculation` мөр; автомат (эсвэл өгсөн) арга сонгоно; сонгогдсон бол `ScoringCompleted` |
| `GET /api/underwrite/applications/:applicationId/latest` | application:read | Сүүлийн `CalculationRecord` · 404 `CALCULATION_NOT_FOUND` |
| `PUT /api/underwrite/applications/:applicationId/selection` | application:write | `SelectMethodRequest` · 409 `CALCULATION_STALE` · 422 `METHOD_NOT_APPLICABLE`; `ScoringCompleted` |
| `POST /api/underwrite/applications/:applicationId/stale` | application:write | `MarkCalculationStaleRequest` → `is_stale=true` (FR-7.3). Идемпотент |
| `POST /api/sosco/score` | application:write | `SoscoScoreRequest` → `SoscoScoreResponse` (идэвхтэй загвараар; `persist` үед `sosco_result`) |
| `GET /api/sosco/results/latest?applicationId&customerId` | application:read | Сүүлийн оноо |
| `GET /api/sosco/models`, `GET /api/sosco/models/active` | application:read | Хувилбарууд |
| `PUT /api/sosco/models` | settings:manage | `SaveSoscoModelRequest` → шинэ хувилбар; `SettingsChanged(key=sosco.model)` outbox |

Өгөгдөл (шинэ миграци `20261029070000_underwriting_sosco`, scoring): `calculation` + `customer_id`, `selected_reason`, `selected_at`, `stale_reason`, `result_json` (`UnderwriteResult` бүтнээрээ), индекс `(org_id, application_id, computed_at)`; `sosco_model` + `params_json`. Event: `ScoringCompleted` (v1 өөрчлөгдөөгүй): `selectedMethod`, `soscoScore` (үндсэн зээлдэгчийн сүүлийн `sosco_result`, байхгүй бол null), `dtiPercent` (= сонгосон аргын `burdenPercent`). Бичилт + outbox нэг транзакцид.

## 5. origination фасад (`/api/origination/…`, gateway-ээр)

Одоо байгаа хүснэгтээс уншина (Модуль 2–7-ийн модуль main-д хараахан байхгүй): `loan_application` (дүн/хугацаа/хүү/бүтээгдэхүүн), `income_summary` (цалин, ЦМУ, өрхийн зардал; үндсэн + `income_included` оролцогч), `collateral.collateral_value`, `loan_application.bsa_summary_json`, `product` (slider хязгаар BR-6), `setting` (br1–br4, stress.*). Хүрээ/эрх `ApplicationAccessService`-ээр.

| Endpoint | Эрх | Тайлбар |
| --- | --- | --- |
| `GET applications/:id/score` | application:read | `ScoreOverview` (нөхцөл, хязгаар, саад, сүүлийн тооцоолол, Sosco) |
| `POST applications/:id/score/preview` | application:read | `ScorePreviewRequest` → `ScorePreviewResponse` (slider; хадгалахгүй). Хязгаараас гарвал 422 `OUT_OF_PRODUCT_LIMITS` |
| `POST applications/:id/score/calculate` | application:write | Оролт цуглуулж → Sosco (persist) → underwrite (persist) → хүсэлтийн `selected_calc_method`, `calc_snapshot_json`, алхам `score` (COMPLETED / PENDING) |
| `PUT applications/:id/score/selection` | application:write | `SelectMethodRequest` |

* Оролт цуглуулалт: цалин/ЦМУ — үндсэн зээлдэгч + `income_included=true` оролцогчийн `income_summary` нийлбэр; өрхийн зардал — үндсэн зээлдэгчийнх (давхар тооцохгүй); идэвхтэй өрийн төлбөр — ЗМС (`CreditHistoryPort`) ба BSA-ийн **их нь** (консерватив); шинэ төлбөр — ЭТХ байхгүй тул annuity (`TODO(M07)`: `buildSchedule`).
* `CreditHistoryPort` (ЗМС/FICO: `ficoScore`, `activeLoanCount`, `overdueHistoryMonths`, `existingDebtServiceMonthly`): `MockCreditHistory` — **DEMO**, тогтвортой fixture (`INTEGRATION_MODE=mock`, анхдагч); `KycCreditHistory` — kyc `/inquiry/summary` (Модуль 3) хараахан байхгүй тул `null` буцаана (бүрэлдэхүүн «мэдэгдэхгүй» болно).
* Sosco `dtiPercent` — BSA шинжилгээ (ANALYZED) байвал түүний `dtiPercent` (INT-5), үгүй бол сонгосон аргын `burdenPercent`. Sosco нь үндсэн зээлдэгчийнх.
* `ScoringCompleted` consumer (origination, idempotent): `selected_calc_method` ба алхам `score`-ийг тулгаж засна (scoring бичсэн ч origination унасан тохиолдолд).
* Нөхцөл өөрчлөгдөхөд (Модуль 5/7) `ScoreService.markStale(applicationId, reason)` дуудна → scoring `…/stale` + алхам `STALE`.

## 6. UI (`/los/loan-application/:id/score`)

Харьцуулах хүснэгт (A/B/C багана: суурь орлого, өрийн үйлчилгээ, харьцаа/хязгаар, хангасан/хангаагүй өнгө, шалтгаан, боломжит дээд дүн, stress), «Автомат» тэмдэг + гараар сонгох, LTV шалгуур, slider (дүн, хугацаа, хүү — product хязгаарт; сарын төлбөр, нийт өрийн үйлчилгээ, хүүгийн орлого шууд), Sosco карт (оноо, зэрэг, бүрэлдэхүүнээр), хуучирсан/саадын мэдэгдэл. UI-д тооцоолол **хийхгүй** — бүгд серверээс; текст `t('score.*')` (`mn.score.json`).

## 7. DEMO утгууд ба нээлттэй асуултууд

DEMO: Sosco жин/босго/муруй (§3), `MockCreditHistory`, annuity төлбөр, stress +5 п.п. / −20% (setting). Бүгд тохиргоо/порт тул кодыг өөрчлөхгүй солино. Асуултууд `docs/DECISIONS.md`-д «Q-M8-n» гэж бүртгэсэн:

1. **Q-M8-1** Sosco Score-ийн бодит эрсдэлийн загвар: бүрэлдэхүүн, жин, муруй, зэргийн босго хэн өгөх вэ?
2. **Q-M8-2** FICO/ЗМС онооны бодит муж (300–850 гэж таамагласан)?
3. **Q-M8-3** ӨОХ (A арга)-д гар орлого (түрээс, тэтгэвэр) орох уу, зөвхөн НДШ цалин уу?
4. **Q-M8-4** BR-4 «жин» = эерэг орлогын нийлбэрт цалин/бизнесийн ЦМУ-ийн эзлэх хувь гэж ойлгосон — зөв үү? 70% яг тэнцвэл C.
5. **Q-M8-5** B аргын хуваагчид өрхийн зардал орохгүй (зөвхөн C-д хасагдана) — зөв үү?
6. **Q-M8-6** Боломжит дээд дүн, stress-ийн төлбөрийг annuity гэж тооцсон. Тэнцүү үндсэн төлбөр зэрэг бусад төрөлд тусад нь тооцох уу?
7. **Q-M8-7** Сонгосон арга хангаагүй (улаан) үед Илгээхийг хаах уу, эсвэл батлагч шийднэ (BR-9-тэй адил)? Одоо хаахгүй, алхам COMPLETED.
8. **Q-M8-8** Арга гараар солиход тайлбар заавал уу? Одоо заавал биш, хадгалагдана.
9. **Q-M8-9** Stress-ийн хоёр хувилбарыг (хүү +5 п.п., орлого −20%) зэрэг хэрэглэсэн; тус тусад нь харуулах уу? Stress унавал анхааруулга үү?
10. **Q-M8-10** Хамтран зээлдэгчтэй үед ямар оролцогчийн орлого нэгтгэх вэ (`income_included`) ба Sosco хэнийх (одоо үндсэн зээлдэгч)?
11. **Q-M8-11** Тооцоолол дахин хийх нөхцөл (хүү/дүн/хугацаа/орлого өөрчлөгдсөн) — одоо `STALE` тэмдэглэнэ; автоматаар дахин бодох уу?
12. **Q-M8-12** `br4.method_weight_threshold`-ийн бизнесийн утга 0 эсвэл 1 байж болох уу? (0 → цалин байвал үргэлж A, 1 → үргэлж C)
13. **Q-M8-13** Загваргүй org-д Sosco DEMO v1-ийг автоматаар үүсгэх нь зөв үү, эсвэл админ заавал идэвхжүүлэх ёстой юу? Оноо байхгүйг тусгай алдааны кодоор илэрхийлэх үү?
14. **Q-M8-14** `ScoringCompleted`-ийг тооцоолол бүрт гаргах уу, зөвхөн сонголт батлагдахад уу? Хэрэглэгч слайдерын нөхцөлөөр шууд хадгалж болох уу (одоо preview зөвхөн)?
