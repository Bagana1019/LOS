# @los/scoring

Порт **4003** (`SCORING_PORT`), HTTP угтвар `/api`. Тооцоолол engine (A/B/C), Sosco Score, BSA (банкны хуулгын шинжилгээ: parser, OCR,
ангилал, DTI, сэжигтэй гүйлгээ). DB schema: `scoring` (schema-per-service, Prisma).

| Модуль | Төлөв |
| --- | --- |
| `bsa/import` | **Бэлэн**: REST (4 controller), pipeline, upload, дахин тооцоолол, reclassify, finalize, retention |
| `bsa/parsers`, `bsa/parsers/text-extraction` | Бэлэн (7 банкны parser **зохиомол** хуулгаар л шалгагдсан — баталгаажаагүй) |
| `bsa/classify`, `bsa/dti` | Бэлэн (DTI томьёо `@los/calc`-д) |
| `bsa/common` | Дэд бүтэц: PII шифр, MinIO, BullMQ, outbox, тохиргоо, Prisma repository |
| `bsa/suspicion` | Хийгдээгүй (M12c); `SUSPICION_COUNTER` порт л бэлэн |
| `underwriting`, `sosco` | Энэ PR-д хамаарахгүй |

Бүтэн баримт (архитектур, урсгал, API, тохиргоо, хязгаар): [`docs/05-bsa-ocr.md`](../../docs/05-bsa-ocr.md).

> **Анхааруулга.** Бодит банкны хуулга байхгүй. Parser-ууд (`verified: false`) зөвхөн зохиомол хуулгаар шалгагдсан тул импорт бүр
> `UNVERIFIED_PARSER` анхааруулгатай дуусна. OCR-ээр уншсан тайлбар алдаатай байж болно — үр дүнг хүн шалгана.

## Ажиллуулах

```bash
cp .env.example .env && docker compose up -d && pnpm install     # CLAUDE.md §7
pnpm db:generate && pnpm db:migrate && pnpm db:seed              # schema `scoring`: baseline (M00) + 20261028150000_bsa_statement_analysis; seed: ангилал (23) + дүрэм (150) + Sosco загвар v1
pnpm --filter @los/scoring dev                                   # эсвэл: turbo run build --filter=@los/scoring && node apps/scoring/dist/main.js
curl localhost:4003/api/health
```

Production-тэй адил (бодит MinIO + Redis + Tesseract):
`REDIS_URL=redis://… MINIO_ENDPOINT=localhost:9000 INTEGRATION_MODE=real DATA_ENCRYPTION_KEY=… DATA_INDEX_KEY=… node apps/scoring/dist/main.js`.

- `DATA_ENCRYPTION_KEY[S]` + `DATA_INDEX_KEY` (Модуль 0, `.env.example`; base64, 32 байт) **заавал** — `NODE_ENV=test`-ээс бусад үед; түлхүүр алдвал өгөгдөл сэргээгдэхгүй.
- `MINIO_ENDPOINT` байхгүй бол **in-memory** файлын сан (дахин асахад алдагдана; зөвхөн dev), `REDIS_URL` байхгүй бол процесс доторх дараалал (зөвхөн dev).
  `NODE_ENV=production` үед эдгээр заавал.
- Асахад тохиргооны алдаа (буруу env, түлхүүр, Redis) нэртэй мессежтэй `exit 1`. SIGTERM дээр явж буй импорт ажлыг дуусгаж, цэвэрхэн унтарна.

### Орчны хувьсагч (товч; бүрэн хүснэгт `docs/05-bsa-ocr.md` §5)

