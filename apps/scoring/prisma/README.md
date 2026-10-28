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

`outbox` хүснэгтийг энэ migration ӨӨРЧИЛӨХГҮЙ (доорх «Migration» хэсгийн анхааруулгыг хар).

Гадаад түлхүүр: `bsa_import_job`, `bsa_transaction`, `bsa_analysis_event` -> `bsa_analysis` (ON DELETE CASCADE);
`bsa_transaction.import_job_id` -> `bsa_import_job` (ON DELETE CASCADE). Тиймээс шинжилгээг устгахад (retention purge, NFR-5) хүүхэд мөрүүд
өөрөө устна. `application_id`, `customer_id`, `org_id`, `branch_id` нь бусад сервисийн id тул FK БИШ (string).

Индекс (нэрээр): `bsa_analysis_list_idx` (org, branch, status), `bsa_analysis_application_idx`, `bsa_analysis_register_idx`
(org, register_no_hash), `bsa_analysis_retention_idx` (org, created_at), `bsa_import_job_list_idx`, `bsa_import_job_analysis_idx`,
`bsa_transaction_date_idx` (analysis, txn_date), `bsa_transaction_category_idx`, `bsa_transaction_job_idx`, `bsa_rule_priority_idx`
(org, direction, priority), `bsa_analysis_event_history_idx` (analysis, at DESC).

### Баганын төрлийн дүрэм

- Мөнгө `numeric(18,2)`, хувь/жин `numeric(7,4)`, итгэлцэл (confidence) `numeric(5,2)` (0..100).
- Огноо `date` (`period_*`, `txn_date`), цаг хугацаа `timestamptz(3)`.
- `status`, `direction`, `channel`, `dti_role`, `match_type`, `source`, `format` нь PostgreSQL enum БИШ `text`. Утгын цорын ганц эх сурвалж
  `@los/contracts`; repository хадгалахын өмнө zod-оор баталгаажуулна. Шалтгаан: enum нэмэх/өөрчлөхөд DDL migration хэрэгтэй болох,
  мөн contracts-оос хоёр дахь эх сурвалж үүсэхээс сэргийлэх.
- `*_encrypted` баганыг ЗӨВХӨН `PiiCipher` (repository дотор) бичиж уншина. Дансны дугаар, регистр, нэр, гүйлгээний утга DB-д ил хадгалагдахгүй.
- `statement_key`, `dedupe_key`, `register_no_hash` нь `PiiCipher.hash` (түлхүүртэй hash) утга; шууд дансны дугаар БИШ.

## docs/03-аас ялгаа (extras)

`docs/03-data-model.md` «BSA (модуль 10)» хэсгийн дагуу хийж, дараахыг НЭМСЭН/ӨӨРЧИЛСӨН:

