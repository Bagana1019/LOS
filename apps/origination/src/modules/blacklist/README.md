# blacklist

Дотоод хар жагсаалт: найдваргүй зээлдэгчийн CRUD ба импорт. Эзэмшигч нь `origination` (`origination.blacklist`); `kyc` нь `BlacklistEntryChanged` event-ээр өөрийн `blacklist_projection`-ийг хөтөлж, харилцагчийг регистрээр тулгана (`docs/05-compliance-aml.md`).

Шаардлага: **FR-13.1** (хар жагсаалт CRUD, импорт), **BR-9** (бүх шалтгаанд зөвхөн анхааруулга, хориг байхгүй — энэ модуль зээлийг хаахгүй; kyc `WARNING` hit гаргаж батлагч шийднэ). **FR-13.5** (аудит) дутуу — доорх "Хязгаарлалт".

## Endpoint (`/api` угтвар)

Хүсэлт эхлээд глобал `ContextAuthGuard` (nest-common)-ыг давна, дараа нь модулийн `BlacklistAccessGuard`-ыг. Толгой (CLAUDE.md §3.2.9): `X-User-Id` **заавал** (үгүй бол 401), `X-Roles` (таслалаар; үл мэдэгдэх дүрийг тооцохгүй), `X-Branch-Id`, `X-Correlation-Id` (үгүй бол uuid үүсгэнэ), `X-Org-Id` (үгүй бол `DEFAULT_ORG_ID`; аль нь ч үгүй бол бүтэн аппад глобал guard 401 `MISSING_ORG`, модулийн guard-ийн 400 нь глобал guard-гүй тестэд ба CSV middleware-д л). `INTERNAL_AUTH_SECRET` тохируулсан бол `X-Internal-Token` заавал (үгүй/буруу бол 401 `INVALID_INTERNAL_TOKEN`; CSV импортын тухай доор).

| Метод, зам | Дүр | Хариу |
| --- | --- | --- |
| `GET /blacklist?q=&listType=&isActive=&limit=&offset=` | `X-User-Id`-тэй ДУРЫН дуудагч | `{ total, items: BlacklistEntry[] }`, `registeredAt` буурахаар (тэнцвэл `id` өсөхөөр). `limit` 1–100 (анхдагч 20), `offset` 0–1 000 000 (түүнээс их бол 400). `q` (≤ 200) = нэрийн хэсэг (том/жижиг үсэг ялгахгүй, `%` `_` шууд утгаараа) **эсвэл** регистр (HMAC hash-аар, яг тохирол). `listType` том үсэг болгож шүүнэ |
| `GET /blacklist/:id` | `X-User-Id`-тэй ДУРЫН дуудагч | `BlacklistEntry`; олдохгүй эсвэл өөр org-ийнх бол 404 |
| `POST /blacklist` | зөвхөн ADMIN | 201. Идэвхтэй давхардал (org + регистр + `listType`) → 409; идэвхгүй мөр байвал шинэ өгөгдлөөр **дахин идэвхжүүлж** 201 |
| `PATCH /blacklist/:id` | зөвхөн ADMIN | Хэсэгчилсэн засвар (`isActive` орно). `reasonText`-д `null` эсвэл `''` өгвөл тайлбарыг арилгана (GET-ийн хариуг шууд буцаан PATCH хийж болно). Регистр/`listType` өөрчлөхөд өөр мөртэй давхцвал (идэвхгүй ч) 409. Өөрчлөлтгүй бол event гаргахгүй. Идэвхгүй мөрийг `isActive=true` болговол дахин бүртгэгдсэн гэж үзнэ (`registeredBy/At`, `branchId` шинэчлэгдэнэ) |
| `DELETE /blacklist/:id` | зөвхөн ADMIN | Устгахгүй, `isActive=false` болгоно (идэмпотент), 200 |
| `POST /blacklist/import` | зөвхөн ADMIN | `BlacklistImportResult`, 200; `text/csv` (≤ 5 MB) эсвэл JSON `{ rows: [...] }`; дээд 5000 мөр (хэтэрвэл 413). "CSV импорт" хэсгийг үз |

