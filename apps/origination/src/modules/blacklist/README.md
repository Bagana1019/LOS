# blacklist

Дотоод хар жагсаалт: найдваргүй зээлдэгчийн CRUD ба импорт. Эзэмшигч нь `origination` (`origination.blacklist`); `kyc` нь `BlacklistEntryChanged` event-ээр өөрийн `blacklist_projection`-ийг хөтөлж, харилцагчийг регистрээр тулгана (`docs/05-compliance-aml.md`).

Шаардлага: **FR-13.1** (хар жагсаалт CRUD, импорт), **BR-9** (бүх шалтгаанд зөвхөн анхааруулга, хориг байхгүй — энэ модуль зээлийг хаахгүй; kyc `WARNING` hit гаргаж батлагч шийднэ). **FR-13.5** (аудит) дутуу — доорх "Хязгаарлалт".

## Endpoint (`/api` угтвар)

Толгой (CLAUDE.md §3.2.9): `X-User-Id` **заавал** (үгүй бол 401), `X-Roles` (таслалаар; үл мэдэгдэх дүрийг тооцохгүй), `X-Branch-Id`, `X-Correlation-Id` (үгүй бол uuid үүсгэнэ), `X-Org-Id` (үгүй бол `DEFAULT_ORG_ID`, тэр ч үгүй бол 400).

| Метод, зам | Дүр | Хариу |
| --- | --- | --- |
| `GET /blacklist?q=&listType=&isActive=&limit=&offset=` | `X-User-Id`-тэй ДУРЫН дуудагч | `{ total, items: BlacklistEntry[] }`, `registeredAt` буурахаар (тэнцвэл `id` өсөхөөр). `limit` 1–100 (анхдагч 20), `offset` 0–1 000 000 (түүнээс их бол 400). `q` (≤ 200) = нэрийн хэсэг (том/жижиг үсэг ялгахгүй, `%` `_` шууд утгаараа) **эсвэл** регистр (HMAC hash-аар, яг тохирол). `listType` том үсэг болгож шүүнэ |
| `GET /blacklist/:id` | `X-User-Id`-тэй ДУРЫН дуудагч | `BlacklistEntry`; олдохгүй эсвэл өөр org-ийнх бол 404 |
| `POST /blacklist` | ADMIN, BRANCH_MANAGER | 201. Идэвхтэй давхардал (org + регистр + `listType`) → 409; идэвхгүй мөр байвал шинэ өгөгдлөөр **дахин идэвхжүүлж** 201 |
| `PATCH /blacklist/:id` | ADMIN, BRANCH_MANAGER | Хэсэгчилсэн засвар (`isActive` орно). `reasonText`-д `null` эсвэл `''` өгвөл тайлбарыг арилгана (GET-ийн хариуг шууд буцаан PATCH хийж болно). Регистр/`listType` өөрчлөхөд өөр мөртэй давхцвал (идэвхгүй ч) 409. Өөрчлөлтгүй бол event гаргахгүй. Идэвхгүй мөрийг `isActive=true` болговол дахин бүртгэгдсэн гэж үзнэ (`registeredBy/At`, `branchId` шинэчлэгдэнэ) |
| `DELETE /blacklist/:id` | ADMIN, BRANCH_MANAGER | Устгахгүй, `isActive=false` болгоно (идэмпотент), 200 |
| `POST /blacklist/import` | ADMIN, BRANCH_MANAGER | `BlacklistImportResult`; `text/csv` (≤ 5 MB) эсвэл JSON `{ rows: [...] }`; дээд 5000 мөр (хэтэрвэл 413). "CSV импорт" хэсгийг үз |

Бүх оролт `@los/contracts`-ийн zod схемээр шалгагдана; алдаа → 400 `{ statusCode, message, issues }` (stack-гүй). Body (JSON), query, `:id`-д U+0000 (NUL) байвал 400 `{ statusCode: 400, message: 'Validation failed', issues: [{ code: 'custom', path, message: 'NUL (U+0000) characters are not allowed' }] }` (500 биш).

**Зэрэг засвар (409).** `PATCH`, `DELETE`, `POST` (дахин идэвхжүүлэх) ба импортын мөр нь мөрийг уншсанаас хойш өөр хүсэлт өөрчилсөн бол `409 Blacklist entry was modified concurrently, retry`. Бичилт нь уншсан мөрийн `updatedAt` дээрх compare-and-set (`UPDATE … WHERE id AND updated_at = уншсан утга`); клиент дахин уншаад давтана. Мөр ба outbox event хоёул бичигдэхгүй. Идэвхтэй давхардлын 409 (`An entry with the same register number and list type already exists`) өөр.