| Нэмэлт / өөрчлөлт | Шалтгаан |
| --- | --- |
| `bsa_analysis.borrower_id` | INT-1: `BsaSummary.borrowerId` (LOS-ын borrower id) |
| `bsa_analysis.customer_snapshot_encrypted` | BSA-FR-1.1: овог/нэр, регистр, утас, зарласан данс (шифрлэгдсэн JSON) |
| `bsa_analysis.register_no_hash` | BSA-FR-1.2: регистрээр хайх, давхардал шалгах; регистр ил хадгалагдахгүй |
| `bsa_analysis.own_accounts_encrypted` | BSA-BR-5: өөрийн дансууд (шифрлэгдсэн JSON массив) |
| `bsa_import_job.file_name_encrypted` (docs-д `file_name` байхгүй) | Файлын нэр дансны дугаар/нэр агуулдаг тул шифрлэнэ |
| `bsa_import_job.account_no_encrypted`, `iban_encrypted`, `holder_name_encrypted` | docs-д `account_no`, `iban`, `holder_name`; PII тул шифрлэгдсэн |
| `bsa_import_job.warnings_json`, `mime_type`, `size_bytes`, `sha256`, `attempts`, `started_at`, `finished_at` | Импортын ажлын төлөв, давхар файл илрүүлэх (sha256), дахин оролдлого |
| `bsa_transaction.description_encrypted`, `counterparty_account_encrypted`, `counterparty_name_encrypted` | docs-д `description`, `counterparty_*`; PII тул шифрлэгдсэн |
| `bsa_transaction.seq`, `statement_key`, `dedupe_key` | Файл доторх дараалал; BSA-FR-2.4 давхцсан хуулгын мөрийг нэг л удаа хадгалах |
| `bsa_rule` unique `bsa_rule_natural_uq` | seed болон хэрэглэгчийн санал ижил дүрмийг давхар үүсгэхгүй (идемпотент) |
| `bsa_analysis_event` (шинэ хүснэгт) | NFR-4 аудит ба тойм дэлгэцийн «өөрчлөлтийн түүх» |
| `id` нь `text` (uuid утгатай, `@default(uuid())`), `timestamptz(3)` | Репозиторийн бусад хүснэгттэй (outbox-ийн Prisma загвар) нэг хэв маяг; цагийн бүс алдахгүй |
| CHECK constraint, DB-түвшний enum байхгүй | Дээрх «Баганын төрлийн дүрэм»-ийн шалтгаан; шалгалт repository дотор |

Хийгээгүй (энэ unit-ийн хүрээнд биш): `bsa_suspicion` (docs/03). Энийг сэжигтэй гүйлгээний unit нэмнэ.

## Migration

Хувилбар: `migrations/20261028113329_bsa_init/migration.sql`. Энэ нь `prisma migrate diff`-ээр баазын загвараас (generator, datasource,
Outbox) одоогийн `schema.prisma` хүртэл үүсгэсэн DDL; `outbox`-г ДАХИН ҮҮСГЭХГҮЙ, учир нь
`packages/database/init/00-schemas.sql` (docker-compose-ийн init) үүнийг аль хэдийн үүсгэдэг. Эхний мөр нь `CREATE SCHEMA IF NOT EXISTS "scoring"`
(цэвэр PostgreSQL, shadow DB дээр schema байхгүй байж болох тул); init script-тэй орчинд юу ч хийхгүй.

`DATABASE_URL` жишээ (docker-compose): `postgresql://los:los@localhost:5432/los`.

### Анхааруулга: init script-ийн outbox ба Prisma Migrate

`00-schemas.sql` нь `scoring.outbox`-г өөрөө үүсгэдэг (`id uuid`, `timestamptz`) бөгөөд энэ нь Prisma-ийн `Outbox` загвартай (`text`,
`timestamp(3)`) яг таарахгүй. Иймд `scoring` schema хоосон биш бааз дээр:

- `prisma migrate deploy` нь P3005 (бааз хоосон биш, baseline шаардлагатай) өгч болно.
- `prisma migrate dev` нь shadow DB дээр schema байхгүйгээс эхэлж, дараа нь drift мэдээлнэ.

Шинэ орчинд ажиллуулах (баталгаажсан дараалал):

```bash
# 1) Init script (schema + outbox). docker-compose үүнийг автоматаар ажиллуулна; гараар:
psql "$DATABASE_URL" -f packages/database/init/00-schemas.sql

# 2) Migration-ийг baseline болгож хэрэглэх (outbox аль хэдийн байгаа тул migrate deploy-ийн оронд)
cd apps/scoring
npx prisma db execute --file prisma/migrations/20261028113329_bsa_init/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20261028113329_bsa_init --schema prisma/schema.prisma

# 3) Клиент үүсгэх
npx prisma generate --schema prisma/schema.prisma
```

Init script-гүй цэвэр баазад (outbox байхгүй) `prisma migrate deploy` шууд ажиллана, гэхдээ тэр үед `outbox`-г энэ migration үүсгэхгүй тул
`00-schemas.sql`-г заавал эхэлж ажиллуул. `_prisma_migrations` хүснэгт `public` schema-д үүснэ.