**Бичих эрх.** `WRITE_ROLES = ['ADMIN']` — `@los/contracts` `ROLE_PERMISSIONS`-ийн `blacklist:manage` зөвхөн ADMIN-д байгаа ба gateway-н `route-policy.ts` (`/api/origination/blacklist`, `writeOnly`) мөн `blacklist:manage` шаарддаг тул хоёр давхарга нийцнэ. `BRANCH_MANAGER`, `OFFICER`, `APPROVER` бичиж чадахгүй (403). Модуль `@Permissions` биш дүрийн нэрээр (`@Roles`) шалгадаг.

Бүх оролт `@los/contracts`-ийн zod схемээр шалгагдана. Модуль `ZodPipe` алдааг 400 `{ statusCode: 400, message: 'Validation failed', issues: [{ code, path, message, … }] }` (stack-гүй, хүлээн авсан утгагүй) гэж үүсгэдэг. **Бүтэн аппад** глобал `AllExceptionsFilter` бүх алдааг `{ code, message, details?, correlationId }` болгодог бөгөөд `issues`-ийг дамжуулдаггүй — клиент зөвхөн `{ code: 'BAD_REQUEST', message: 'Validation failed', correlationId }` авна; `issues` нь модулийг filter-гүйгээр суулгасан тестэд (`blacklist.controller.test.ts`) л харагдана (`docs/05` §10).

**Хориотой тэмдэгт.** Body (JSON), query, `:id`-д U+0000 (NUL), U+FFFD (буруу кодчилсон текстийн солих тэмдэг), дан surrogate (lone) байвал 400 (500 биш; мессеж утгыг echo хийхгүй, түлхүүр дэх тэмдэгтийг `(in an object key)` гэж заана): `NUL (U+0000) characters are not allowed`, `U+FFFD replacement characters are not allowed (the text was not valid UTF-8)`, `invalid Unicode (lone surrogate) is not allowed`.

**Регистрийн шалгалт (POST, PATCH, импортын мөр бүр).** Түүхий утга ≤ 32 (contracts); нормчлогч чимээгүй хаядаг тусгаарлагч (зай, зураас, `_ . / ,`) ба үл үзэгдэх `\p{Cf}`-ээс бусад тэмдэгт зөвхөн үсэг/цифр/mark байх (`hasOnlyRegisterChars`, NFKC-ийн дараа; `?`, `*`, `(`, U+FFFD зэрэг бол `registerNo contains unsupported characters`); нормчилсны дараа дор хаяж 1 үсэг/цифр (`registerNo must contain letters or digits`). Эс бөгөөс hash-ээс тэмдэгт алга болж kyc-д хэзээ ч таарахгүй хуурамч "цэвэр" үүснэ.

**Зэрэг засвар (409).** `PATCH`, `DELETE`, `POST` (дахин идэвхжүүлэх) ба импортын мөр нь мөрийг уншсанаас хойш өөр хүсэлт өөрчилсөн бол `409 Blacklist entry was modified concurrently, retry`. Бичилт нь уншсан мөрийн `updatedAt` дээрх compare-and-set (`UPDATE … WHERE id AND updated_at = уншсан утга`); клиент дахин уншаад давтана. Мөр ба outbox event хоёул бичигдэхгүй. Идэвхтэй давхардлын 409 (`An entry with the same register number and list type already exists`) өөр.

**Унших эрх.** Хариунд тайлсан `registerNo` (нормчилсон хэлбэрээр) орно. `GET` нь `X-User-Id`-тэй ДУРЫН дуудагчид нээлттэй — `X-Roles` хоосон, үл мэдэгдэх ч. Gateway-н route-policy зөвхөн бичих (`writeOnly`) үйлдлийг шалгадаг тул `blacklist:read` одоогоор хаана ч шалгагддаггүй (4 дүрд бүгдэд нь байдаг тул практик ялгаа алга). Лог, event, алдааны мессежид регистр хэзээ ч бичигдэхгүй; хариунд `registerNoHash`, шифртэй текст орохгүй.

