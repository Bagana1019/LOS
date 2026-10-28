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
pnpm exec turbo run build --filter=@los/scoring            # @los/contracts, calc, ocr, database, scoring
# Schema + migration: prisma/README.md «Migration» (init script + baseline; `migrate deploy` шууд ажиллахгүй байж болно)
psql "$DATABASE_URL" -f packages/database/init/00-schemas.sql
cd apps/scoring
npx prisma db execute --file prisma/migrations/20261028113329_bsa_init/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20261028113329_bsa_init --schema prisma/schema.prisma
DATABASE_URL=postgresql://…/los npx tsx prisma/seed.ts      # ангилал (23) + дүрэм (150), идемпотент
DATABASE_URL=… REDIS_URL=redis://… PII_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  MINIO_ENDPOINT=localhost:9000 INTEGRATION_MODE=real node dist/main.js
curl localhost:4003/api/health
```

- `PII_ENCRYPTION_KEY` (base64, 32 байт) **заавал**; түлхүүр алдвал өгөгдөл сэргээгдэхгүй.
- `MINIO_ENDPOINT` байхгүй бол **in-memory** файлын сан (дахин асахад алдагдана; зөвхөн dev), `REDIS_URL` байхгүй бол процесс доторх дараалал (зөвхөн dev).
  `NODE_ENV=production` үед эдгээр заавал.
- Асахад тохиргооны алдаа (буруу env, түлхүүр, Redis) нэртэй мессежтэй `exit 1`. SIGTERM дээр явж буй импорт ажлыг дуусгаж, цэвэрхэн унтарна.

### Орчны хувьсагч (товч; бүрэн хүснэгт `docs/05-bsa-ocr.md` §5)

| Бүлэг | Хувьсагч |
| --- | --- |
| Үндсэн | `DATABASE_URL`, `SCORING_PORT` (4003), `DEFAULT_ORG_ID` (`org-default`) |
| PII | `PII_ENCRYPTION_KEY`, `PII_ENCRYPTION_KEY_PREVIOUS` |
| Файл | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` (эсвэл `MINIO_ROOT_USER`/`_PASSWORD`), `MINIO_USE_SSL`, `MINIO_REGION`, `BSA_BUCKET`, `BSA_OBJECT_MAX_BYTES` |
| Дараалал | `REDIS_URL`, `BSA_IMPORT_QUEUE`, `BSA_IMPORT_ATTEMPTS`, `BSA_IMPORT_BACKOFF_MS`, `BSA_IMPORT_CONCURRENCY` |
| OCR | `INTEGRATION_MODE` (`mock`\|`real`), `OCR_ENGINE`, `OCR_LANGUAGES`, `OCR_PSM`, `OCR_DPI`, `OCR_TIMEOUT_MS`, `OCR_MAX_PAGES`, `OCR_MAX_INPUT_BYTES`, `TESSERACT_BIN`, `PDFTOPPM_BIN` |
| Import | `BSA_IMPORT_MAX_ROWS`, `BSA_IMPORT_EXTRACT_TIMEOUT_MS`, `BSA_IMPORT_JOB_TIMEOUT_MS`, `BSA_IMPORT_CHUNK_ROWS` |
| Retention | `BSA_RETENTION_BATCH`, `BSA_RETENTION_INTERVAL_MS` (0 = таймергүй) |
| Бизнес босго | `BSA_COST_OF_GOODS_RATE`, `BSA_MAX_DTI`, `BSA_DTI_LOW_MAX`, `BSA_DTI_MEDIUM_MAX`, `BSA_OTHER_SHARE_THRESHOLD`, `BSA_ALLOWED_PERIOD_MONTHS`, `BSA_MIN_STATEMENT_MONTHS`, `BSA_RETENTION_YEARS`, `BSA_BALANCE_TOLERANCE`, `BSA_PUSH_POLICY`, `BSA_MAX_UPLOAD_BYTES`, `BSA_MAX_FILES_PER_UPLOAD`, `BSA_*_INCOME_CODES`, `BSA_RELIABILITY_WEIGHT_*`, `BSA_SETTINGS_CACHE_TTL_MS` |

## Gateway-ээс ирэх толгой (CLAUDE.md §3.2(9))

Authorization, rate limit gateway-д. Энэ сервис gateway-ийн ард, толгойг итгэж ашиглана (**сүлжээнд шууд ил гаргахгүй**):
`X-User-Id` (заавал, байхгүй -> 401), `X-Roles` (таслалаар: `OFFICER`, `BRANCH_MANAGER`, `APPROVER`, `ADMIN`; буруу -> 403), `X-Org-Id`,
`X-Branch-Id`, `X-Correlation-Id`. Хариу бүрт `X-Correlation-Id` буцна. Gateway-ийн proxy маршрут энэ PR-д ороогүй.

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

Алдааны нэгдсэн хэлбэр: `{statusCode, errorCode, message (монгол), details?, issues?[{path, code}], correlationId}`.

## Нууцлал (NFR-3)

- PII (тайлбар, харьцсан нэр/данс, файлын нэр, данс/IBAN/эзэмшигч, харилцагчийн snapshot) DB-д `v1:` AES-GCM-ээр шифрлэгдсэн; хайлтын hash нь түлхүүртэй HMAC.
  Файл object store-д шифрлэгдэж очно.
- Лог, алдаа, анхааруулга, event, түүхэнд PII (нэр, регистр, данс, тайлбар, OCR текст) ОРОХГҮЙ.
- `GET /api/bsa/analyses?registerNo=` регистр URL-д орно: gateway query string-ийг логлохгүй байх ёстой.
- Хадгалах хугацаа (`BSA_RETENTION_YEARS`, анхдагч 3): `POST /api/bsa/admin/retention/run` эсвэл `BSA_RETENTION_INTERVAL_MS` таймер.

## Тест

```bash
cd apps/scoring
npx vitest run                                   # бүх unit + in-memory e2e (интеграцийн тест skip)
npx vitest run src/modules/bsa/import/e2e        # HTTP e2e (supertest, ЖИНХЭНЭ BsaModule)
npx eslint src
# Бодит Postgres + Redis (DB-ийн нэрэнд `test` байх ёстой; TRUNCATE хийнэ). Файл зэрэгцээ ажиллуулахгүй:
TEST_DATABASE_URL=postgresql://…/los_scoring_test REDIS_URL_TEST=redis://… PII_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  npx vitest run --no-file-parallelism src/modules/bsa
```

Vitest нь `@los/*` багцыг эх кодоор нь уншина; Nest runtime/`tsc` нь тэдгээрийн `dist`-ийг уншдаг тул `@los/contracts` өөрчлөгдвөл
`pnpm exec turbo run build --filter=@los/scoring` (эсвэл `pnpm --filter @los/contracts build`) ажиллуулна.

## Холбоотой баримт

[`docs/05-bsa-ocr.md`](../../docs/05-bsa-ocr.md) · [`docs/02-bsa-requirements.md`](../../docs/02-bsa-requirements.md) · [`prisma/README.md`](prisma/README.md) ·
[`bsa/import`](src/modules/bsa/import/README.md) · [`bsa/parsers`](src/modules/bsa/parsers/README.md) · [`bsa/common`](src/modules/bsa/common/README.md) ·
[`bsa/classify`](src/modules/bsa/classify/README.md) · [`bsa/dti`](src/modules/bsa/dti/README.md) · [`packages/ocr`](../../packages/ocr/README.md)