**Унших эрх.** Хариунд тайлсан `registerNo` (нормчилсон хэлбэрээр) орно. `GET` нь `X-User-Id`-тэй ДУРЫН дуудагчид нээлттэй — `X-Roles` хоосон, үл мэдэгдэх ч — тиймээс **эрхийг (хэн уншиж болох) gateway шийднэ**; энэ модуль зөвхөн нэвтэрсэн эсэхийг шалгана. Лог, event, алдааны мессежид регистр хэзээ ч бичигдэхгүй; хариунд `registerNoHash`, шифртэй текст орохгүй.

## CSV импорт

Header мөр заавал: `registerNo,customerType,name,listType,reasonCode,reasonText` (`listType`, `reasonText` багана заавал биш; баганын нэр том/жижиг үсэг ялгахгүй; үл мэдэгдэх/давхардсан/дутуу багана → 400). UTF-8 BOM, CRLF, `"..."` талбар (таслал, `""` хашилт, мөр таслалт), `,` эсвэл `;` (header-ээс автоматаар), хоосон мөр — зөвшөөрнө. Мөр бүр `(org, регистр hash, listType)`-ээр upsert: шинэ → `created`; өөр өгөгдөл эсвэл идэвхгүй байсан → `updated` (дахин идэвхжинэ); ижил ба идэвхтэй → `skipped`. Алдаатай мөр `errors: [{ row, message }]` (`row` = header, хоосон мөрийг тоолохгүй 1-ээс эхэлсэн өгөгдлийн мөр; JSON-д `rows`-ийн дугаар) болж, бусдыг зогсоохгүй.

**Дарааллаар шалгана (`text/csv`).** Body-г уншихаас ӨМНӨ: 401 (`X-User-Id` үгүй) → 400 (`X-Org-Id`, `DEFAULT_ORG_ID` хоёул үгүй) → 403 (дүр ADMIN/BRANCH_MANAGER биш) → 413 (`Content-Length` > 5 MB = 5 242 880 байт). Ингэснээр эрхгүй эсвэл хэт том upload 413 биш 401/403 авна. Эдгээр хүсэлт `Connection: close`-той татгалзагдаж, сервер уншаагүй body-г drain хийхгүй — upload хийж буй клиент статус авахын оронд connection reset харж болно. Дараа нь body-г уншина: `Content-Length`-гүй (chunked) бол cap-аас хэтэрсэн эхний chunk дээр зогсож 413. Дараа нь **хатуу UTF-8** (UTF-8 BOM зөвшөөрнө): Windows-1251, UTF-16 зэрэг бусад кодчилол 400 `CSV body must be valid UTF-8 (save the file as "CSV UTF-8" …)` — юу ч импортлогдохгүй. CSV текстэд U+0000 (UTF-16 файлын ердийн шинж) байвал мөн 400 (UTF-8 сануулгатай). Header/бүтцийн алдаа (хаагдаагүй хашилт, header үгүй) 400.

**Мөрийн хязгаар.** Өгөгдлийн мөр ≤ **5000** (`MAX_IMPORT_ROWS`): задлах явцад 5001 дэх хоосон биш өгөгдлийн мөр харагдмагц 413 (`At most 5000 rows per import`) — header, хоосон мөр, бүх талбар хоосон мөрийг тоолохгүй, сая сая мөрийг санах ойд үүсгэхгүй. JSON-ийн `rows` > 5000 бол мөн 413.

**Нэг синхрон хүсэлт, атомик биш.** 5000 мөртэй импорт нь НЭГ HTTP хүсэлт; мөр бүр тусдаа транзакц тул файл бүхэлдээ атомик биш (дундаас зогсвол өмнөх мөрүүд commit-лэгдсэн хэвээр), харин дахин ачаалахад өөрчлөгдөөгүй мөр `skipped` болно. Мөр бүрийн алдаа бусдыг зогсоохгүй:

- шалгалтын алдаа — `errors[]`-д zod мессежтэй;
- зэрэг засварт ялагдсан мөр — `Blacklist entry was modified concurrently, retry`; давхардал — `An entry with the same register number and list type already exists`;
- DB/repository-ийн гэнэтийн алдаа — `{ row, message: 'Row could not be saved (internal error)' }` (утга хариу/лог-д орохгүй), үлдсэн мөрүүд үргэлжилнэ, HTTP 200. DB бүрэн унасан үед бүх мөр `errors[]`-д орсон 200 ирж болно.

**Дахин идэвхжүүлэлт ба тайлбар.** Хуучин CSV-г дахин импортлоход идэвхгүй болгосон мөрүүд **дахин идэвхжинэ** (импортолсон хэрэглэгч, цаг, салбараар шинээр бүртгэгдэнэ). Мөр бүрийн `customerType`, `name`, `reasonCode`, `reasonText` бүхлээр солигдох тул `reasonText`-гүй мөр одоо байгаа тайлбарыг арилгана (`updated`). JSON импортод NUL байвал бүх body 400 (хэсэгчлэн импортлохгүй).

