# sosco — Sosco Score (дотоод, 0–1000, A–E)

Модуль 8: docs/05-scoring-sosco.md §3, §4 · FR-5.5 (оноо → үнэ тогтоолт, `ScoringCompleted.soscoScore`). Логик: `packages/calc/src/sosco-score.ts` (цэвэр функц,
`soscoScore`, `validateSoscoModel`, `gradeFor`, `DEFAULT_SOSCO_*`). Энэ модуль: загвар (`scoring.sosco_model`, хувилбартай, байгууллага тутамд нэг идэвхтэй),
оноо тооцоолж хадгалах (`scoring.sosco_result`), HTTP. Оролтыг (ЗМС/FICO, BSA, тооцооллын LTV) цуглуулах нь origination фасадын (`apps/origination/src/modules/score`) үүрэг.

> Жин, босго, муруй, ЗМС-ийн мужийн бодит утгыг эрсдэлийн баг өгөх хүртэл **DEMO** (`@los/calc` `DEFAULT_SOSCO_*`) — docs/DECISIONS.md Q-M8-1, Q-M8-2.

## Файлууд
| Файл | Үүрэг |
| --- | --- |
| `sosco.module.ts` | `SoscoModule` (`app.module.ts`-д холбогдсон) |
| `sosco.controller.ts` | `@Controller('sosco')`, `@UseFilters(AllExceptionsFilter)`, `@Permissions(...)` |
| `sosco.service.ts` | `score` (идэвхтэй загвар → `soscoScore` → `sosco_result`), `latest` |
| `sosco-model.service.ts` | `ensureActiveModel` (race-safe), `getActive`, `list`, `save` (шинэ хувилбар + `SettingsChanged`), `assertValidModel` |
| `sosco-model.mapper.ts` | Цэвэр: мөр → `SoscoModelView` / `ModelParams`; `params_json` null → `DEFAULT_SOSCO_CURVES` |
| `sosco-result.query.ts` | `latestResult`, `latestSoscoScore` (underwriting-ийн `ScoringCompleted` ч ашиглана) |
| `save-model.pipe.ts` | `PUT /models` бие: бүтцийн алдаа → 400, домэйн дүрмийн зөрчил → 422 `INVALID_SOSCO_MODEL` |

## API (`/api/sosco`)
| Endpoint | Эрх | Хариу |
| --- | --- | --- |
| `POST /score` | `application:write` | 200 `SoscoScoreResponse` (`SoscoScoreRequest`). `persist` (анхдагч true) ба `SCORED` үед `sosco_result` мөр, `resultId`. `INSUFFICIENT_DATA` → 200, `score: null`, **хадгалахгүй** |
| `GET /results/latest?applicationId&customerId` | `application:read` | 200 `SoscoSummary` · 404 `NOT_FOUND` (оноо хараахан байхгүй — origination `null` гэж ойлгоно) |
| `GET /models` | `application:read` | `SoscoModelView[]`, шинэ хувилбар эхэнд |
| `GET /models/active` | `application:read` | `SoscoModelView`; загвар байхгүй байгууллагад DEMO v1-ийг үүсгэнэ |
| `PUT /models` | `settings:manage` (ADMIN) | 200 шинэ `SoscoModelView` (`SaveSoscoModelRequest`) · 422 `INVALID_SOSCO_MODEL` |

`score`, `results` — дотоод (gateway гаргахгүй, `INTERNAL_ONLY_PREFIXES`; хүрээг origination шалгана). `models` — gateway-ээр нээлттэй; gateway route-policy `PUT /api/scoring/sosco/models`-ийг
хамгаалдаг, сервис `settings:manage`-ийг дахин шалгана. Алдааны бие — foundation `{ code, message (монгол), details?, correlationId }` (`underwriting/README.md`).

