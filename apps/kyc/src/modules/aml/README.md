# aml — Compliance & AML

UN хориг арга хэмжээ, FATF өндөр эрсдэлтэй улс, дотоод хар жагсаалтаар зээлдэгч/хамтран зээлдэгч/батлан даагч/барьцаалагчийг автоматаар тулгана, AML эрсдэлийн оноо бодно.
Шаардлага: FR-2.5, FR-3.4, FR-6.5, FR-13.1 (өгөгдөл origination-д), BR-9. Дэлгэрэнгүй: [`docs/05-compliance-aml.md`](../../../../../docs/05-compliance-aml.md).

| Хэсэг | Файл |
| --- | --- |
| HTTP (`/api/aml/*`) | `aml.controller.ts`, `aml.context.ts` (`AmlAccessGuard`: X-толгой + дүр), `zod.pipe.ts` (NUL/дан surrogate шалгалт, `PathParam`), `db-error.interceptor.ts` (DB-ийн оролтын алдаа → 400/404) |
| Үйлчилгээ | `aml.service.ts` (screen, review, rescreen), `carry-over.ts` (шийдвэр дамжуулалт), `evidence-digest.ts` (нотолгооны хуруун мөр), `subject-identity.ts` (identity түлхүүр), `blacklist-projection.service.ts` (`BlacklistEntryChanged` → `blacklist_projection`) |
| Цэвэр логик | `engine/` (тулгалт, төлөв, `subject-names.ts`), `matching/` (кирилл↔латин нэрийн бүдэг тулгалт), `@los/calc` `amlRisk` |
| Жагсаалтын эх үүсвэр | `watchlist.service.ts` (cache, fail-closed, таталтын timeout, backoff), `../../integrations/{un-sc,fatf}/` (interface + Mock + Real), `../../integrations/integration-mode.ts` |
| Хадгалалт | `aml.ports.ts` (port), `repository/` (Prisma + in-memory + хамтын contract тест), `aml.prisma.ts` (`PrismaService`-ийг `useExisting`-ээр холбоно), `static-policy.provider.ts` |
| Тестийн туслах | `test-db.ts` (Postgres тестийн хамгаалалт). Production код импортлохгүй |

Модуль `app.module.ts`-ийн `CommonModule.forRoot()` (глобал `ContextAuthGuard`, `AllExceptionsFilter`), `PrismaModule` (нэг PrismaClient), `EventsModule.forRoot` (outbox relay), `HealthModule`-ийн дээр ажиллана; PrismaClient-ийн холболт/унтраалтыг `bootstrapService` удирдана.

## Хадгалалт

kyc schema-д `aml_check` (нэг шалгалтын нэгтгэл), `aml_hit`, `blacklist_projection` (migration `20261029050000_aml_check`; baseline `20261028000000_init`-ийг хөндөөгүй). docs/03-ийн `aml_screening` өөрчлөгдөөгүй, энэ модуль ашигладаггүй. Регистр `aml_check.register_no_encrypted`-д AES-256-GCM (aad `aml_check.register_no`), lookup-д `register_no_hash` (HMAC-SHA256, `DATA_INDEX_KEY`).

## Үндсэн дүрмүүд