## CSV импорт

Header мөр заавал: `registerNo,customerType,name,listType,reasonCode,reasonText` (`listType`, `reasonText` багана заавал биш; баганын нэр том/жижиг үсэг ялгахгүй; үл мэдэгдэх/давхардсан/дутуу багана → 400). UTF-8 BOM, CRLF, `"..."` талбар (таслал, `""` хашилт, мөр таслалт), `,` эсвэл `;` (header-ээс автоматаар), хоосон мөр — зөвшөөрнө. Мөр бүр `(org, регистр hash, listType)`-ээр upsert: шинэ → `created`; өөр өгөгдөл эсвэл идэвхгүй байсан → `updated` (дахин идэвхжинэ); ижил ба идэвхтэй → `skipped`. Алдаатай мөр `errors: [{ row, message }]` (`row` = header, хоосон мөрийг тоолохгүй 1-ээс эхэлсэн өгөгдлийн мөр; JSON-д `rows`-ийн дугаар) болж, бусдыг зогсоохгүй.

**Дарааллаар шалгана (`text/csv`).** `csv-body.middleware.ts` нь глобал guard-аас ӨМНӨ ажилладаг тул body-г уншихаас ӨМНӨ эрхийг өөрөө шалгана (`authorize`): 401 (`X-User-Id` үгүй) → 400 (`X-Org-Id`, `DEFAULT_ORG_ID` хоёул үгүй) → 403 (дүр ADMIN биш) → 413 (`Content-Length` > 5 MB = 5 242 880 байт). Ингэснээр эрхгүй эсвэл хэт том upload 413 биш 401/403 авна. Эдгээр хүсэлт `Connection: close`-той татгалзагдаж, сервер уншаагүй body-г drain хийхгүй — upload хийж буй клиент статус авахын оронд connection reset харж болно. Дараа нь body-г уншина: `Content-Length`-гүй (chunked) бол cap-аас хэтэрсэн эхний chunk дээр зогсож 413. Middleware-ийн шалгалт зөвхөн `X-User-Id`/`X-Org-Id`/дүр тул **`X-Internal-Token` (глобал guard) body (≤ 5 MB) уншигдсаны дараа л шалгагдана** (`INTERNAL_AUTH_SECRET` тохируулсан ч) — gateway-г тойрсон дотоод дуудагч л үүнийг ашиглана. Дараа нь **хатуу UTF-8** (UTF-8 BOM зөвшөөрнө): Windows-1251, UTF-16 зэрэг бусад кодчилол, мөн U+FFFD агуулсан текст **бүхэлдээ** 400 `CSV body must be valid UTF-8 (save the file as "CSV UTF-8" …)` — юу ч импортлогдохгүй (мөрийн алдаа биш). CSV текстэд U+0000 (UTF-16 файлын ердийн шинж) эсвэл дан surrogate байвал мөн 400 (`… (the file must be UTF-8 text)`). Header/бүтцийн алдаа (хаагдаагүй хашилт, header үгүй) 400.

**Мөрийн хязгаар.** Өгөгдлийн мөр ≤ **5000** (`MAX_IMPORT_ROWS`): задлах явцад 5001 дэх хоосон биш өгөгдлийн мөр харагдмагц 413 (`At most 5000 rows per import`) — header, хоосон мөр, бүх талбар хоосон мөрийг тоолохгүй, сая сая мөрийг санах ойд үүсгэхгүй. JSON-ийн `rows` > 5000 бол мөн 413.

**Нэг синхрон хүсэлт, атомик биш.** 5000 мөртэй импорт нь НЭГ HTTP хүсэлт; мөр бүр тусдаа транзакц тул файл бүхэлдээ атомик биш (дундаас зогсвол өмнөх мөрүүд commit-лэгдсэн хэвээр), харин дахин ачаалахад өөрчлөгдөөгүй мөр `skipped` болно. Мөр бүрийн алдаа бусдыг зогсоохгүй:

- шалгалтын алдаа — `errors[]`-д zod мессежтэй;
- зэрэг засварт ялагдсан мөр — `Blacklist entry was modified concurrently, retry`; давхардал — `An entry with the same register number and list type already exists`;
- DB/repository/шифр/hash-ийн гэнэтийн алдаа (жнь `DATA_INDEX_KEY` байхгүй) — `{ row, message: 'Row could not be saved (internal error)' }` (утга хариу-д орохгүй; ERROR түвшинд `blacklist import row N failed: … (correlationId=…)` лог), үлдсэн мөрүүд үргэлжилнэ, HTTP **200**. DB бүрэн унасан эсвэл түлхүүр буруу үед `created = updated = skipped = 0`, бүх мөр `errors[]`-д орсон 200 ирнэ — статус код л шалгадаг скрипт үүнийг амжилттай импорт гэж андуурч болно. Харин нэг бичлэгийн endpoint (POST/PATCH/DELETE/GET) дээр ижил алдаа 500 (`INTERNAL`).

**Дахин идэвхжүүлэлт ба тайлбар.** Хуучин CSV-г дахин импортлоход идэвхгүй болгосон мөрүүд **дахин идэвхжинэ** (импортолсон хэрэглэгч, цаг, салбараар шинээр бүртгэгдэнэ). Мөр бүрийн `customerType`, `name`, `reasonCode`, `reasonText` бүхлээр солигдох тул `reasonText`-гүй мөр одоо байгаа тайлбарыг арилгана (`updated`). JSON импортод NUL, U+FFFD, дан surrogate байвал бүх body 400 (хэсэгчлэн импортлохгүй).

## Event

`BlacklistEntryChanged` (`@los/contracts/events.ts`) — үүсгэх, засах, идэвхгүй болгох, импортын мөр бүрт нэг ширхэг (өөрчлөлтгүй PATCH/`skipped`/идэвхгүй мөрийн DELETE-д гарахгүй): `entryId`, `registerNoHash`, `customerType`, `name`, `listType`, `reasonCode`, `isActive`, `changedAt` + суурь талбарууд (`eventId`, `occurredAt`, `version: 1`, `orgId`, `actorId`, `correlationId`). Мөр ба outbox мөр **нэг транзакцид** (`saveWithEvent`, CLAUDE.md §3.2.4); event-д plain регистр, `reasonText`, өмнөх төлөв байхгүй. Outbox-ийг nest-common `EventsModule` (`schema: 'origination'`) relay Redis Stream `los:events` руу гаргана; `REDIS_URL` байхгүй эсвэл `OUTBOX_RELAY=off` бол нийтлэгдэхгүй. Repository outbox мөрийг `enqueueOutbox(tx, event)`-ээр бичнэ (`DomainEvent.parse` нь бичихээс өмнө, мөн relay-д).

- `registerNoHash` нь `/^[0-9a-f]{64}$/` (HMAC-SHA256 hex) — schema үүнийг шалгана, plain регистр няцна. Producer болон fixture бүр `hashRegisterNo`-ийн жинхэнэ утга ашиглана.
- `changedAt` нь мөрийн `updatedAt`-тай тэнцүү бөгөөд нэг мөрөнд **хатуу өснө**: `max(clock.now(), өмнөх updatedAt + 1мс)` — цаг ухарсан эсвэл нэг миллисекундэд хоёр засвар орсон ч дараалал алдагдахгүй. kyc зөвхөн `changedAt` хатуу шинэ event-ийг хэрэглэнэ (тэнцүү нь `STALE`). `occurredAt` бодит цаг хэвээр тул цагийн зөрүүд `changedAt`-аас өмнө байж болно.

## Өгөгдөл

