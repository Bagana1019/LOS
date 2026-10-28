# scoring: Prisma schema, migration, seed (BSA)

`scoring` сервис нэг PostgreSQL-ийн `scoring` schema-г ашиглана (schema-per-service; өөр schema руу FK хориотой). Энэ баримт нь
BSA (Bank Statement Analysis, модуль 10) хүснэгтүүд, migration/seed ажиллуулах заавар, `docs/03-data-model.md`-ээс ялгааг тайлбарлана.

Хадгалалтын давхарга (repository): `src/modules/bsa/common/persistence/README.md`.

## Хүснэгтүүд

Бүх хүснэгт `scoring` schema-д; нийтлэг баганууд: `id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `org_id`, `branch_id`.

| Хүснэгт | Зориулалт | Байгалийн түлхүүр (unique) |
| --- | --- | --- |
| `bsa_analysis` | Зээлдэгч бүрийн шинжилгээ (INT-7 хувилбартай) | `bsa_analysis_version_uq`: (org_id, application_id, customer_id, version) |
| `bsa_import_job` | Хуулгын нэг файлын импорт | `bsa_import_job_file_uq`: (analysis_id, sha256) |
| `bsa_transaction` | Хуулгын гүйлгээ | `bsa_transaction_dedupe_uq`: (analysis_id, dedupe_key) |
| `bsa_category` | Ангилал (admin засна, NFR-6) | `bsa_category_code_uq`: (org_id, code) |
| `bsa_rule` | Ангиллын дүрэм | `bsa_rule_natural_uq`: (org_id, direction, match_type, pattern, category_code, source) |
| `bsa_analysis_event` | Шинжилгээний өөрчлөлтийн түүх (append-only) | байхгүй |

`outbox`, `processed_events`, `calculation`, `sosco_*` болон `bsa_suspicion` нь Модуль 0-ийн baseline-д; энэ модуль тэдгээрийг ӨӨРЧИЛӨХГҮЙ.

Гадаад түлхүүр: `bsa_import_job`, `bsa_transaction`, `bsa_analysis_event` -> `bsa_analysis` (ON DELETE CASCADE);
`bsa_transaction.import_job_id` -> `bsa_import_job` (ON DELETE CASCADE). Тиймээс шинжилгээг устгахад (retention purge, NFR-5) хүүхэд мөрүүд
өөрөө устна. `application_id`, `customer_id`, `org_id`, `branch_id` нь бусад сервисийн id тул FK БИШ (string).

Индекс (нэрээр): `bsa_analysis_list_idx` (org, branch, status), `bsa_analysis_application_idx`, `bsa_analysis_register_idx`
(org, register_no_hash), `bsa_analysis_retention_idx` (org, created_at), `bsa_import_job_list_idx`, `bsa_import_job_analysis_idx`,
`bsa_transaction_date_idx` (analysis, txn_date), `bsa_transaction_category_idx`, `bsa_transaction_job_idx`, `bsa_rule_priority_idx`
(org, direction, priority), `bsa_analysis_event_history_idx` (analysis, at DESC).

### Баганын төрлийн дүрэм

- Мөнгө `numeric(18,2)`, хувь/жин `numeric(7,4)`, итгэлцэл (confidence) `numeric(5,2)` (0..100).
- Огноо `date` (`period_*`, `txn_date`), цаг хугацаа `timestamp(3)` (Модуль 0-ийн baseline-тай ижил).
- `status`, `direction`, `channel`, `dti_role`, `match_type`, `source`, `format` нь PostgreSQL enum БИШ `text`. Утгын цорын ганц эх сурвалж
  `@los/contracts`; repository хадгалахын өмнө zod-оор баталгаажуулна. Шалтгаан: enum нэмэх/өөрчлөхөд DDL migration хэрэгтэй болох,
  мөн contracts-оос хоёр дахь эх сурвалж үүсэхээс сэргийлэх.
- `*_encrypted` баганыг ЗӨВХӨН `PiiCipher` (repository дотор) бичиж уншина. Дансны дугаар, регистр, нэр, гүйлгээний утга DB-д ил хадгалагдахгүй.
- `statement_key`, `dedupe_key`, `register_no_hash` нь `PiiCipher.hash` (foundation-ий `blindIndex`, түлхүүртэй HMAC) утга; шууд дансны дугаар БИШ.

## docs/03-аас ялгаа (extras)

Модуль 0-ийн baseline `docs/03-data-model.md` «BSA (модуль 10)»-ийн дагуу бүх `bsa_*` хүснэгтийг үүсгэсэн. `20261028150000_bsa_statement_analysis` migration дараахыг НЭМСЭН/ӨӨРЧИЛСӨН:

| Нэмэлт / өөрчлөлт | Шалтгаан |
| --- | --- |
| `bsa_analysis.borrower_id` | INT-1: `BsaSummary.borrowerId` (LOS-ын borrower id) |
| `bsa_analysis.customer_snapshot_encrypted` | BSA-FR-1.1: овог/нэр, регистр, утас, зарласан данс (шифрлэгдсэн JSON) |
| `bsa_analysis.register_no_hash` | BSA-FR-1.2: регистрээр хайх, давхардал шалгах; регистр ил хадгалагдахгүй |
| `bsa_analysis.own_accounts_encrypted` | BSA-BR-5: өөрийн дансууд (шифрлэгдсэн JSON массив) |
| `bsa_import_job.file_name_encrypted` (docs-д `file_name` байхгүй) | Файлын нэр дансны дугаар/нэр агуулдаг тул шифрлэнэ |
| `bsa_import_job.iban_encrypted`, `holder_name_encrypted` (baseline-ийн ил `iban`, `holder_name` баганыг ХАССАН); `account_no_encrypted` аль хэдийн baseline-д | PII тул шифрлэгдсэн |
| `bsa_import_job.warnings_json`, `mime_type`, `size_bytes`, `sha256`, `attempts`, `started_at`, `finished_at` | Импортын ажлын төлөв, давхар файл илрүүлэх (sha256), дахин оролдлого |
| `bsa_transaction.description_encrypted`, `counterparty_name_encrypted` (baseline-ийн ил `description`, `counterparty_name`-ийг ХАССАН); `counterparty_account_encrypted` аль хэдийн baseline-д | PII тул шифрлэгдсэн |
| `bsa_transaction.seq`, `statement_key`, `dedupe_key` | Файл доторх дараалал; BSA-FR-2.4 давхцсан хуулгын мөрийг нэг л удаа хадгалах |
| `bsa_rule` unique `bsa_rule_natural_uq` | seed болон хэрэглэгчийн санал ижил дүрмийг давхар үүсгэхгүй (идемпотент) |
| `bsa_analysis_event` (шинэ хүснэгт) | NFR-4 аудит ба тойм дэлгэцийн «өөрчлөлтийн түүх» |
| `bsa_transaction.created_by/updated_by/branch_id`, `bsa_category|rule|import_job.branch_id`; `updated_at` DEFAULT; `channel`, `confidence` NOT NULL (DEFAULT `OTHER` / `0`) | Нийтлэг баганы дүрэм (docs/03 preamble), raw SQL-ээр бичихэд аюулгүй |
| CHECK constraint, DB-түвшний enum байхгүй | Дээрх «Баганын төрлийн дүрэм»-ийн шалтгаан; шалгалт repository дотор |

`bsa_suspicion` (baseline-д байгаа) нь энэ модульд ашиглагдахгүй — сэжигтэй гүйлгээний 8 дохио (M12c) бичнэ; `pendingSuspiciousCount` одоохондоо 0.

## Migration

Модуль 0-ийн зарчим (`docs/00-foundation.md` §5): baseline `20261028000000_init`-ийг ЗАСАХГҮЙ, зөвхөн шинэ migration нэмнэ.
Энэ модулийн migration: `migrations/20261028150000_bsa_statement_analysis/migration.sql` — `prisma migrate diff --from-schema-datamodel <baseline-ийн schema> --to-schema-datamodel prisma/schema.prisma --script`-ээр үүсгэсэн.
Baseline-ийн `bsa_import_job`, `bsa_transaction`, `bsa_analysis` хүснэгтэд энэ модулиас өмнө бичигдээгүй тул default-гүй NOT NULL багана нэмэх нь аюулгүй.

```bash
pnpm db:generate && pnpm db:migrate && pnpm db:seed          # эсвэл: pnpm --filter @los/scoring db:migrate
pnpm --filter @los/scoring db:migrate:dev --name <нэр>       # шинэ migration (baseline-ийг БҮҮ засаарай)
```

`DATABASE_URL` жишээ (docker-compose): `postgresql://los:los@localhost:5432/los` (`scripts/prisma.mjs` `?schema=scoring`-г автоматаар нэмнэ).