| Бүлэг | Хувьсагч |
| --- | --- |
| Үндсэн | `DATABASE_URL` (эсвэл `SCORING_DATABASE_URL`), `SCORING_PORT` (4003), `DEFAULT_ORG_ID` (`X-Org-Id`-гүй үед), `INTERNAL_AUTH_SECRET` |
| Шифрлэлт (Модуль 0) | `DATA_ENCRYPTION_KEY` (эсвэл `DATA_ENCRYPTION_KEYS` + `DATA_ENCRYPTION_KEY_ID`), `DATA_INDEX_KEY` |
| Файл | `MINIO_ENDPOINT` (+ `MINIO_PORT`), `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` (эсвэл `MINIO_ROOT_USER`/`_PASSWORD`), `MINIO_USE_SSL`, `MINIO_REGION`, `BSA_BUCKET`, `BSA_OBJECT_MAX_BYTES` |
| Дараалал | `REDIS_URL`, `BSA_IMPORT_QUEUE`, `BSA_IMPORT_ATTEMPTS`, `BSA_IMPORT_BACKOFF_MS`, `BSA_IMPORT_CONCURRENCY` |
| OCR | `INTEGRATION_MODE` (`mock`\|`real`), `OCR_ENGINE`, `OCR_LANGUAGES`, `OCR_PSM`, `OCR_DPI`, `OCR_TIMEOUT_MS`, `OCR_MAX_PAGES`, `OCR_MAX_INPUT_BYTES`, `TESSERACT_BIN`, `PDFTOPPM_BIN` |
| Import | `BSA_IMPORT_MAX_ROWS`, `BSA_IMPORT_EXTRACT_TIMEOUT_MS`, `BSA_IMPORT_JOB_TIMEOUT_MS`, `BSA_IMPORT_CHUNK_ROWS` |
| Retention | `BSA_RETENTION_BATCH`, `BSA_RETENTION_INTERVAL_MS` (0 = таймергүй) |
| Бизнес босго | `BSA_COST_OF_GOODS_RATE`, `BSA_MAX_DTI`, `BSA_DTI_LOW_MAX`, `BSA_DTI_MEDIUM_MAX`, `BSA_OTHER_SHARE_THRESHOLD`, `BSA_ALLOWED_PERIOD_MONTHS`, `BSA_MIN_STATEMENT_MONTHS`, `BSA_RETENTION_YEARS`, `BSA_BALANCE_TOLERANCE`, `BSA_PUSH_POLICY`, `BSA_MAX_UPLOAD_BYTES`, `BSA_MAX_FILES_PER_UPLOAD`, `BSA_*_INCOME_CODES`, `BSA_RELIABILITY_WEIGHT_*`, `BSA_SETTINGS_CACHE_TTL_MS` |

## Gateway-ээс ирэх толгой (CLAUDE.md §3.2(9))

Авторизаци, rate limit gateway-д; gateway `/api/scoring/<зам>` -> энэ сервисийн `/api/<зам>` (жишээ: `/api/scoring/bsa/analyses`), `X-*` толгойг өөрөө тавина.
Модуль 0-ийн `CommonModule` (глобал middleware + guard + алдааны filter) нэвтрээгүй хүсэлтийг 401 (`UNAUTHENTICATED`), `X-Internal-Token` буруу бол 401
(`INTERNAL_AUTH_SECRET` тохируулсан үед) болгоно. Сервис толгойг итгэж ашиглана (**сүлжээнд шууд ил гаргахгүй**):
`X-User-Id` (заавал), `X-Roles` (таслалаар: `OFFICER`, `BRANCH_MANAGER`, `APPROVER`, `ADMIN`; BSA нь үл мэдэгдэх үүргийг 403-аар татгалзана), `X-Org-Id`,
`X-Branch-Id`, `X-Correlation-Id`. Хариу бүрт `X-Correlation-Id` буцна. Gateway-ийн `route-policy.ts` нь `/api/scoring/bsa/categories|rules` бичих хүсэлтийг
`settings:manage`-д хязгаарлана (сервис дотор ADMIN-аар давхар шалгана).

## REST: маршрут тутмын үүрэг

`RolesGuard` deny-by-default (`@Roles` заагаагүй handler 403). **Бүх үүрэг** = OFFICER, BRANCH_MANAGER, APPROVER, ADMIN (хүрээг service тодорхойлно);
**Бичих** = OFFICER, BRANCH_MANAGER, ADMIN (APPROVER зөвхөн уншина).