`origination.blacklist` (`prisma/schema.prisma`, `model Blacklist`). docs/03-ийн `register_no`-г `register_no_encrypted` (AES-256-GCM, aad `blacklist.register_no`, CLAUDE.md §6.5) + `register_no_hash` (`hashRegisterNo` = `blindIndex(normalizeRegisterNo(x))` = HMAC-SHA256, `DATA_INDEX_KEY`) болгосон; давхардал `unique(org_id, register_no_hash, list_type) WHERE is_active` (partial: идэвхтэй мөр ганц, идэвхгүй түүхэн мөр олон байж болно — Модуль 1/6-ийн тестүүд ч ингэж бичдэг; Prisma partial index-ийг илэрхийлж чадахгүй тул schema.prisma-д `@@unique` гэж тэмдэглэсэн, introspection-д WHERE харагдахгүй). Регистрийг нормчилсон хэлбэрээр (`normalizeRegisterNo`) хадгална. Нэрээр тулгахгүй — зөвхөн регистрээр (нийтлэг нэрээр хуурамч тохирол их).

Migration: baseline `20261028000000_init`-д `register_no_encrypted`, `register_no_hash`, `index(org_id, register_no_hash)` байсан; `20261029050000_blacklist_aml` нь `branch_id` багана, `unique(org_id, register_no_hash, list_type) WHERE is_active` (partial: идэвхтэй мөр ганц, идэвхгүй түүхэн мөр олон байж болно) ба `index(org_id, is_active)` нэмсэн. `version` багана нэмээгүй: `updatedAt` (миллисекундийн нарийвчлалтай, service тодорхой тавьдаг) нь хувилбар.

`BlacklistRepository.saveWithEvent(row, event, expectedUpdatedAt: Date | null)`: `null` = шинэ мөр (create), огноо = `row`-г үндэслэсэн мөрийн `updatedAt` (compare-and-set). Алдаа: `DuplicateBlacklistEntryError` (unique зөрчил), `StaleBlacklistEntryError` (`updatedAt` таарахгүй эсвэл мөр алга) — аль аль нь 409 болно. Prisma ба in-memory repository ижил семантиктай. PrismaClient нь origination-ийн нийтлэг `PrismaService` (`PrismaModule`, глобал; `blacklist.prisma.ts` нь `useExisting`-ээр холбоно) — холболт/унтраалтыг апп (`bootstrapService`) удирдана.

Нормчлол өөрчлөгдсөн (үл үзэгдэх/compatibility тэмдэгт, ASCII биш цифр агуулсан регистрийн hash өөрчлөгдсөн) тул өмнөх normaliser-ээр хадгалсан мөрийг дахин hash хийх (backfill) шаардлагатай; скрипт одоогоор байхгүй (`docs/05` §10).

## Орчны хувьсагч

| Нэр | Утга |
| --- | --- |
| `DATABASE_URL` | Postgres (schema `origination`) |
| `DATA_ENCRYPTION_KEY` (эсвэл `DATA_ENCRYPTION_KEYS` + `DATA_ENCRYPTION_KEY_ID`) | Регистрийн AES-256-GCM түлхүүр (32 байт, base64). Байхгүй бол бичилт/унших 500 (импортод мөрийн `internal error`) |
| `DATA_INDEX_KEY` | Регистрийн blind index (HMAC-SHA256) түлхүүр — **kyc-тэй ижил** байх ёстой (projection тулгалт). Байхгүй бол бичилт/хайлт 500 |
| `DEFAULT_ORG_ID` | `X-Org-Id` ирээгүй үед |
| `INTERNAL_AUTH_SECRET` | Тохируулсан бол глобал guard `X-Internal-Token` шаардана |
| `REDIS_URL`, `OUTBOX_RELAY`, `OUTBOX_POLL_MS` | Outbox relay (`OUTBOX_RELAY=off` — тест; `OUTBOX_POLL_MS` анхдагч 500). `OUTBOX_POLL_MS` `turbo.json`-ийн env жагсаалтад ороогүй |
| `TEST_DATABASE_URL` | DB-тэй тестийн хаалга (доор) |