- **Үргэлж гурван жагсаалт.** `AmlScreenRequest`-д `lists` байхгүй (клиентийн `lists`-ийг zod хаяна); `listVersions` үргэлж `UN_SC`, `FATF`, `INTERNAL_BLACKLIST` (`'live'`).
- **`POST /aml/screen`** (201): 400 (схем, нэр нормчлогдоод хоосон, U+0000/дан surrogate), 403 (body-ийн `orgId` ≠ толгойн org), 409 (харилцагчийн сүүлийн шалгалт блоклосон бөгөөд регистр ЭСВЭЛ identity (нэр, alias, төрсөн огноо, улс, төрөл) өөр — юу ч хадгалагдахгүй; эсвэл зэрэгцээ шалгалттай 3 оролдлогоор цувж чадаагүй), 503 (UN/FATF уншигдахгүй, ашиглах cache байхгүй).
- **Шийдвэр дамжуулалт (`carry-over.ts`).** Ижил `registerNoHash`-тай өмнөх СҮҮЛИЙН шалгалтын шийдвэрлэгдсэн hit-тэй `(list, entryRef)` таарсан hit-ийг дамжуулна: `CONFIRMED` үргэлж (`matchType`, нотолгоо өөрчлөгдсөн ч; `CONFIRMED` давамгайлна), `FALSE_POSITIVE` зөвхөн identity түлхүүр, `matchType`, `details.evidenceDigest` бүгд тэнцүү үед. Өөрөөр hit `OPEN` үлдэж `details.reopenedBecause = 'EVIDENCE_CHANGED'` авна. Дамжсан hit `status`, `reviewedBy`, `reviewedAt`, `reviewComment`-ийг өвлөж `details.carriedOverFrom` авна. `CONFIRMED` hit блоклосон хэвээр, буцаах боломжгүй. Дамжуулалт зөвхөн шинэ шалгалтад hit гарсан үед хийгдэнэ.
- **Нотолгооны хуруун мөр (`evidence-digest.ts`).** `sha256(canonicalJson({list, entryRef, matchType, severity, score, details}))`; жагсаалтын хувилбар ба service-ийн тэмдэглэгээ (`evidenceDigest`, `carriedOverFrom`, `reopenedBecause`) орохгүй.
- **Харилцагч тутамд цуваа шалгалт.** `saveScreening` нь (org, `customerId`)-ийн advisory түгжээ (`pg_advisory_xact_lock`) аваад өмнөх шалгалт одоо ч сүүлийнх (`expectedPreviousId`) эсэхийг транзакц дотор шалгана; үгүй бол `ScreeningRaceError` — service өмнөх төлвөө дахин уншиж guard + carry-over-ыг шинээр хийнэ (`MAX_SCREEN_ATTEMPTS` = 3). Шинэ шалгалтын `screenedAt` нь өмнөхөөсөө дор хаяж 1 мс хожуу.
- **Шийдвэрлэлт** (`POST /aml/hits/:id/review`, ADMIN/APPROVER, тайлбар trim-ийн дараа 5–2000 тэмдэгт): нэг транзакцид харилцагчийн advisory түгжээ → screening-ийн мөрийг түгжиж → screening сүүлийнх эсэхийг шалгаж → hit-ийг compare-and-set хийж → бүх hit-ийг дахин уншаад төлөв/`blocking`/эрсдэлийг гаргаж → outbox-д бичнэ. Superseded (харилцагчийн сүүлийн биш) шалгалтын hit `GET /aml/hits`-д орохгүй, шийдвэрлэвэл 409. Зэрэг шийдвэрлэлт хоёулаа тусгагдана; `AmlHitReviewed` нь өөрийн commit хүртэлх агрегатыг агуулна. Эхлүүлсэн хүн ямар ч шийдвэр (`CONFIRMED` ч) гаргаж болохгүй (403, `requireSeparateReviewer`). Аль хэдийн шийдвэрлэгдсэн бол 409.
- **Rescreen** (`POST /aml/rescreen`, ADMIN, `limit` 1–500, анхдагч 50): `UN_SC`/`FATF` хувилбар зөрсөн сүүлийн шалгалтуудыг `LIST_UPDATE`-ээр дахин хийнэ; хариу `{checked, rescreened, failed, skipped}`. `skipped` = сонгосноос хойш шалгалт солигдсон. `screenedBy` анхны хүн хэвээр (admin нь зөвхөн `actorId`). Хувилбарт `+stale` тамга `screen()`-тэй ижил тул доройтсон төлөв дахин давтагдахгүй. Харилцагч тутмын алдаа `failed`-д тоологдож бусдыг зогсоохгүй, ERROR түвшинд `rescreen failed: error=… code=… customerId=… correlationId=…` гэж логлогдоно. UN/FATF уншигдахгүй, cache байхгүй бол бүх хүсэлт 503. Дотоод хар жагсаалтад дараа нэмэгдсэн харилцагчийг олохгүй (мэдэгдэж буй хязгаарлалт).
- **Жагсаалтын cache (`watchlist.service.ts`).** Таталт `fetchTimeoutMs` (анхдагч 15000 мс) хязгаартай бөгөөд `fetchSnapshot(signal)`-ийн `AbortSignal` цуцлагдана; хугацаа хэтэрвэл ≤ `maxStaleListHours` (72) cache руу (`+stale`), байхгүй бол 503. Таталт амжилтгүй болсны дараа `retryBackoffMs` (анхдагч 30000 мс; 0 → хаалтгүй) хугацаанд шинэ таталт эхлүүлэхгүй (cache байвал даруй `+stale`, үгүй бол даруй 503). Өмнөх snapshot ≥ 20 бичилттэй бөгөөд шинэ нь түүний `minSnapshotRatio` (анхдагч 0.5; 0 → шалгахгүй)-оос бага бол таталт амжилтгүй. Шинэчлэлт дуудлагаар (lazy), `AML_LIST_REFRESH_MINUTES` (анхдагч 360). `POST /aml/lists/refresh` backoff-д хамаарахгүй. `WatchlistOptions` нь кодын тохиргоо (env биш).
- **Оролт.** U+0000 эсвэл дан surrogate агуулсан body/query/path → 400 (`ZodPipe` `issues[].path`-тай, `issues` нь бүтэн аппын `AllExceptionsFilter`-ээр дамжихгүй — `docs/05` §7). `:id`, `:customerId` хоосон биш; олдохгүй/uuid биш id → 404. `GET /aml/hits` `limit` 1–100, `offset` ≤ 1 000 000. `orgId`, `customerId`, `applicationId` ≤ 128 тэмдэгт. DB-ийн оролтын алдаа (`22021`, `22P02`, `22003`, `22001`, Prisma validation) → 400, `P2025` → 404 (тогтмол мессеж, 500 биш).
- **PII.** Регистр зөвхөн масклагдсан (`maskRegisterNoStrict`: `n ≤ 6` бүгд `*`, үгүй бол сүүлийн `min(4, ⌊n/3⌋)`), HMAC hash, AES-256-GCM шифрлэсэн хэлбэрээр; `subject_json`, лог, event-д plain регистр орохгүй.
- **Event.** `AmlScreeningCompleted`, `AmlHitReviewed` бизнес мөртэйгээ нэг транзакцид outbox-д (repository нь `enqueueOutbox(tx, event)`-ээр бичиж, event-ийг `DomainEvent`-ээр шалгана); relay-г nest-common `EventsModule` ажиллуулна. `BlacklistProjectionService` нь `bus.subscribe('kyc', ['BlacklistEntryChanged'])` — давхардлыг `processed_events`, хуучин event-ийг `changedAt` хаана. `REDIS_URL` байхгүй эсвэл `OUTBOX_RELAY=off` бол bus = null (event нийтлэгдэхгүй, subscription үүсэхгүй).

