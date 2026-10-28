# BSA · common — дэд бүтцийн adapter-ууд

`infra.ports.ts` дахь port бүрийн хэрэгжүүлэлт. Бусад BSA модуль (import, classify, dti, suspicion) зөвхөн **port + token**-оос хамаарна (`PII_CIPHER`, `OBJECT_STORE`, `EVENT_PUBLISHER`, `IMPORT_QUEUE`, `BSA_SETTINGS`); adapter-ыг энэ хавтас өөрөө угсарна. `persistence/` нь тусдаа (repository).

| Файл | Port / үүрэг | Хэрэгжүүлэлт |
| --- | --- | --- |
| `pii-cipher.ts` | `PiiCipher` (NFR-3) | `AesGcmPiiCipher` (AES-256-GCM + HMAC-SHA256), `createPiiCipher(env)` |
| `object-store.ts` | `ObjectStore` (хуулгын эх файл) | `MinioObjectStore`, `InMemoryObjectStore`, `EncryptingObjectStore` (decorator), `createObjectStore(env)` |
| `event-publisher.ts` | `DomainEventPublisher` (CLAUDE.md §3.2(4)) | `PrismaEventPublisher` (outbox), `InMemoryEventPublisher` (тест), `buildStatementImportedEvent` |
| `import-queue.ts` | `ImportQueue` (BullMQ) | `BullmqImportQueue`, `InlineImportQueue`, `createImportQueue(env)` |
| `request-context.ts` | `RequestContext` (CLAUDE.md §3.2(9)) | `parseRequestContext`, `@Ctx()`, `RequestContextGuard`, `assertCanAccessAnalysis`, `analysisListScope` |
| `settings.ts` | `BsaSettingsProvider` (NFR-6) | `DEFAULT_BSA_SETTINGS`, zod схем, `EnvBsaSettingsProvider`, `CachedBsaSettingsProvider`, `createBsaSettingsProvider(env)` |
| `bsa-common.module.ts` | Нийлүүлэлт | `BsaCommonModule` (global) |
| `env.ts` | env уншигч туслахууд | `EnvConfigError`, `envString`, … |

## Түр шийдэл: `PiiCipher` ба `encryptedField` (M00)

CLAUDE.md §6.5 нь PII-г `@los/database`-ийн `encryptedField`-ээр шифрлэхийг заасан боловч тэр нь M00-д хэрэгжээгүй (`TODO(M00)`). BSA-г түгжихгүйн тулд `AesGcmPiiCipher` нь **өөрийн AES-256-GCM** хэрэгжүүлэлттэй. M00 бэлэн болмогц `createPiiCipher`-ийг `encryptedField`-ээр солих нэг цэг (`bsa-common.module.ts` дахь `PII_CIPHER` provider). Ингэхэд хадгалагдсан өгөгдөл `v1:` угтвараар ялгагдах тул шилжүүлэх (rotate) боломжтой.

## Env хувьсагчид

`NODE_ENV` = `production` үед (мөн бүх орчинд буруу утгатай бол) тохиргоо **app асахад шууд унана** — in-memory/inline орлуулалт зөвхөн үйлдвэрлэлийн бус орчинд. Хоосон утга = тохируулаагүй.

### Нууцлал (`pii-cipher.ts`)
| Хувьсагч | Заавал | Тайлбар |
| --- | --- | --- |
| `PII_ENCRYPTION_KEY` | Тийм (бүх орчинд) | base64, **яг 32 байт**: `openssl rand -base64 32`. Буруу урттай/base64 биш бол `KEY_INVALID`. Түлхүүрээс HKDF-SHA256-оор тусдаа дэд түлхүүр (шифр / hash / файл) гарна |
| `PII_ENCRYPTION_KEY_PREVIOUS` | Үгүй | Таслалаар тусгаарласан хуучин түлхүүрүүд — зөвхөн **тайлахад** |