## Seed

```bash
pnpm --filter @los/scoring db:seed                     # = tsx prisma/seed.ts
SEED_ORG_ID=<uuid> pnpm --filter @los/scoring db:seed  # өөр байгууллагад
SEED_BSA_REFRESH=1 pnpm --filter @los/scoring db:seed  # анхдагч утга руу буцаах (доор)
```

- Каталог: `src/modules/bsa/classify/default-catalog.ts` (`DEFAULT_BSA_CATEGORIES` 23, `DEFAULT_BSA_RULES` 150). Модуль 0-ийн түр seed (INC_/EXP_ кодтой 21 ангилал, ~40 дүрэм)-ийг орлосон — доторх код нь `SALARY`, `LOAN_PAYMENT`… (`classify` нэгжийн кодууд). Sosco Score загвар v1 хэвээр.
- `SEED_ORG_ID` (анхдагч `SEED.org.id`, `@los/database`) байгууллага тутамд суулгана.
- Идемпотент: хоёр дахь ажиллуулалт юу ч өөрчлөхгүй. Анхдагчаар зөвхөн ДУТУУ мөрийг нэмнэ, байгааг ӨӨРЧИЛЖ ДАРАХГҮЙ (admin засварласан
  дайчлах хувь, босгыг хамгаална). Ангиллын түлхүүр (org, code); дүрмийн түлхүүр (org, direction, match_type, pattern, category_code, source).