## Нэр тулгалтын номын сан (`matching/`)

Нормчлох дараалал: NFKC + жижиг үсэг → кирилл→латин (`translit.ts`) → латин үсгийн хүснэгт (`ı đ ł ø æ œ ß þ`) → NFKD, mark устгах → зураас/тэмдэгт цэвэрлэх → fold (`kh→h, ph→f, ck→k, zh→j, q→k, w→v, x→ks`, давхар латин үсэг нэг болно). Нэр бүр хэд хэдэн хэлбэртэй (үндсэн; `ө` байвал паспортын `ө→u`; латин+кирилл холимог үг байвал дүрсээр ижил skeleton) гурван багцад харьцуулагдана: үндсэн; эгшгийн хувилбар (`o→u`, `e→a`, үндсэн хэлбэрийн токенд); ААН-д хуулийн хэлбэр (`legal-forms.ts`) хасаагүй хэлбэр. ААН-д хуулийн хэлбэрийн үгийг хоёр талаас хасч, `L.L.C.`, `ООО` зэргийг эхлээд нормчилно.

Оноо = токений Jaro-Winkler (хос ≥ 0.80, урт жингээр, хосгүй токен хуваагчид орно), залгасан хэлбэр (хил хязгаарын зөрүүтэй нэр: засвар ≤ 1, инициалтай бол 0, ижилсэл ≥ 0.80, цифр тэнцүү), токены цикл эргэлт (яг тэнцүү үсгийн дараалал)-ийн хамгийн өндөр нь. Cap: залгасан хэлбэр, эргэлт ≤ 0.97 (`VARIANT_SCORE_CAP`); эгшгийн хувилбар ≤ 0.93 (`VOWEL_SCORE_CAP`); цифр токен зөрсөн хос ≤ `reviewThreshold − 0.0001` (engine дамжуулдаг; номын сангийн анхдагч `DIGIT_CONFLICT_CAP` = 0.5). Иймд оноо яг 1 нь нормчилсон нэр (эсвэл токены олонлог) тэнцүү үед л. Engine оноог 4 орон хүртэл бөөрөнхийлж (`quantiseScore`, 1-ээс бага нь 0.9999-өөс хэтрэхгүй) босгоор харьцуулна; `NAME_EXACT` = оноо яг 1, бусад нь `NAME_FUZZY`.