## Event

`BlacklistEntryChanged` (`@los/contracts/events.ts`) — үүсгэх, засах, идэвхгүй болгох, импортын мөр бүрт нэг ширхэг (өөрчлөлтгүй PATCH/`skipped`/идэвхгүй мөрийн DELETE-д гарахгүй): `entryId`, `registerNoHash`, `customerType`, `name`, `listType`, `reasonCode`, `isActive`, `changedAt` + суурь талбарууд (`eventId`, `occurredAt`, `version: 1`, `orgId`, `actorId`, `correlationId`). Мөр ба outbox мөр **нэг транзакцид** (`saveWithEvent`, CLAUDE.md §3.2.4); event-д plain регистр, `reasonText`, өмнөх төлөв байхгүй.

- `registerNoHash` нь `/^[0-9a-f]{64}$/` (HMAC-SHA256 hex) — schema үүнийг шалгана, plain регистр няцна. Producer болон fixture бүр `hashRegisterNo`-ийн жинхэнэ утга ашиглана.
- `changedAt` нь мөрийн `updatedAt`-тай тэнцүү бөгөөд нэг мөрөнд **хатуу өснө**: `max(clock.now(), өмнөх updatedAt + 1мс)` — цаг ухарсан эсвэл нэг миллисекундэд хоёр засвар орсон ч дараалал алдагдахгүй. kyc зөвхөн `changedAt` хатуу шинэ event-ийг хэрэглэнэ (тэнцүү нь `STALE`). `occurredAt` бодит цаг хэвээр тул цагийн зөрүүд `changedAt`-аас өмнө байж болно.

## Өгөгдөл

`origination.blacklist` (`prisma/schema.prisma`, `model Blacklist`). docs/03-ийн `register_no`-г `register_no_encrypted` (шифрлэгдсэн, CLAUDE.md §6.5) + `register_no_hash` (HMAC-SHA256, `hashRegisterNo`) болгосон; давхардал `unique(org_id, register_no_hash, list_type)`. Регистрийг нормчилсон хэлбэрээр (`normalizeRegisterNo`) хадгална. Нэрээр тулгахгүй — зөвхөн регистрээр (нийтлэг нэрээр хуурамч тохирол их).

`BlacklistRepository.saveWithEvent(row, event, expectedUpdatedAt: Date | null)`: `null` = шинэ мөр (create), огноо = `row`-г үндэслэсэн мөрийн `updatedAt` (compare-and-set). Алдаа: `DuplicateBlacklistEntryError` (unique зөрчил), `StaleBlacklistEntryError` (`updatedAt` таарахгүй эсвэл мөр алга) — аль аль нь 409 болно. **Schema, migration өөрчлөөгүй**, `version` багана нэмээгүй: `updatedAt` (миллисекундийн нарийвчлалтай, service тодорхой тавьдаг) нь хувилбар. Prisma ба in-memory repository ижил семантиктай.

Нормчлол өөрчлөгдсөн (`Ү`, үл үзэгдэх/compatibility тэмдэгт, ASCII биш цифр агуулсан регистрийн hash өөрчлөгдсөн) тул өмнөх normaliser-ээр хадгалсан мөрийг дахин hash хийх (backfill) шаардлагатай; скрипт одоогоор байхгүй (`docs/05` §10).

## Орчны хувьсагч

| Нэр | Утга |
| --- | --- |
| `DATABASE_URL` | Postgres (schema `origination`) |
| `PII_HASH_KEY` | Регистрийн HMAC түлхүүр — **kyc-тэй ижил** байх ёстой (projection тулгалт). Байхгүй бол бичилт/хайлт 500 |
| `DEFAULT_ORG_ID` | `X-Org-Id` ирээгүй үед |

`PII_HASH_KEY`, `DEFAULT_ORG_ID` нь `turbo.json` `globalEnv`-д орсон. `.env.example` repo-д **одоогоор байхгүй** (M00-д нэмнэ); хувьсагчийг shell/CI-аар эсвэл `apps/origination/.env`-ээр өгнө.

## Бүтэц, тест

`blacklist.{module,controller,service,repository,schemas,context,tokens,prisma}.ts` · `prisma-blacklist.repository.ts` (Prisma) · `in-memory-blacklist.repository.ts` (тест) · `csv.ts`, `csv-body.middleware.ts` · `zod.pipe.ts` · `test-support.ts` (тестийн туслах). Бусад: `../../app.setup.ts` (`configureApp`: `/api` угтвар, `enableShutdownHooks`).

