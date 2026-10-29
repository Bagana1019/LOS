# underwriting — Тооцоолол (A/B/C), scoring талын хадгалалт

Модуль 8: FR-8.1…8.6, BR-1…BR-5 (docs/05-scoring-sosco.md §2, §4). Цэвэр логик `@los/calc` `underwrite()` (I/O-гүй, 100% coverage) — энд
ЗӨВХӨН хадгалалт, сонголт (AUTO/MANUAL), хуучирсан тэмдэг, `ScoringCompleted` event, HTTP. BR утга (ӨОХ 0.55, ӨТЧХ 1.25, LTV 0.7, жингийн босго 0.7,
stress) энд HARDCODE БИШ: origination `setting`-ээс уншиж `ScoreRequest.policy` / `stress` болгон дамжуулна.

Дотоод API (origination дууддаг; gateway `underwrite`-ийг ГАРГАХГҮЙ — `INTERNAL_ONLY_PREFIXES`). Scoring нь `applicationId`-ийн хүрээг (NFR-3) мэдэхгүй —
хүрээг origination шалгана; энд зөвхөн байгууллага (`X-Org-Id`, бүх query `org_id`-аар) ба эрх.

## Файлууд
| Файл | Үүрэг |
| --- | --- |
| `underwriting.module.ts` | `UnderwritingModule` (`app.module.ts`-д холбогдсон) |
| `underwriting.controller.ts` | `@Controller('underwrite')`, `@UseFilters(AllExceptionsFilter)`, `@Permissions(...)` |
| `underwriting.service.ts` | `preview`, `persist`, `latest`, `select`, `markStale` — нэг транзакц: advisory lock → мөр → outbox |
| `calculation.mapper.ts` | Цэвэр: `toCreateData`, `toRecord` (мөр ⇄ `CalculationRecord`), `policyCheckOf`, `stressJsonOf`, `selectionKindOf` |
| `scoring-http.ts` | Нийтлэг (sosco-той хуваалцана): `scoringError`/кодууд, `ScoringZodPipe`, `requireUserId`, `TX_OPTIONS` |

## API (`/api/underwrite`)
| Endpoint | Эрх | Хариу |
| --- | --- | --- |
| `POST /preview` | `application:read` | 200 `UnderwriteResult`. Хадгалахгүй, event-гүй, DB-д хүрэхгүй (slider, FR-8.3) |
| `POST /` | `application:write` | 201 `CalculationRecord` (`UnderwritePersistRequest`). 422 `METHOD_NOT_APPLICABLE` |
| `GET /applications/:applicationId/latest` | `application:read` | 200 `CalculationRecord` · 404 `CALCULATION_NOT_FOUND` |
| `PUT /applications/:applicationId/selection` | `application:write` | 200 `CalculationRecord` (`SelectMethodRequest`) · 404 → 409 `CALCULATION_STALE` → 422 `METHOD_NOT_APPLICABLE` |
| `POST /applications/:applicationId/stale` | `application:write` | 200 `CalculationRecord` (`MarkCalculationStaleRequest`). Идемпотент · 404 `CALCULATION_NOT_FOUND` |

Эрх: OFFICER бичнэ; BRANCH_MANAGER / APPROVER / ADMIN уншина (бичихэд 403 `FORBIDDEN`). Бичих үйлдэл хариуцагчтай байх ёстой (`X-User-Id` байхгүй → 401).
Алдааны бие — foundation: `{ code, message (монгол), details?, correlationId }`. Controller бүр `@UseFilters(AllExceptionsFilter)` тул `main.ts`-ийн
global `BsaExceptionFilter` домэйн кодыг (`CALCULATION_STALE` …) статусын нийтлэг код руу (`CONFLICT`) буулгахгүй. Хүчингүй бие → 400 `VALIDATION_FAILED`,
`details = [{ path, code }]` — ирсэн УТГА хэзээ ч эргэж гарахгүй (zod-ын `invalid_enum_value` мессеж утгыг агуулдаг тул өөрийн pipe).

## Хадгалалт (`scoring.calculation`, миграци `20261029070000_underwriting_sosco`)
`persist` = НЭГ транзакц:
1. `pg_advisory_xact_lock(hashtextextended('calculation:<org>:<application>'))` — нэг хүсэлтийн бичилтүүд цувна.
2. Өмнөх сүүлийн `computed_at`-аас хатуу их `computed_at` (тэнцвэл +1 мс, цаг ухарвал мөн адил) — "сүүлийн" нь үргэлж хамгийн сүүлд хадгалагдсан.
3. Мөр: `inputs_json` = `ScoreRequest`, `result_json` = бүтэн `UnderwriteResult`, `method_a/b/c_json` = 3 `MethodVerdict`, `auto_selected_method`, `customer_id`,
   `policy_check_json`, `stress_json`, сонголт.