- `SEED_BSA_REFRESH=1`: ялгаатай мөрийг анхдагч утга руу буцаана (ангилалын талбарууд; дүрмийн `priority`, `is_active`).
- Бүгд нэг транзакцид; хэвлэх мэдээлэл зөвхөн тоо (PII байхгүй).
- Каталогийн загварын шалгалт: `default-catalog.persistence.test.ts` (schema хүчинтэй, дүрэм-ангиллын чиглэл таарна, байгалийн түлхүүр давтагдахгүй).

## Тест (PostgreSQL-тэй)

Репозиторийн гэрээний тест нь in-memory хэрэгжүүлэлт дээр үргэлж, Prisma хэрэгжүүлэлт дээр `TEST_DATABASE_URL` өгөгдсөн үед л ажиллана.
vitest globalSetup (`test/global-setup.ts`, Модуль 0) `scoring` schema-г шинээр үүсгэж baseline + энэ migration + seed-ийг хэрэглэдэг тул урьдчилан юу ч хийх шаардлагагүй.

```bash
createdb los_scoring_test       # нэр `test`-ээр төгснө: тест бүрийн өмнө TRUNCATE, globalSetup schema-г DROP хийдэг
cd apps/scoring
TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_scoring_test REDIS_URL_TEST=redis://localhost:6379/3 pnpm exec vitest run
```

`TEST_DATABASE_URL`-гүй үед Prisma-ийн тестүүд алгасагдана (in-memory болон бусад тест ажиллана).

Эрэмбийг DB-ийн collation-аас хамааруулаагүй (SQL зөвхөн огноо, тоо, uuid, цагийн мөрөөр эрэмбэлнэ; кодын мөр JS-д эрэмбэлэгдэнэ), тиймээс
C болон ICU en-US collation-тай баазад ижил үр дүн гарна.