Баталгаажуулсан: `00-schemas.sql` -> migration нь цэвэр PostgreSQL 16 дээр алдаагүй; `migrate diff --from-url` нь зөвхөн дээрх outbox-ийн
төрлийн зөрүүг үзүүлнэ (BSA хүснэгтэд зөрүү байхгүй).

Шинэ migration нэмэх: `schema.prisma`-г өөрчлөөд `prisma migrate diff --from-schema-datamodel <өмнөх> --to-schema-datamodel prisma/schema.prisma --script`
гаралтыг шинэ хавтсанд хадгал (`migrate dev` нь дээрх drift-ийн улмаас init script-тэй орчинд найдвартай биш).

## Seed

```bash
cd apps/scoring
pnpm db:seed                     # = tsx prisma/seed.ts
SEED_ORG_ID=org-123 pnpm db:seed # өөр байгууллагад
SEED_BSA_REFRESH=1 pnpm db:seed  # анхдагч утга руу буцаах (доор)
```

- Эх сурвалж: `src/modules/bsa/classify/default-catalog.ts` (`DEFAULT_BSA_CATEGORIES`, `DEFAULT_BSA_RULES`).
- `SEED_ORG_ID` (анхдагч `org-default`) байгууллага тутамд суулгана.
- Идемпотент: хоёр дахь ажиллуулалт юу ч өөрчлөхгүй. Анхдагчаар зөвхөн ДУТУУ мөрийг нэмнэ, байгааг ӨӨРЧИЛЖ ДАРАХГҮЙ (admin засварласан
  дайчлах хувь, босгыг хамгаална). Ангиллын түлхүүр (org, code); дүрмийн түлхүүр (org, direction, match_type, pattern, category_code, source).
- `SEED_BSA_REFRESH=1`: ялгаатай мөрийг анхдагч утга руу буцаана (ангилалын талбарууд; дүрмийн `priority`, `is_active`).
- Бүгд нэг транзакцид; хэвлэх мэдээлэл зөвхөн тоо (PII байхгүй).
- Seed-ийн орчин: `DATABASE_URL`. Эхлээд migration хэрэглэсэн байх ёстой.
- Каталогийн загварын шалгалт: `default-catalog.persistence.test.ts` (schema хүчинтэй, дүрэм-ангиллын чиглэл таарна, байгалийн түлхүүр давтагдахгүй).

## Тест (PostgreSQL-тэй)

Репозиторийн гэрээний тест нь in-memory хэрэгжүүлэлт дээр үргэлж, Prisma хэрэгжүүлэлт дээр `TEST_DATABASE_URL` өгөгдсөн үед л ажиллана.

```bash
# Туршилтын бааз (нэрэнд "test" заавал орно: тест бүрийн өмнө TRUNCATE хийдэг тул үйлдвэрлэлийн баазыг хамгаална)
createdb los_bsa_test
psql postgresql://localhost/los_bsa_test -f packages/database/init/00-schemas.sql
psql postgresql://localhost/los_bsa_test -f apps/scoring/prisma/migrations/20261028113329_bsa_init/migration.sql

cd apps/scoring
TEST_DATABASE_URL=postgresql://localhost/los_bsa_test npx vitest run src/modules/bsa/common/persistence
```

`TEST_DATABASE_URL`-гүй үед Prisma-ийн тестүүд алгасагдана (in-memory болон бусад тест ажиллана). Схем урьдчилан хэрэглэгдсэн байх ёстой: тест
migration ажиллуулахгүй.

Эрэмбийг DB-ийн collation-аас хамааруулаагүй (SQL зөвхөн огноо, тоо, uuid, цагийн мөрөөр эрэмбэлнэ; кодын мөр JS-д эрэмбэлэгдэнэ), тиймээс
C болон ICU en-US collation-тай баазад ижил үр дүн гарна.
