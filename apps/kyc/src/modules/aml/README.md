# aml — Compliance & AML

UN хориг арга хэмжээ, FATF өндөр эрсдэлтэй улс, дотоод хар жагсаалтаар зээлдэгч/хамтран зээлдэгч/батлан даагч/барьцаалагчийг автоматаар тулгана, AML эрсдэлийн оноо бодно.
Шаардлага: FR-2.5, FR-3.4, FR-6.5, FR-13.1 (өгөгдөл origination-д), BR-9. Дэлгэрэнгүй: [`docs/05-compliance-aml.md`](../../../../../docs/05-compliance-aml.md).

| Хэсэг | Файл |
| --- | --- |
| HTTP (`/api/aml/*`) | `aml.controller.ts`, `aml.context.ts` (X-толгой, дүр), `zod.pipe.ts` (NUL шалгалт, `PathParam`), `db-error.interceptor.ts` (DB-ийн оролтын алдаа → 400/404) |
| Үйлчилгээ | `aml.service.ts` (screen, review, rescreen, carry-over), `blacklist-projection.service.ts` (`BlacklistEntryChanged` → `blacklist_projection`) |
| Цэвэр логик | `engine/` (тулгалт, төлөв, `subject-names.ts`), `matching/` (кирилл↔латин нэрийн бүдэг тулгалт), `@los/calc` `amlRisk` |
| Жагсаалтын эх үүсвэр | `watchlist.service.ts` (cache, fail-closed, таталтын timeout), `../../integrations/{un-sc,fatf}/` (interface + Mock + Real), `../../integrations/integration-mode.ts` |
| Хадгалалт | `aml.ports.ts` (port), `repository/` (Prisma + in-memory + хамтын contract тест), `aml.prisma.ts` |
| Тестийн туслах | `test-db.ts` (Postgres тестийн хамгаалалт). Production код импортлохгүй |

## Үндсэн дүрмүүд

- **Үргэлж гурван жагсаалт.** `AmlScreenRequest`-д `lists` байхгүй (клиентийн `lists`-ийг zod хаяна); `listVersions` үргэлж `UN_SC`, `FATF`, `INTERNAL_BLACKLIST` (`'live'`).
- **`POST /aml/screen`** (201): 400 (схем, нэр нормчлогдоод хоосон, U+0000), 403 (body-ийн `orgId` ≠ толгойн org), 409 (харилцагчийн сүүлийн шалгалт блоклосон бөгөөд регистр өөр — юу ч хадгалагдахгүй), 503 (UN/FATF уншигдахгүй, ашиглах cache байхгүй).
- **Шийдвэр өвлөх.** Ижил `registerNoHash`-тай өмнөх сүүлийн шалгалтын шийдвэрлэгдсэн hit-тэй `(list, entryRef, matchType)` таарсан hit `status`, `reviewedBy`, `reviewedAt`, `reviewComment`-ийг өвлөж `details.carriedOverFrom` авна (`CONFIRMED` давамгайлна). `CONFIRMED` hit блоклосон хэвээр, буцаах боломжгүй.
- **Шийдвэрлэлт** (`POST /aml/hits/:id/review`, ADMIN/APPROVER, тайлбар 5–2000 тэмдэгт): нэг транзакцид screening-ийн мөрийг түгжиж, hit-ийг compare-and-set хийж, бүх hit-ийг дахин уншаад төлөв/`blocking`/эрсдэлийг гаргаж, outbox-д бичнэ. Зэрэг шийдвэрлэлт хоёулаа тусгагдана; `AmlHitReviewed` нь өөрийн commit хүртэлх агрегатыг агуулна. Эхлүүлсэн хүн ямар ч шийдвэр (`CONFIRMED` ч) гаргаж болохгүй (403, `requireSeparateReviewer`). Аль хэдийн шийдвэрлэгдсэн бол 409.
- **Rescreen** (`POST /aml/rescreen`, ADMIN, `limit` 1–500, анхдагч 50): `UN_SC`/`FATF` хувилбар зөрсөн сүүлийн шалгалтуудыг `LIST_UPDATE`-ээр дахин хийнэ. `screenedBy` анхны хүн хэвээр (admin нь зөвхөн `actorId`). Хувилбарт `+stale` тамга `screen()`-тэй ижил тул доройтсон төлөв дахин давтагдахгүй. Дотоод хар жагсаалтад дараа нэмэгдсэн харилцагчийг олохгүй (мэдэгдэж буй хязгаарлалт). Харилцагч тутмын алдаа `failed`-д тоологдож бусдыг зогсоохгүй.
- **Жагсаалтын cache.** Таталт `fetchTimeoutMs` (анхдагч 15000 мс, `WatchlistOptions`) хязгаартай; хугацаа хэтэрвэл ≤ `maxStaleListHours` (72) cache руу, байхгүй бол 503. Шинэчлэлт дуудлагаар (lazy), `AML_LIST_REFRESH_MINUTES` (анхдагч 360).
- **Оролт.** U+0000 агуулсан body/query/path → 400 (`issues[].path`-тай). `:id`, `:customerId` хоосон биш; олдохгүй/uuid биш id → 404. `GET /aml/hits` `limit` 1–100, `offset` ≤ 1 000 000. DB-ийн оролтын алдаа (`22021`, `22P02`, `22003`, `22001`, Prisma validation) → 400, `P2025` → 404 (тогтмол мессеж, 500 биш).
- **PII.** Регистр зөвхөн масклагдсан (`n ≤ 6` бүгд `*`, үгүй бол сүүлийн `min(4, ⌊n/3⌋)`), HMAC hash, шифрлэсэн хэлбэрээр; `subject_json`, лог, event-д plain регистр орохгүй.