| Арга | Зам | Үүрэг |
| --- | --- | --- |
| POST | `/api/bsa/analyses` | Бичих |
| GET | `/api/bsa/analyses` | Бүх үүрэг |
| GET | `/api/bsa/analyses/:id` | Бүх үүрэг |
| DELETE | `/api/bsa/analyses/:id` | Бичих (зөвхөн DRAFT) |
| GET | `/api/bsa/analyses/:id/history` | Бүх үүрэг |
| POST | `/api/bsa/analyses/:id/imports` | Бичих (multipart `files`, `banks`) |
| GET | `/api/bsa/analyses/:id/imports` | Бүх үүрэг |
| POST | `/api/bsa/analyses/:id/recalculate` | Бичих |
| GET | `/api/bsa/analyses/:id/transactions` | Бүх үүрэг |
| GET | `/api/bsa/analyses/:id/breakdown` | Бүх үүрэг |
| POST | `/api/bsa/analyses/:id/reclassify` | Бичих |
| POST | `/api/bsa/analyses/:id/finalize` | Бичих |
| GET | `/api/bsa/analyses/:id/summary` | Бүх үүрэг |
| GET | `/api/bsa/analyses/:id/scoring-input` | Бүх үүрэг (зөвхөн ANALYZED) |
| GET | `/api/bsa/jobs` | Бүх үүрэг |
| GET | `/api/bsa/jobs/:id` | Бүх үүрэг |
| POST | `/api/bsa/jobs/:id/retry` | Бичих |
| GET | `/api/bsa/categories` | Бүх үүрэг |
| GET | `/api/bsa/rules` | **ADMIN** |
| POST | `/api/bsa/rules` | **ADMIN** |
| POST | `/api/bsa/admin/retention/run` | **ADMIN** |

Хандалтын хүрээ: ADMIN, APPROVER — байгууллагын бүх салбар; BRANCH_MANAGER — өөрийн салбар; OFFICER — өөрийн салбар **ба** өөрийн үүсгэсэн.
Өөр байгууллага (`orgId`) -> **404**, өөр салбар/ажилтан -> **403**. Дэлгэрэнгүй (хариу, алдааны код, upload семантик): `docs/05-bsa-ocr.md` §4,
`src/modules/bsa/import/README.md`.

Алдааны нэгдсэн хэлбэр (Модуль 0-ийн `{code, message, details?, correlationId}` + `statusCode`, `issues?[{path, code}]`): `docs/05-bsa-ocr.md` §4.4.

## Нууцлал (NFR-3)

- PII (тайлбар, харьцсан нэр/данс, файлын нэр, данс/IBAN/эзэмшигч, харилцагчийн snapshot) DB-д Модуль 0-ийн `v1.<keyId>.…` AES-GCM-ээр шифрлэгдсэн; хайлтын hash нь `blindIndex` (түлхүүртэй HMAC).
  Файл object store-д шифрлэгдэж очно (`bsa/common/README.md`).
- Лог, алдаа, анхааруулга, event, түүхэнд PII (нэр, регистр, данс, тайлбар, OCR текст) ОРОХГҮЙ.
- `GET /api/bsa/analyses?registerNo=` регистр URL-д орно: gateway query string-ийг логлохгүй байх ёстой.
- Хадгалах хугацаа (`BSA_RETENTION_YEARS`, анхдагч 3): `POST /api/bsa/admin/retention/run` эсвэл `BSA_RETENTION_INTERVAL_MS` таймер.

## Тест

```bash
cd apps/scoring
npx vitest run                                   # бүх unit + in-memory e2e (интеграцийн тест skip)
npx vitest run src/modules/bsa/import/e2e        # HTTP e2e (supertest, ЖИНХЭНЭ BsaModule)
npx eslint src
# Бодит Postgres + Redis (DB-ийн нэр `test`-ээр төгснө; vitest globalSetup `scoring` schema-г шинээр үүсгэж migrate + seed хийнэ, тестүүд TRUNCATE хийнэ):
TEST_DATABASE_URL=postgresql://…/los_scoring_test REDIS_URL_TEST=redis://… npx vitest run   # test/bsa.e2e.test.ts — жинхэнэ AppModule
```

Vitest нь `@los/*` багцыг эх кодоор нь уншина; Nest runtime/`tsc` нь тэдгээрийн `dist`-ийг уншдаг тул `@los/contracts` өөрчлөгдвөл
`pnpm exec turbo run build --filter=@los/scoring` (эсвэл `pnpm --filter @los/contracts build`) ажиллуулна.

## Холбоотой баримт

[`docs/05-bsa-ocr.md`](../../docs/05-bsa-ocr.md) · [`docs/02-bsa-requirements.md`](../../docs/02-bsa-requirements.md) · [`prisma/README.md`](prisma/README.md) ·
[`bsa/import`](src/modules/bsa/import/README.md) · [`bsa/parsers`](src/modules/bsa/parsers/README.md) · [`bsa/common`](src/modules/bsa/common/README.md) ·
[`bsa/classify`](src/modules/bsa/classify/README.md) · [`bsa/dti`](src/modules/bsa/dti/README.md) · [`packages/ocr`](../../packages/ocr/README.md)