Public API (`matching/index.ts`): `normalizeName`, `normalizeNameForms`, `tokenize`, `jaroWinkler`, `nameSimilarity(a, b, options?)`, `bestNameMatch(subjects, candidates, options?)`, `prepareName(name, options?)`, `bestPreparedMatch(prepared, prepared)`; төрөл `NameMatch`, `PreparedName`, `NameOptions` (`{ legalEntity?: boolean }`), `ScoreOptions`. Engine нь нэр бүрийг screening бүрт НЭГ удаа `prepareName` хийж `bestPreparedMatch` ашиглана (UN бүртгэлийн бэлтгэл WeakMap-д cache-лэгдэнэ).

Регистрийн таарал (`REGISTER_EXACT`): улсын шүүлтүүр зөвхөн Монгол хэлбэрийн регистрт (хувь хүн = 2 кирилл үсэг + 8 цифр, ААН = 7 цифр); бусад хэлбэр (гадаад паспорт) улсаар шүүгдэхгүй.

`@los/contracts` нэмж экспортолсон: `isUsableRegisterNo`, `normalizedRegisterNoLength`, `nameTokenCount`, `REGISTER_NO_MAX_LENGTH` (32), `MAX_NAME_TOKENS` (12), `MAX_SUBJECT_NAME_TOKENS` (48), `AML_ID_MAX_LENGTH` (128). Регистрийн нормчлол нь `@los/database` `normalizeRegisterNo` (Cf устгах → NFKC → том үсэг → NFKC → үсэг/цифр биш бүгдийг устгах → цифр ASCII → look-alike; кирилл `Ү` хэвээр — @los/contracts `normalizeRegisterNo`-той ижил hash); UN-ийн таних тэмдэгт `foldRegisterNo` (`Ү→У`), дотоод хар жагсаалт `registerNoHashVariants` (У/Ү хослол, ≤ 4 hash) ашиглана; `engine/register-contract-parity.test.ts` contracts-ийн урт тооцоотой тулгана. `engine/subject-names.ts`-ийн `hasScreenableName` нь service-д холбогдсон (нормчлогдоод бүх нэр хоосон бол 400).

## Тест

`pnpm --filter @los/kyc test` (vitest `nestPreset`; файлууд нэг schema-г хуваалцдаг тул `fileParallelism: false`, дарааллаар). DB-тэй тестийн хаалга нь **`TEST_DATABASE_URL`** (`DATABASE_URL` биш). Өгөөгүй бол `prisma-aml.repository.int.test.ts`, `test/health.e2e.test.ts` алгасагдаж, `aml.e2e.test.ts` in-memory repository-оор ажиллана. Өгвөл `test/global-setup.ts` (`@los/config/vitest/test-db.mjs`) өгөгдлийн сангийн нэр `test`-ээр **төгсөөгүй** бол татгалзаж, үгүй бол `kyc` schema-г `DROP SCHEMA … CASCADE` хийгээд `migrate deploy` + seed хийнэ; `test/setup-env.ts` `DATABASE_URL`-ийг `?schema=kyc`-тэй гаргаж, `NODE_ENV=test`, `OUTBOX_RELAY=off` тавьж, `INTERNAL_AUTH_SECRET`-ийг устгана; `aml.e2e.test.ts` бодит `PrismaAmlRepository`-оор ажиллана. Жнь: `TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test pnpm --filter @los/kyc test`.