Түлхүүр солих (rotation): (1) шинэ түлхүүр үүсгэ; (2) хуучныг `PII_ENCRYPTION_KEY_PREVIOUS`-д, шинийг `PII_ENCRYPTION_KEY`-д тавь; (3) мөр бүрт `cipher.needsRotation(v)` → `cipher.rotate(v)`-ээр дахин шифрлэ; hash-аар хайх үед `cipher.hashCandidates(регистр)` (идэвхтэй + хуучин түлхүүрийн hash) ашигла; (4) бүх өгөгдөл шилжсэний дараа хуучин түлхүүрийг хас. **Түлхүүрийг алдвал өгөгдөл сэргээгдэхгүй** — нөөцлөлт нь түлхүүр удирдлагын (secret store) үүрэг.

### Файлын сан (`object-store.ts`)
| Хувьсагч | Заавал | Анхдагч | Тайлбар |
| --- | --- | --- | --- |
| `MINIO_ENDPOINT` | Үйлдвэрлэлд тийм | — | `host:port` (docker-compose: `localhost:9000`) эсвэл `http(s)://host[:port]`. Байхгүй бол **in-memory** store + нэг удаагийн анхааруулга (зөвхөн dev/тест); `NODE_ENV=production` үед алдаа |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Endpoint-тэй бол тийм | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | docker-compose-ийн root хэрэглэгчийг fallback болгоно |
| `MINIO_USE_SSL` | Үгүй | URL-ийн scheme, эс бөгөөс `false` | `true/false/1/0`. URL-ийн scheme-тэй зөрвөл алдаа |
| `MINIO_REGION` | Үгүй | — | Bucket үүсгэх бүс |
| `BSA_BUCKET` | Үгүй | `bsa-statements` | S3 нэршлийн дүрэм (жижиг үсэг, тоо, `-`, `.`; 3–63). Анхны хэрэглээнд автоматаар үүснэ |
| `BSA_OBJECT_MAX_BYTES` | Үгүй | 67108864 (64 MiB) | Нэг объектын дээд хэмжээ (upload-ын бодит хязгаар нь `BSA_MAX_UPLOAD_BYTES`) |

Файл бүр **хадгалахын өмнө шифрлэгдэнэ** (NFR-3): объект бүр санамсаргүй nonce-той AES-256-GCM, объектын түлхүүр AAD-д холбогдсон (blob-ыг өөр түлхүүр рүү зөөвөл `INTEGRITY` алдаа); store-д зөвхөн `application/octet-stream` ciphertext очно. `NODE_ENV=production` үед `PII_ENCRYPTION_KEY`-гүй бол алдаа. Объектын түлхүүр: зөвхөн `[A-Za-z0-9/_.-]`, `..`-гүй, ≤512 тэмдэгт (path traversal хамгаалалт) — **түлхүүрт PII (нэр, регистр) бүү оруул**, `bsa/<org>/<analysisId>/<jobId>` шиг id ашигла.

### Дараалал (`import-queue.ts`)
| Хувьсагч | Заавал | Анхдагч | Тайлбар |
| --- | --- | --- | --- |
| `REDIS_URL` | Үйлдвэрлэлд тийм | — | `redis://[:нууц@]host:port[/db]`. Байхгүй бол процесс доторх **inline** дараалал (дахин асахад ажил алдагдана; зөвхөн dev); `NODE_ENV=production` үед алдаа |
| `BSA_IMPORT_ATTEMPTS` | Үгүй | 3 | Оролдлогын тоо (1–20), экспоненциал backoff |
| `BSA_IMPORT_BACKOFF_MS` | Үгүй | 5000 | Backoff-ийн суурь (мс): 1-р дахин оролдлого ×1, 2-р ×2 … |
| `BSA_IMPORT_CONCURRENCY` | Үгүй | 2 | Нэг процесс дахь зэрэгцээ ажил (1–64) |
| `BSA_IMPORT_QUEUE` | Үгүй | `bsa-import` | BullMQ queue нэр (`:` хориотой) |

