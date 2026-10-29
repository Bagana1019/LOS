# score — Тооцоолол (A/B/C) ба Sosco Score-ийн origination фасад

Модуль 8: FR-8.1…8.6, BR-1…BR-5, FR-5.5 (Sosco → үнэ), NFR-3/4. Тооцоолол өөрөө `apps/scoring` + `@los/calc`-д (origination `underwrite()`-ийг ХЭЗЭЭ Ч дуудахгүй).
Энд: оролт цуглуулах, scoring дуудах (sync REST), хүсэлт/алхам/аудитыг нэг транзакцид шинэчлэх, хүрээ/эрх. Спец: `docs/05-scoring-sosco.md` §5.

## Файлууд
| Файл | Үүрэг |
| --- | --- |
| `score.controller.ts` | REST (`/api/applications/:id/score…`, gateway-д `/api/origination/…`) |
| `score.service.ts` | `overview`, `preview`, `calculate`, `select`, `markStale` (Loan-terms / Schedule модульд export) |
| `score-input.assembler.ts` | DB → `ScoreRequest` + `SoscoInput`. Цэвэр функцүүд (`aggregateIncome`, `resolvePolicy`, `newMonthlyPayment`, `buildSoscoInput` …) + DB-ээс цуглуулдаг `ScoreInputAssembler` |
| `score.rules.ts` | Цэвэр: `calc_snapshot_json`, алхамын төлөвийн төлөвлөгөө, хуучирсан давхарга |
| `scoring.client.ts` | `ScoringClient` порт (`SCORING_CLIENT`) + `HttpScoringClient` (`InternalHttpClient`, 3с, POST/PUT дахин оролдохгүй, zod-оор шалгана) |
| `credit-history/` | `CreditHistoryPort` (`CREDIT_HISTORY`): `MockCreditHistory` (**DEMO**), `KycCreditHistory` (real: Модуль 3 хүртэл `null`) |
| `score-events.subscriber.ts` | `ScoringCompleted` (group `origination`, `idempotentHandler`) → `selected_calc_method` ба алхам `score`-ийг тулгана |
| `testing/` | Статик fixture (`scoring-fixtures.ts`) ба `FakeScoringClient` — build-д орохгүй |

## API
| Method path | Эрх | Хариу |
| --- | --- | --- |
| `GET applications/:id/score` | `application:read` (+ хүрээ) | `ScoreOverview` |
| `POST applications/:id/score/preview` | `application:read` | `ScorePreviewResponse`; хязгаараас гарвал 422 `OUT_OF_PRODUCT_LIMITS` |
| `POST applications/:id/score/calculate` | `application:write` (зөвхөн ЗЭЗ) | `ScoreOverview` |
| `PUT applications/:id/score/selection` | `application:write` | `ScoreOverview` |

Алдаа: 422 `LOAN_TERMS_MISSING`, 422 `PRIMARY_BORROWER_MISSING`, 409 `APPLICATION_NOT_EDITABLE` (DRAFT/RETURNED биш), 409 `CALCULATION_STALE`, 422 `METHOD_NOT_APPLICABLE` / 404 `CALCULATION_NOT_FOUND` (scoring-ийнх өөрчлөгдөхгүй), 503 `SCORING_UNAVAILABLE`.

## Оролт цуглуулалт
- Нөхцөл: `loan_application` (дүн, хугацаа, хүү). Дутуу бол `blockers=[LOAN_TERMS_MISSING · loan]`, calculate/preview → 422.
- Цалин, ЦМУ: үндсэн + `income_included=true` хамтран зээлдэгчийн `income_summary`-ийн нийлбэр; өрхийн зардал зөвхөн үндсэнийх; батлан даагч/барьцаалагч орохгүй.
- Барьцаа: Σ `collateral.collateral_value` (`released_at` байвал орохгүй); `collateralRequired = product.requires_collateral`.
- Бодлого: `setting` (`br1.dti_max`, `br2.dscr_min`, `br3.ltv_max`, `br4.method_weight_threshold`) — `product.max_dti/min_dscr/max_ltv/calc_weight_threshold` (null биш) давамгайлна. Stress: `stress.rate_delta` × 100 п.п., `stress.income_delta`.
- Идэвхтэй өр: ЗМС (`CreditHistoryPort`) ба `bsa_summary_json.existingDebtServiceMonthly`-ийн **их нь**.
- Шинэ төлбөр: хуучраагүй, тэнцүү төлбөртэй ЭТХ байвал эхний мөрийн `total`, үгүй бол annuity (`TODO(M07)`). Slider override-д annuity.
- Sosco: ЗМС (`fico`, `activeLoanCount`, `overdueHistoryMonths`); BSA ANALYZED бол `dtiPercent`, `incomeReliability`, `pendingSuspiciousCount`, үгүй бол сонгосон аргын `burdenPercent`, бусад нь `null`; `ltv` — тооцооллын LTV.

## calculate-ийн дараалал
`latest` ∥ `preview` → Sosco (persist) → underwrite (persist, өмнөх ГАР сонголт боломжтой хэвээр бол дамжуулна) → нэг транзакц: `loan_application` мөрийг `FOR UPDATE` → `selected_calc_method`, `calc_snapshot_json` → алхам `score` (COMPLETED / PENDING) → `audit_log` (`CALCULATION`).
Sosco нь underwrite-аас өмнө: `ScoringCompleted.soscoScore` шинэ оноог агуулах ёстой. Sosco-ийн загвар байхгүй/хүчингүй бол A/B/C үргэлжилнэ.

## `calc_snapshot_json`
`calculationId, selectedMethod, selection, ratioKind, ratio, limit, pass, eligible, ltv, soscoScore, soscoGrade, computedAt, syncedAt[, reconciled]`. `syncedAt` нь scoring-ийн сүүлчийн үйл явдлын цаг — хоцорч ирсэн хуучин үр дүн / `ScoringCompleted` шинэ төлвийг дарахгүй.

## Хуучруулах (`ScoreService.markStale(ctx, applicationId, reason)`)
Нөхцөл / ЭТХ / оролцогч өөрчлөгдсөн модуль өөрчлөлтөө commit хийсний дараа дуудна. Алхам COMPLETED → STALE (шалтгаантай; 200 тэмдэгтээр таслагдана, хоосон бол стандарт шалтгаан — дуудагч унахгүй), scoring-д `…/stale`. Scoring унасан ч шидэхгүй (`scoringMarked=false`): алхам нь эцсийн эх сурвалж — GET overview хуучирсан гэж харуулж, `select` 409 өгнө. Дахин тооцоолбол STALE арилна.

## Тест
`pnpm exec vitest run src/modules/score` (DB-тэй тестэд `TEST_DATABASE_URL`, `REDIS_URL`). Scoring fake: `SCORING_CLIENT` token-ыг `overrideProvider`-аар солино.