Экспорт: `zod.pipe.ts` — `ZodPipe`, `PathParam`, `assertNoNul`, `findNulPath`; `csv.ts` — `parseBlacklistCsv(input, maxRows)`, `CsvFormatError`, `CsvRowLimitError`; `blacklist.service.ts` — `importLimitError`; `blacklist.context.ts` — `authorize(headers, allowed?)` (guard ба middleware хоёул дуудна), `WRITE_ROLES`; `blacklist.repository.ts` — `DuplicateBlacklistEntryError`, `StaleBlacklistEntryError`.

Тест: `blacklist.controller.test.ts`, `blacklist.service.test.ts`, `blacklist.prisma.test.ts`, `csv.test.ts`, `csv-body.middleware.test.ts`, `prisma-blacklist.repository.int.test.ts` (бодит Postgres), `../../app.setup.test.ts`. `test-support.ts`: `fakeCipher`, `FixedClock`, `SequentialIds`, `adminCtx`, `entryInput`, `gateReads` (зэрэг хүсэлтүүд бүгд мөрөө уншиж дуусах хүртэл `findById`-г хүлээлгэж, compare-and-set уралдааныг тодорхой болгоно).

```
cd apps/origination && npx vitest run src/modules/blacklist
DATABASE_URL=postgresql://los@localhost:5544/los_orig_test npx vitest run src/modules/blacklist   # бодит Postgres (prisma db push хийсэн)
```

`DATABASE_URL`-тэй int тест хүснэгт цэвэрлэхгүй (тест бүр өөрийн `orgId`-тай), харин kyc-ийн Postgres тестүүд TRUNCATE хийдэг тул тэнд өгөгдлийн сангийн нэрэнд `test` заавал байх ёстой.

## Хязгаарлалт, M00-д үлдсэн

- `encryptedField`/`decryptedField`/`enqueueOutbox` нь `@los/database`-д `TODO(M00)`: шифрлэлт `PiiCipher` port-оор (default нь эдгээр функц тул M00 хүртэл POST/PATCH/унших 500), outbox мөрийг repository шууд бичдэг. Relay worker M00-д.
- Nest-ийн анхдагч JSON parser 100 KB хүртэл; том импортыг `text/csv`-ээр (5 MB) илгээнэ. JSON-ийн хязгаарыг `main.ts`-д `app.useBodyParser('json', { limit })`-ээр өргөтгөнө.
- PrismaClient-ийг `blacklist.prisma.ts` үүсгэнэ (модуль унтрахад `$disconnect`; `main.ts` нь `configureApp`-аар `enableShutdownHooks` дууддаг); origination-ийн нийтлэг PrismaClient гарахад `useExisting`-ээр солино.
- **Аудит (FR-13.5, who/when/before/after) дутуу.** Модуль `audit_log` бичихгүй. Үүсгэх/засах/идэвхгүй болгох бүрийн цорын ганц ул мөр нь `BlacklistEntryChanged` outbox event — `actorId` бий, харин `reasonText`, өмнөх төлөв байхгүй. `audit_log`-ийг M00 хэрэгжүүлэхэд холбоно.
- Импорт нэг синхрон хүсэлт (мөр бүр тусдаа транзакц) тул 5000 мөр олон секунд үргэлжилж CLAUDE.md §3.1-ийн дотоод timeout-оос хэтэрч болзошгүй; BullMQ job болгох нь тусдаа ажил. Хуучин CSV-г дахин импортлоход санаатай идэвхгүй болгосон мөрүүд дахин идэвхжинэ.
- `Expect: 100-continue` илгээдэг клиентэд (жнь `curl` том файлд) Node нь middleware ажиллахаас өмнө `100 Continue` хариулдаг тул 401/403/413 шийдэгдэхээс өмнө upload эхэлнэ; сервер cap дээр уншихаа зогсоож холболтыг хаадаг ч эхний урсгалыг зогсоож чадахгүй (HTTP серверийн `checkContinue` handler шаардлагатай — модулийн гадна).
- Глобал exception filter байхгүй: оролтын хил дээр (NUL, `offset`) 500-ын эх үүсвэрийг хаасан, импортын мөр бүрийн DB алдаа `errors[]`-д орно, харин нэг бичлэгийн endpoint дээрх бусад гэнэтийн DB алдаа 500 хэвээр.
- origination-ийн жинхэнэ event-үүдийг kyc-ийн `BlacklistProjectionService`-д өгдөг cross-service тест байхгүй (CLAUDE.md сервис хоорондын import-ыг хориглодог); origination талд event бүр `DomainEvent.parse`-аар шалгагддаг. Дарааллыг kyc талд `hashRegisterNo`-оор бүтээсэн event-ээр тестлэнэ.
- `BlacklistEntryInput` schema `isUsableRegisterNo`-г ашигладаггүй: "нормчилсны дараа дор хаяж 1 үсэг/цифр" (`hasContent`) ба түүхий утга ≤ 32-ыг л шалгадаг; "нормчилсон урт ≤ 32" дүрэм зөвхөн kyc-ийн `AmlSubject`-д.