BullMQ: `removeOnComplete` 1000 ажил / 7 хоног, `removeOnFail` 5000; `jobId` = `bsa_import_job.id` (давхар enqueue нэг л удаа боловсруулагдана; **алдаатай** ажлыг дахин enqueue хийвэл дахин ажиллана — BSA-FR-2.6). Redis унтарсан үед `enqueue()`/`start()` `ImportQueueError('REDIS_UNAVAILABLE')`-ээр (host:port, нууц үггүй) шууд унана; Redis-д нэг удаа холбогдсоны дараа тасрах бол автоматаар дахин холбогдоно.

Handler-т 2-р аргумент `{ attempt, attempts, isLastAttempt }` өгнө (`AttemptAwareImportQueue`): **сүүлийн оролдлого дээр алдаа гарвал ажлыг FAILED болгох нь handler-ийн үүрэг** (port-ийн handler 1 аргументтай ч хүчинтэй). `NestJS` shutdown-д `close()` (явж буй ажлыг дуусгана) — `main.ts`-д `app.enableShutdownHooks()` хэрэгтэй.

### Хүсэлтийн контекст (`request-context.ts`)
| Хувьсагч | Тайлбар |
| --- | --- |
| `DEFAULT_ORG_ID` | `X-Org-Id` толгой байхгүй үед (анхдагч `org-default`) |

Толгой: `X-User-Id` (заавал, байхгүй/буруу → **401**), `X-Roles` (таслалаар; хоосон эсвэл `UserRole`-д байхгүй → **403**), `X-Branch-Id`, `X-Org-Id`, `X-Correlation-Id` (байхгүй/буруу бол үүсгэнэ). Мессеж монгол. Controller-д: `@UseGuards(RequestContextGuard)` + `@Ctx() ctx: RequestContext`.

Хандалт (`decideAnalysisAccess` / `assertCanAccessAnalysis`; жагсаалтад `analysisListScope`): `ADMIN`, `APPROVER` — байгууллагын бүх салбар; `BRANCH_MANAGER` — өөрийн салбар; `OFFICER` — өөрийн салбар **ба** `createdBy === userId`. **Өөр байгууллага ямар үүрэгтэй ч 404** (оршихыг задруулахгүй, байхгүй шинжилгээтэй ижил хариу); салбар/үүсгэгч `null` бол таарахгүй.

### BSA тохиргоо (`settings.ts`)
Анхдагч утга **зөвхөн** `DEFAULT_BSA_SETTINGS`-д (ББӨ 0.10, maxDti 0.55, түвшин 0.35/0.55, бусад 0.30, [3,6,12], 6 сар, 3 жил, жин 0.4/0.4/0.2, зөрүү 0.01, `WARN`, 20 MiB, 10 файл). Env-ээр дарна; буруу утга **constructor дээр** хувьсагчийн нэртэйгээр унана. Нэг org-ийн утга 60 секунд cache-лэгдэнэ (CLAUDE.md §3.2(8)); буцаах объект deep-frozen.

| Хувьсагч | Талбар |
| --- | --- |
| `BSA_COST_OF_GOODS_RATE` | `costOfGoodsRate` ББӨ 0..1 (BSA-BR-1) |
| `BSA_MAX_DTI` | `maxDti` (0, 1] (BSA-BR-2) |
| `BSA_DTI_LOW_MAX`, `BSA_DTI_MEDIUM_MAX` | `dtiLevelThresholds` (`lowMax ≤ mediumMax`) |
| `BSA_OTHER_SHARE_THRESHOLD` | `otherShareThreshold` 0..1 (BSA-BR-7) |
| `BSA_ALLOWED_PERIOD_MONTHS` | `allowedPeriodMonths`, таслалаар, жишээ `3,6,12` (BSA-BR-3) |
| `BSA_MIN_STATEMENT_MONTHS` | `minStatementMonths` (BSA-FR-2.2) |
| `BSA_RETENTION_YEARS` | `retentionYears` (BSA-BR-8) |
| `BSA_BUSINESS_INCOME_CODES`, `BSA_IRREGULAR_INCOME_CODES` | Ангиллын кодын жагсаалт (давхцаж болохгүй) |
| `BSA_RELIABILITY_WEIGHT_FREQUENCY`, `BSA_RELIABILITY_WEIGHT_CONSISTENCY`, `BSA_RELIABILITY_WEIGHT_CLEANLINESS` | `reliabilityWeights` — нийлбэр 1 (нэгийг солих бол гурвыг хамт) |
| `BSA_BALANCE_TOLERANCE` | `balanceTolerance` ≥ 0 |
| `BSA_PUSH_POLICY` | `pushPolicyWhenPendingSuspicious`: `WARN` \| `BLOCK` (BSA-FR-5.3) |
| `BSA_MAX_UPLOAD_BYTES`, `BSA_MAX_FILES_PER_UPLOAD` | Upload хязгаар |
| `BSA_SETTINGS_CACHE_TTL_MS` | Cache хугацаа (анхдагч 60000; 0 = cache-гүй) |