4. Арга сонгогдсон бол `ScoringCompleted` → `scoring.outbox` (ЯГ ИЖИЛ транзакц; relay Redis Stream руу гаргана).

Сонголт: `selectedMethod` өгсөн + хэрэглэгдэх бол **MANUAL** (`selected_by` = хэрэглэгч, `selected_reason`), хэрэглэгдэхгүй бол 422 (юу ч хадгалагдахгүй); өгөөгүй бол
BR-4 автомат **AUTO** (`selected_by` = null, `selected_at` = одоо); орлого огт байхгүй бол сонголтгүй, event-гүй. `selection` нь баганад хадгалагдахгүй — `selected_method`
байгаа бөгөөд `selected_by` null бол AUTO, үгүй бол MANUAL.

`policy_check_json` = `{ dti, dscr, dscrCombined, ltv }`, тус бүр `{ value, limit, pass }` — `dti` = A (BR-1), `dscr` = B, `dscrCombined` = C (BR-2/5), `ltv` = BR-3.
Сонголтоос үл хамаарна (сонголт өөрчлөгдөхөд зөвхөн `selected_*` багана шинэчлэгдэнэ). `stress_json` = `{ rateDeltaPoints, incomeChange, stressedMonthlyPayment, outcomes: { A_SALARY, B_BUSINESS, C_COMBINED } }`
(stress өгөөгүй бол NULL).

`latest` = `computed_at` хамгийн шинэ, ижил бол `id`. `select`/`markStale` нь `persist`-тэй ЯГ ИЖИЛ түгжээг авдаг тул зэрэг дуудлага "сүүлийн" мөрөө алдахгүй.
`markStale` зөвхөн сүүлийн мөрийг хуучруулна; аль хэдийн хуучирсан бол мөр өөрчлөгдөхгүй (анхны шалтгаан хэвээр, `updated_at` өөрчлөгдөхгүй). Шинэ `persist` хуучрахгүй мөр үүсгэнэ.

## Event — `ScoringCompleted` (v1 өөрчлөгдөөгүй)
`{ applicationId, selectedMethod, soscoScore, dtiPercent }` + нийтлэг талбар (`orgId`, `actorId`, `correlationId`).
`soscoScore` = `(org, applicationId, customerId)`-ийн хамгийн шинэ `sosco_result.score`, байхгүй (эсвэл `customer_id` null) бол `null`; `dtiPercent` = сонгосон аргын `burdenPercent`.
Гарах цэг: `persist` (арга сонгогдсон бол) болон `select`. Хэрэглэгч: origination (`selected_calc_method`, алхам `score`-ийг тулгана), dwh.

## Тест
```bash
cd apps/scoring
TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_scoring_test REDIS_URL=redis://localhost:6379/3 pnpm exec vitest run src/modules/underwriting test/underwriting.e2e.test.ts
```
DB-тэй тестүүд `TEST_DATABASE_URL`-гүй үед алгасагдана (`describe.skipIf`); DB-ийн нэр `test`-ээр төгссөн байх ёстой (TRUNCATE хийнэ).

| Файл | Хамрах зүйл |
| --- | --- |
| `calculation.mapper.test.ts` | Цэвэр: мөр ⇄ `CalculationRecord` (zod-оор), `policy_check_json`, `stress_json`, AUTO/MANUAL, `result_json`-гүй мөр |
| `scoring-http.test.ts` | Алдааны код/статус/монгол мессеж, pipe утга эргүүлэхгүй байх, `requireUserId` |
| `underwriting.service.test.ts` | PostgreSQL: AUTO/MANUAL/хэрэглэгдэхгүй, latest, select, stale (идемпотент), `ScoringCompleted` (`soscoScore` сүүлийн оноо), атомик байдал (outbox-ийн DB trigger-ээр унагана), зэрэгцээ бичилт (`computed_at` тусдаа), байгууллагын тусгаарлал |
| `test/underwriting.e2e.test.ts` | Жинхэнэ `AppModule` + `configureBsaApp` + supertest: 401, эрхийн матриц, `VALIDATION_FAILED` (утга эргэхгүй), persist → latest гэрээ, 409/422/404, event, org тусгаарлал |