`.env.example` repo-ийн root-д байна (`cp .env.example .env`); `DEFAULT_ORG_ID` нь `turbo.json` `globalEnv`-д, `TEST_DATABASE_URL`, `OUTBOX_RELAY`, `DATA_*`, `INTERNAL_AUTH_SECRET` нь `globalPassThroughEnv`-д орсон.

## Бүтэц, тест

`blacklist.{module,controller,service,repository,schemas,context,tokens,prisma}.ts` · `prisma-blacklist.repository.ts` (Prisma) · `in-memory-blacklist.repository.ts` (тест) · `csv.ts`, `csv-body.middleware.ts` · `zod.pipe.ts` · `test-support.ts` (тестийн туслах).

Экспорт: `zod.pipe.ts` — `ZodPipe`, `PathParam`, `assertCleanText`, `findUnsafeText`, `unsafeTextMessage`, `safeIssues`; `csv.ts` — `parseBlacklistCsv(input, maxRows)`, `CsvFormatError`, `CsvRowLimitError`; `blacklist.service.ts` — `importLimitError`; `blacklist.context.ts` — `authorize(headers, allowed?)` (guard ба middleware хоёул дуудна), `WRITE_ROLES`, `Roles`, `BlacklistAccessGuard`; `blacklist.schemas.ts` — `MAX_IMPORT_ROWS`, `hasOnlyRegisterChars`; `blacklist.repository.ts` — `DuplicateBlacklistEntryError`, `StaleBlacklistEntryError`.

Тест: `blacklist.controller.test.ts`, `blacklist.service.test.ts`, `blacklist.schemas.test.ts`, `csv.test.ts`, `csv-body.middleware.test.ts`, `zod.pipe.test.ts`, `prisma-blacklist.repository.int.test.ts` (бодит Postgres). `test-support.ts`: `fakeCipher`, `FixedClock`, `SequentialIds`, `adminCtx`, `entryInput`, `gateReads` (зэрэг хүсэлтүүд бүгд мөрөө уншиж дуустал `findById`-г хүлээлгэж, compare-and-set уралдааныг тодорхой болгоно).

```
pnpm --filter @los/origination test                                   # DB-гүй тестүүд; int тест алгасагдана
TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test pnpm --filter @los/origination test   # бодит Postgres
```

DB-тэй тестийн хаалга нь **`TEST_DATABASE_URL`** (`DATABASE_URL` биш): өгвөл `test/global-setup.ts` (`@los/config/vitest/test-db.mjs`) өгөгдлийн сангийн нэр `test`-ээр **төгсөөгүй** бол татгалзаж, үгүй бол `origination` schema-г `DROP SCHEMA … CASCADE` хийгээд `migrate deploy` + seed хийнэ; `test/setup-env.ts` `DATABASE_URL`-ийг `?schema=origination`-тай гаргаж, `NODE_ENV=test`, `OUTBOX_RELAY=off` тавьж, `INTERNAL_AUTH_SECRET`-ийг устгана. vitest `nestPreset` файлуудыг дарааллаар ажиллуулна. Int тест хүснэгт цэвэрлэхгүй (тест бүр өөрийн `orgId`-тай), харин kyc-ийн Postgres тестүүд TRUNCATE хийдэг тул тэнд өгөгдлийн сангийн нэрэнд `test` заавал байх ёстой.

## Хязгаарлалт