`TODO(M13)`: origination.settings-ийн projection/GET client-ийг `BsaSettingsOverrideSource` интерфэйсээр `createBsaSettingsProvider(env, { source })`-д залгана (`OverriddenBsaSettingsProvider` нь хэсэгчилсэн дарагчийг бүтнээр нь дахин шалгана).

### Тест
```
cd apps/scoring && npx vitest run src/modules/bsa/common/<файл>.test.ts      # unit (сүлжээ, DB, Redis шаардахгүй)
REDIS_URL_TEST=redis://127.0.0.1:6379 npx vitest run src/modules/bsa/common/import-queue.integration.test.ts
TEST_DATABASE_URL=postgresql://…/los_test npx vitest run src/modules/bsa/common/event-publisher.integration.test.ts
```
- `REDIS_URL_TEST` — зөвхөн `import-queue.integration.test.ts`; тохируулаагүй бол алгасагдана. Тест бүр өөрийн BullMQ prefix-тэй, дуусахад зөвхөн тэр түлхүүрүүдийг устгана (DB-г FLUSH хийхгүй).
- `TEST_DATABASE_URL` — зөвхөн `event-publisher.integration.test.ts` (`scoring.outbox`-ийг TRUNCATE хийнэ → DB-ийн нэрэнд `test` байх ёстой; persistence тесттэй ижил дүрэм).
- `MinioObjectStore` нь fake client-ээр шалгагдсан (бодит MinIO-гүй орчин); `NotFound`/`NoSuchKey`/`BucketAlreadyOwnedByYou` кодыг `minio@8` эх кодоос баталгаажуулсан. Бодит MinIO-той smoke тест: `docker compose up -d minio`, `MINIO_ENDPOINT=localhost:9000`.
- `BullmqImportQueue` ийм нэмэлт тохиргоотой (код дотор, env-гүй): `enqueueTimeoutMs` (10с — Redis хариулахгүй үед HTTP хүсэлт өлгөгдөхгүй), `lockDurationMs` (120с — урт parse-д ажил "stalled" болж давхар ажиллахаас сэргийлнэ), `connectTimeoutMs` (5с), `prefix`.

## Аюулгүй байдлын дүрэм
- Лог/алдааны мессежид PII, түлхүүр, нууц үг, Redis URL, объектын түлхүүр, ciphertext **орохгүй** (тест шалгана). Дарааллын алдаа логт зөвхөн класс/код (`Error(PARSE_FAILED)`).
- Event-д зөвхөн id/тоо/төлөв (`StatementImported`); zod схемээс гадуурх талбар outbox-д хадгалагдахгүй.
- `PrismaEventPublisher` нь `createMany({ skipDuplicates })` (ON CONFLICT DO NOTHING) ашиглана: `create` + P2002 барьвал PostgreSQL-ийн транзакц "aborted" болж бизнес мөрүүд мөн унадаг.
- Fixture/тестийн өгөгдөл бүхэлдээ хуурмаг (synthetic).