## Загвар (`sosco_model`)
- Нэг байгууллагад нэг идэвхтэй. `ensureActiveModel(orgId)`: идэвхтэй загвар байхгүй бол байгууллагын advisory lock дотор дахин шалгаад DEMO v1-ийг (`weights`, `grade_thresholds`, `params_json` = `DEFAULT_SOSCO_*`) үүсгэнэ — зэрэг эхний дуудлага яг НЭГ загвар үүсгэнэ.
- `PUT /models` = НЭГ транзакц: байгууллагын advisory lock → `version = max + 1` → өмнөх нь `is_active = false` (мөр устахгүй, `sosco_result.model_id` түүхийг заана) → шинэ нь идэвхтэй → `SettingsChanged { key: 'sosco.model', productId: null }` outbox.
- `curves` өгөөгүй бол **идэвхтэй загварын муруй** хадгалагдана (жин/босго засахад муруй алдагдахгүй); идэвхтэй загвар байхгүй бол DEMO. Шинэ хувилбар муруйг үргэлж `params_json`-д тодорхой хадгална.
- `params_json = NULL` (Модуль 0-ийн хуучин v1 мөр) → `DEFAULT_SOSCO_CURVES`.
- Шалгалт: zod (`SaveSoscoModelRequest`) + `validateSoscoModel`. Бүтцийн алдаа (дутуу талбар, төрөл, мужаас гарсан тоо) → 400 `VALIDATION_FAILED`; жингийн нийлбэр ≠ 1, босго чанд буурахгүй / E ≠ 0, муруйн хоёр үзүүр буруу → 422 `INVALID_SOSCO_MODEL` (`details` = `[{ path, code }]`).
  Хадгалагдсан идэвхтэй загвар эвдэрсэн (гараар засварласан) үед `score` нь 500 биш 422 `INVALID_SOSCO_MODEL` өгнө — origination оноог "мэдэгдэхгүй" гэж үзээд A/B/C-г үргэлжлүүлнэ.

## Оноо (`sosco_result`)
`score` = идэвхтэй загвараар `soscoScore(input, weights, thresholds, curves, version)`. `persist` үед: `score`, `grade`, `inputs_json` = `SoscoInput`, `breakdown_json` = `{ components, coverage }`,
`model_id` = оноог гаргасан хувилбар, `created_by`. `latest` = `(org, applicationId, customerId)` хүрээнд `computed_at` хамгийн шинэ (ижил бол `id`); `modelVersion` нь `model_id`-ийн хувилбар.
Мэдэгдэхгүй (null) бүрэлдэхүүн жинг үлдсэнд дахин хуваарилна; `coverage < minCoverage` → `INSUFFICIENT_DATA` (`@los/calc`).

## Event
- `SettingsChanged { key: 'sosco.model', productId: null }` — `PUT /models`-той нэг транзакцид outbox-д. Үнэ тогтоолт (FR-5.5) болон бусад сервис projection-аа шинэчилнэ.
- `ScoringCompleted.soscoScore` — энэ модулийн хамгийн шинэ `sosco_result.score`-ийг underwriting уншина (`sosco-result.query.ts`).

## Тест
```bash
cd apps/scoring
TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_scoring_test REDIS_URL=redis://localhost:6379/3 pnpm exec vitest run src/modules/sosco test/sosco.e2e.test.ts
```
| Файл | Хамрах зүйл |
| --- | --- |
| `save-model.pipe.test.ts` | Цэвэр: 400 (бүтэц, утга эргэхгүй) ба 422 (домэйн дүрэм) ялгаа |
| `sosco-model.service.test.ts` | PostgreSQL: `ensureActiveModel` (race, нэг загвар), `save` (version+1, өмнөх идэвхгүй, муруй хадгалах), `SettingsChanged`, 422 (4 төрөл, эвдэрсэн идэвхтэй загвар), 401, атомик байдал, зэрэгцээ `save`, org тусгаарлал |
| `sosco.service.test.ts` | PostgreSQL: SCORED хадгалагдана, `persist=false`, `INSUFFICIENT_DATA` хадгалагдахгүй (coverage 0 / 0.25 / яг 0.5), идэвхтэй хувилбар, `latest`, зэрэгцээ эхний хэрэглээ |
| `test/sosco.e2e.test.ts` | Жинхэнэ `AppModule` + supertest: 401, эрхийн матриц (score = ЗЭЗ; models = ADMIN), 400/422, score → latest гэрээ, шинэ загвар → дараагийн score, org тусгаарлал |