- **Аудит (FR-13.5, who/when/before/after) дутуу.** Модуль `audit_log` бичихгүй (суурь `recordAudit` бэлэн болсон ч холбоогүй). Үүсгэх/засах/идэвхгүй болгох бүрийн цорын ганц ул мөр нь `BlacklistEntryChanged` outbox event — `actorId` бий, харин `reasonText`, өмнөх төлөв байхгүй. Gateway нь POST/PATCH/DELETE бүрийг `iam.audit_log`-д (хэн, endpoint, статус) бичнэ.
- Nest-ийн анхдагч JSON parser 100 KB хүртэл; том импортыг `text/csv`-ээр (5 MB) илгээнэ. JSON-ийн хязгаарыг `bootstrapService`-ийн `configure` hook-д `app.useBodyParser('json', { limit })`-ээр өргөтгөнө (одоогоор `main.ts` ашигладаггүй).
- Импорт нэг синхрон хүсэлт (мөр бүр тусдаа транзакц) тул 5000 мөр олон секунд үргэлжилж CLAUDE.md §3.1-ийн дотоод timeout-оос хэтэрч болзошгүй; BullMQ job болгох нь тусдаа ажил. Хуучин CSV-г дахин импортлоход санаатай идэвхгүй болгосон мөрүүд дахин идэвхжинэ.
- `Expect: 100-continue` илгээдэг клиентэд (жнь `curl` том файлд) Node нь middleware ажиллахаас өмнө `100 Continue` хариулдаг тул 401/403/413 шийдэгдэхээс өмнө upload эхэлнэ; сервер cap дээр уншихаа зогсоож холболтыг хаадаг ч эхний урсгалыг зогсоож чадахгүй (HTTP серверийн `checkContinue` handler шаардлагатай — модулийн гадна).
- Нэг бичлэгийн endpoint дээрх гэнэтийн DB/шифрийн алдаа 500 (`INTERNAL`); `P2002` → 409, `P2025` → 404 (nest-common filter). Origination-д DB-ийн оролтын алдааг (sqlstate `22021` гэх мэт) 400 болгох interceptor байхгүй (kyc-д `DbInputErrorInterceptor` бий): оролтын хил дээр (NUL, U+FFFD, дан surrogate, `offset`) 500-ын эх үүсвэрийг хаасан.
- origination-ийн жинхэнэ event-үүдийг kyc-ийн `BlacklistProjectionService`-д өгдөг cross-service тест байхгүй (CLAUDE.md сервис хоорондын import-ыг хориглодог); origination талд event бүр `DomainEvent.parse`-аар шалгагддаг. Дарааллыг kyc талд `hashRegisterNo`-оор бүтээсэн event-ээр тестлэнэ.
- `BlacklistEntryInput` schema `isUsableRegisterNo`-г ашигладаггүй: түүхий утга ≤ 32, `hasContent` (нормчилсны дараа ≥ 1 үсэг/цифр), `hasOnlyRegisterChars`-ыг л шалгадаг; "нормчилсон урт ≤ 32" дүрэм зөвхөн kyc-ийн `AmlSubject`-д.

## Хайлт (Модуль 1) ба `GET /api/blacklist/check`

* `BlacklistLookupService` (`blacklist-lookup.service.ts`) — `register_no_hash`-аар идэвхтэй бичлэгийг `BlacklistWarning[]` болгоно (BR-9: зөвхөн анхааруулга). `CustomerModule` ашиглана, тиймээс `BlacklistModule` үүнийг export хийнэ.
* `GET /api/blacklist/check?registerNo=` (`blacklist:read`) — маягтад регистр бичих үед автомат шалгалт. Хүчинтэй хэлбэр биш бол 400 `INVALID_REGISTER_NO`. Маршрут `:id`-ээс өмнө зарлагдсан.
* **Hash нэг: `customer.registerNoHash`-тай ижил.** `hashRegisterNo` (@los/database) нь хүчинтэй регистрт `blindIndex(normalizeRegisterNo(r))` (@los/contracts)-тай ижил утга өгнө (Ү хэвээр). Тиймээс иргэний бүртгэлийн анхааруулга ба CRUD/импортын бичлэг бие биенээ олно. Оператор Ү-ийн оронд У/Y бичсэн тохиолдлыг зөвхөн kyc-ийн AML (`registerNoHashVariants`) нөхөж харна; `warningsForHash(customer.registerNoHash)` яг таарахыг л олно.