## Нэр тулгалтын номын сан (`matching/`)

Нормчлох дараалал: NFKC + жижиг үсэг → кирилл→латин → NFKD, mark устгах → зураас/тэмдэгт цэвэрлэх → fold (`kh→h, ph→f, ck→k, q→k, w→v, x→ks`, давхар латин үсэг нэг болно). Нэр бүр хэд хэдэн хэлбэртэй (үндсэн; `ө` байвал паспортын `ө→u`; латин+кирилл холимог үг байвал дүрсээр ижил skeleton) бөгөөд ААН-д хуулийн хэлбэрийн үгийг (`legal-forms.ts`) хасна. Оноо = токений Jaro-Winkler (хос ≥ 0.80), залгасан хэлбэрийн засварын зайн ижилсэл (≥ 0.80, цифр тэнцүү байх), токены цикл эргэлтийн яг тэнцүү (=1)-ийн хамгийн өндөр нь. Engine оноог 4 орон хүртэл бөөрөнхийлж (`quantiseScore`, 1-ээс бага нь 0.9999-өөс хэтрэхгүй) босгоор харьцуулна.

Public API (`matching/index.ts`): `normalizeName`, `normalizeNameForms`, `tokenize`, `jaroWinkler`, `nameSimilarity(a, b, options?)`, `bestNameMatch(subjects, candidates, options?)`, `prepareName(name, options?)`, `bestPreparedMatch(prepared, prepared)`; төрөл `NameMatch`, `PreparedName`, `NameOptions` (`{ legalEntity?: boolean }`). Engine нь нэр бүрийг screening бүрт НЭГ удаа `prepareName` хийж `bestPreparedMatch` ашиглана (UN бүртгэлийн бэлтгэл WeakMap-д cache-лэгдэнэ).

`@los/contracts` нэмж экспортолсон: `isUsableRegisterNo`, `normalizedRegisterNoLength`, `nameTokenCount`, `REGISTER_NO_MAX_LENGTH` (32), `MAX_NAME_TOKENS` (8), `MAX_SUBJECT_NAME_TOKENS` (40). Регистрийн нормчлол нь `@los/database` `normalizeRegisterNo` (Cf устгах → NFKC → том үсэг → NFKC → үсэг/цифр биш бүгдийг устгах → цифр ASCII → look-alike, `Ү→У`); `engine/register-contract-parity.test.ts` contracts-ийн урт тооцоотой тулгана. `engine/subject-names.ts`-ийн `hasScreenableName` нь service-д холбогдсон (нормчлогдоод бүх нэр хоосон бол 400).

## Тест

`pnpm --filter @los/kyc test`. Бодит Postgres-тэй тест (`*.int.test.ts`, `aml.e2e.test.ts`) `DATABASE_URL` өгвөл ажиллана (kyc schema `prisma db push`-аар бэлдсэн байх), өгөөгүй бол алгасна. Эдгээр нь `kyc.aml_hit, aml_screening, blacklist_projection, processed_events, outbox`-ийг **TRUNCATE** хийдэг тул өгөгдлийн сангийн нэрэнд `test` (том/жижиг үсэг ялгахгүй) агуулаагүй бол татгалзана (`test-db.ts`), жнь `DATABASE_URL=postgresql://los@localhost:5432/los_kyc_test`. Файлууд нэг schema-г хуваалцдаг тул `vitest.config.ts`-д `fileParallelism: false` (дарааллаар ажиллана).

## Орчин

| Нэр | Тайлбар |
| --- | --- |
| `INTEGRATION_MODE` | `mock` \| `real`. Тохируулаагүй бол `mock`, гэхдээ `NODE_ENV=production` үед тохируулаагүй бол апп эхлэхэд алдаа (тодорхой `mock` зөвшөөрөгдөнө). `real` нь одоогоор бүх screening-ийг 503 болгоно (Real client хэрэгжээгүй) |
| `NODE_ENV` | `production` үед дээрх хамгаалалт. `turbo.json` `globalEnv`-д ороогүй |
| `PII_HASH_KEY` | Регистрийн HMAC түлхүүр — origination-той **ижил**. Байхгүй бол 500 |
| `DEFAULT_ORG_ID` | `X-Org-Id` ирээгүй үед |
| `AML_LIST_REFRESH_MINUTES` | Cache шинэчлэх давтамж, минут (анхдагч 360); эерэг тоо биш бол апп эхлэхэд алдаа |
| `DATABASE_URL` | Postgres (schema `kyc`) |

`PII_HASH_KEY`, `DEFAULT_ORG_ID`, `AML_LIST_REFRESH_MINUTES` нь `turbo.json` `globalEnv`-д орсон. `.env.example` repo-д **одоогоор байхгүй** (M00-д нэмнэ); хувьсагчийг shell/CI-аар эсвэл `apps/kyc/.env`-ээр (`ConfigModule` нь ажиллах хавтасны `.env`-ийг уншина) өгнө.

## Хязгаарлалт

M00-ийн TODO (`encryptedField`/`decryptedField`/`enqueueOutbox`/event bus) хэрэгжтэл default cipher-ээр `POST /aml/screen` 500 өгнө, relay worker болон `BlacklistProjectionService`-ийн bus-тэй холболт байхгүй. Мэдэгдэж буй хязгаарлалтын бүрэн жагсаалт (нэрийн тулгалт, rescreen, түлхүүр солих, hash backfill) — `docs/05-compliance-aml.md` §10.