Эдгээр Postgres тестүүд `kyc.aml_hit, aml_check, blacklist_projection, processed_events, outbox`-ийг **TRUNCATE** хийдэг тул `DATABASE_URL`-ийн өгөгдлийн сангийн нэрэнд `test` (том/жижиг үсэг ялгахгүй) агуулаагүй бол татгалзана (`test-db.ts`).

## Орчин

| Нэр | Тайлбар |
| --- | --- |
| `INTEGRATION_MODE` | `mock` \| `real`. Тохируулаагүй бол `mock`, гэхдээ `NODE_ENV=production` үед тохируулаагүй бол апп эхлэхэд алдаа (тодорхой `mock` зөвшөөрөгдөнө). `real` нь одоогоор бүх screening-ийг 503 болгоно (Real client хэрэгжээгүй) |
| `NODE_ENV` | `production` үед дээрх хамгаалалт. `turbo.json` `globalPassThroughEnv`-д орсон |
| `DATA_ENCRYPTION_KEY` (эсвэл `DATA_ENCRYPTION_KEYS` + `DATA_ENCRYPTION_KEY_ID`) | Регистрийн AES-256-GCM түлхүүр (32 байт, base64) |
| `DATA_INDEX_KEY` | Регистрийн blind index (HMAC-SHA256) түлхүүр — origination-той **ижил**. Байхгүй бол `POST /aml/screen` 500 |
| `REDIS_URL`, `OUTBOX_RELAY` | Outbox relay ба `BlacklistProjectionService`-ийн subscription. `REDIS_URL` байхгүй эсвэл `OUTBOX_RELAY=off` бол bus = null |
| `INTERNAL_AUTH_SECRET` | Тохируулсан бол глобал guard `X-Internal-Token` шаардана |
| `DEFAULT_ORG_ID` | `X-Org-Id` ирээгүй үед |
| `AML_LIST_REFRESH_MINUTES` | Cache шинэчлэх давтамж, минут (анхдагч 360); эерэг тоо биш бол апп эхлэхэд алдаа |
| `DATABASE_URL` | Postgres (schema `kyc`) |
| `TEST_DATABASE_URL` | DB-тэй тестийн хаалга (дээр) |

`.env.example` repo-ийн root-д байна (`cp .env.example .env`). `DEFAULT_ORG_ID`, `AML_LIST_REFRESH_MINUTES`, `INTEGRATION_MODE` нь `turbo.json` `globalEnv`-д; `TEST_DATABASE_URL`, `NODE_ENV`, `OUTBOX_RELAY`, `DATA_*`, `INTERNAL_AUTH_SECRET` нь `globalPassThroughEnv`-д (`turbo-env.test.ts` нь `NODE_ENV`, `INTEGRATION_MODE`, `DEFAULT_ORG_ID`, `AML_LIST_REFRESH_MINUTES`, `DATABASE_URL` аль нэг жагсаалтад байгааг шалгана). `OUTBOX_POLL_MS` ямар ч жагсаалтад ороогүй. `.env` нь root болон `apps/kyc/`-аас ачаалагдана.

## Хязгаарлалт

Мэдэгдэж буй хязгаарлалтын бүрэн жагсаалт (нэрийн тулгалт, шийдвэр ба identity, rescreen, түлхүүр солих, hash backfill, ажиллагаа) — `docs/05-compliance-aml.md` §10. Үүнээс гол нь: `RealUnScClient`/`RealFatfClient` хэрэгжээгүй; бодлого `StaticAmlPolicyProvider`-аас (settings projection хараахан байхгүй); `AmlScreeningCompleted`/`AmlHitReviewed`-ийн сонсогч (origination, dwh-sync), G1 хаалт, rescreen-ийн cron wiring өөр thread; repository outbox-ийг `enqueueOutbox`-гүйгээр шууд бичдэг; глобал `AllExceptionsFilter` 400-ын `issues`-ийг дамжуулдаггүй.
