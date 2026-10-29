# bsa/import: импортын pipeline ба application service-үүд

Банкны хуулгын шинжилгээ (BSA, `docs/02-bsa-requirements.md`) ба OCR-ийн **application + HTTP давхарга**: хуулга хүлээн авах, дараалалд
оруулах, parse -> verify -> хадгалах -> ангилах -> DTI тооцоолох, гараар засах, LOS руу татах, хадгалах хугацаа дуусахад устгах.
REST controller-ууд `http/` дотор (угтвар `/api`, `configureBsaApp`), DTO нь `@los/contracts/src/bsa.ts` дахь strict zod схем
(`http/zod-validation.pipe.ts`). Нийт тойм, архитектур, API, тохиргоо, хязгаар: **`docs/05-bsa-ocr.md`**.

> **Анхааруулга (TODO(samples))**: бодит банкны хуулга байхгүй. Parser-ууд (Khan, Golomt, TDB, Xac, Capitron, State, MBank) зөвхөн
> SYNTHETIC хуулгаар шалгагдсан. Тестийн «банк танилт», «үлдэгдлийн гинж», «DTI» нь бодит хуулгад ажиллана гэсэн баталгаа БИШ.
> Бодит дээжээр баталгаажтал ажлууд `UNVERIFIED_PARSER` анхааруулгатай COMPLETED болно.

## Бүрэлдэхүүн

| Файл | Үүрэг | Шаардлага |
| --- | --- | --- |
| `analysis.service.ts` | Шинжилгээ үүсгэх/харах/жагсаах, параметр засах, устгах, ажил/гүйлгээ/түүх унших | BSA-FR-1.x, NFR-4 |
| `upload.service.ts` | Олон файл хүлээн авах, sha256 давхардал, object store, дараалал, `retryJob` | BSA-FR-2.1, 2.6 |
| `import-pipeline.service.ts` | Нэг ажлын бүтэн гүйцэтгэл (дараах «Pipeline») | BSA-FR-2.2..2.4, 3.1, 3.2, 4 |
| `import.processor.ts` | Дарааллын worker: ажил бүрийг pipeline-д өгч, FAILED-д `UnrecoverableError` шидэнэ | NFR-8 |
| `recalculation.service.ts` | Хураангуй (INT-4) ба тайлан (`details`) дахин тооцоолох, scoring input | BSA-FR-4.x |
| `reclassify.service.ts` | Гараар ангилал солих, ижил гүйлгээнд хэрэглэх, дүрэм санал болгох/үүсгэх | BSA-FR-3.4, 3.5 |
| `finalize.service.ts` | `ANALYZED` болгож LOS руу татах хураангуй буцаах; scoring input | INT-4 |
| `retention.service.ts` | Хадгалах хугацаа (`retentionYears`) дууссан шинжилгээг устгах | NFR-5 |
| `access.ts`, `masking.ts`, `views.ts` | Хандалтын шийдвэр, далдлалт, хариуны харагдац | NFR-3 |
| `period.ts`, `timeout.ts`, `parse-input.ts` | Хугацааны шийдэл (MONTHS / EXPLICIT / AUTO), deadline, оролтын шалгалт | BSA-FR-1.3, 4.2 |
| `import.issues.ts`, `import.errors.ts`, `import.events.ts` | Тогтмол монгол мессеж, HTTP алдаа, түүхийн үйлдлийн нэр | NFR-3, NFR-4 |
| `import.defaults.ts` | Техникийн хязгаар (бизнесийн босго БИШ), `Clock` | -- |
| `suspicion.counter.ts` | Сэжигтэй гүйлгээний модулийн порт (`SUSPICION_COUNTER`) | BSA-FR-5.x |
| `canonical-json.ts` | Түлхүүрийн дарааллаас үл хамаарах JSON харьцуулалт (Postgres `jsonb` дарааллыг хадгалдаггүй) | -- |
| `http/` | 4 controller (`BsaAnalysesController`, `BsaJobsController`, `BsaCatalogController`, `BsaAdminController`), `RolesGuard`, `ZodValidationPipe`, `BsaExceptionFilter`, `CorrelationInterceptor`, `BsaUploadInterceptor`, `configureBsaApp` | BSA-FR-1..6, INT-1..6 |
| `e2e/` | HTTP e2e (supertest, ЖИНХЭНЭ `BsaModule`): in-memory + бодит Postgres/Redis (гейттэй) | -- |
| `testing/` | Тестийн harness, SYNTHETIC хуулга үүсгэгч, зорилтот сценари | -- |

`BsaModule` (`../bsa.module.ts`) нь дээрх service-үүдийг `common` (дэд бүтэц), `persistence`, `parsers`, `text-extraction`, `classify`,
`dti` модулиудтай нэг дор угсарч export хийнэ. `app.module.ts` зөвхөн `BsaModule`-ийг import хийнэ.

## REST маршрут ба үүрэг (`http/`)

Угтвар `/api`. Gateway толгой: `X-User-Id` (заавал, 401), `X-Roles` (403), `X-Org-Id`, `X-Branch-Id`, `X-Correlation-Id`. `RolesGuard` deny-by-default:
`@Roles` заагаагүй handler 403 (`http/roles.test.ts` 21 маршрутыг бүгдийг шалгана). Хүрээ (салбар/өөрийн/байгууллага) нь service-д (`access.ts`).

| Арга | Зам | Үүрэг | Амжилт |
| --- | --- | --- | --- |
| POST | `/bsa/analyses` | OFFICER, BRANCH_MANAGER, ADMIN | 201 |
| GET | `/bsa/analyses` | бүх үүрэг | 200 |
| GET | `/bsa/analyses/:id` (тойм) | бүх үүрэг | 200 |
| DELETE | `/bsa/analyses/:id` (зөвхөн DRAFT) | OFFICER, BRANCH_MANAGER, ADMIN | 200 |
| GET | `/bsa/analyses/:id/history` | бүх үүрэг | 200 |
| POST | `/bsa/analyses/:id/imports` (multipart `files`, `banks`) | OFFICER, BRANCH_MANAGER, ADMIN | 202 / 200 |
| GET | `/bsa/analyses/:id/imports` | бүх үүрэг | 200 |
| POST | `/bsa/analyses/:id/recalculate` | OFFICER, BRANCH_MANAGER, ADMIN | 200 |
| GET | `/bsa/analyses/:id/transactions` | бүх үүрэг | 200 |
| GET | `/bsa/analyses/:id/breakdown` | бүх үүрэг | 200 |
| POST | `/bsa/analyses/:id/reclassify` | OFFICER, BRANCH_MANAGER, ADMIN | 200 |
| POST | `/bsa/analyses/:id/finalize` | OFFICER, BRANCH_MANAGER, ADMIN | 200 |
| GET | `/bsa/analyses/:id/summary` | бүх үүрэг | 200 |
| GET | `/bsa/analyses/:id/scoring-input` | бүх үүрэг | 200 |
| GET | `/bsa/jobs` | бүх үүрэг | 200 |
| GET | `/bsa/jobs/:id` | бүх үүрэг | 200 |
| POST | `/bsa/jobs/:id/retry` | OFFICER, BRANCH_MANAGER, ADMIN | 202 |
| GET | `/bsa/categories` | бүх үүрэг | 200 |
| GET / POST | `/bsa/rules` | ADMIN | 200 / 201 |
| POST | `/bsa/admin/retention/run` | ADMIN | 200 |

APPROVER зөвхөн уншина. Өөр байгууллага 404, өөр салбар/өөр ажилтан 403.

### Семантик (хэрэгжүүлэлтийн шийдвэрүүд)

- **Upload**: хязгаар (`maxUploadBytes`, `maxFilesPerUpload`) хүсэлт бүрт `BsaSettings`-ээс (multer memory storage). Файл бүр бие даан шийдэгдэж
  `outcomes[i]` = `ACCEPTED | DUPLICATE | REJECTED`. Нэг ч файл дараалалд орвол 202, бүгд давхардсан бол 200, **бүгд татгалзагдвал HTTP алдаа**
  (415 `FILE_UNSUPPORTED`/`XLSX_UNSUPPORTED`, 413 `FILE_TOO_LARGE`, 400 `FILE_EMPTY`/`INVALID_BANK`/`NO_FILES`/`TOO_MANY_FILES`/`UNEXPECTED_FILE_FIELD`/`INVALID_MULTIPART`,
  503 `QUEUE_UNAVAILABLE`/`STORAGE_FAILED`) ба `details.outcomes`. Queue унасан бол ажил `FAILED (QUEUE_UNAVAILABLE)`; `POST /bsa/jobs/:id/retry`-ээр сэргээнэ.
- **Recalculate**: параметртэй бие -> `updateParams` (зөвхөн DTI, `reclassified: null`); хоосон бие -> ангилал + DTI бүгд (`reclassified: n`).
  ANALYZED шинжилгээнд `repushRequired: true`.
- **Finalize**: `{summary, warnings, pushedToLosAt, firstTime}`. `NO_COMPLETED_IMPORT` 422, `JOBS_IN_PROGRESS` 409, `BLOCK` бодлого + хүлээгдэж буй сэжигтэй дохио -> 422
  `PENDING_SUSPICIOUS_BLOCK` (`details.pendingSuspiciousCount`). `scoring-input` зөвхөн ANALYZED (409 `NOT_ANALYZED`).
- **Reclassify**: `CATEGORY_INVALID` 400 (ангилал/чиглэл таарахгүй), `TRANSACTION_NOT_FOUND` 404. `suggestedRule` ХАДГАЛАГДАХГҮЙ: ADMIN `POST /bsa/rules`-оор баталгаажуулна
  (давхардал 409 `RULE_DUPLICATE`, аюултай regex 400 `RULE_INVALID`).
- **Summary**: импорт болгоны дараа хураангуй `DRAFT`-аар хадгалагдах тул `GET :id/summary` import-ын дараа 200; импортгүй шинжилгээнд 404 `SUMMARY_NOT_AVAILABLE`.
  `summaryStale` нь хадгалсан ба шинэ хураангуйг `canonicalJson`-оор (түлхүүр эрэмбэлсэн) харьцуулна.
- **Алдааны хэлбэр**: `{statusCode, code, message (монгол), details?, issues?[{path, code}], correlationId}`; `correlationId` үргэлж, `X-Correlation-Id` хариу толгойд.
  Framework-ийн англи текст, оруулсан утга, PII хариунд орохгүй.

## Pipeline (нэг ажил)

```
upload -> [object store: put] -> [DB tx: import job + түүх] -> [queue: enqueue]
queue -> ImportProcessor.handle(jobId, attempt) -> ImportPipelineService.processJob
   1. ажлыг PROCESSING болгох (дахин оролдлого: хадгалсан банкыг дахин ашиглана)
   2. object store-оос унших -> текст (PDF текст давхарга / OCR / CSV)        [extractTimeoutMs]
   3. банк тодорхойлох (parser registry) эсвэл гараар заасан банк
   4. parse -> verify (үлдэгдлийн гинж, мөрийн тоо, огноо, QR)                [БҮГД амжихгүй бол мөр хадгалахгүй]
   5. НЭГ DB транзакцид: мөр (chunk) + өөрийн данс + ангилал + DTI + ажил COMPLETED + түүх + outbox event StatementImported
```

- **Тодорхой (deterministic) алдаа** (баталгаажуулалт, банк танигдаагүй, PDF нууцлагдсан, мөр хэт олон, `IMPORT_TIMEOUT`): ажил `FAILED`,
  **мөр хадгалагдахгүй**, дахин оролдохгүй. Хэрэглэгч `retryJob` дуудна (шаардвал `bankCode` өөрчилнө).
- **Түр/гэнэтийн алдаа** (DB, object store, parser-ийн гэнэтийн алдаа): дахин шидэж queue дахин оролдуулна (`attempts`, backoff). Эцсийн
  оролдлого дээр ажил `INTERNAL_ERROR`-оор `FAILED` болж event нэг л удаа гарна.
- **Давхцсан хуулга** (BSA-FR-2.4): гүйлгээ бүр `(analysis, dedupe_key)`-ээр нэг л удаа хадгалагдана; давхцал `ROWS_SKIPPED_DUPLICATE`
  анхааруулга (давхцсан мөрийн тоотой) болно. `rowsDone` = боловсруулсан мөр, `StatementImported.rows` = шинээр хадгалагдсан мөр.
- **Өөрийн шилжүүлэг** (BSA-BR-5): нэг харилцагчийн хоёр данс хоорондын шилжүүлгийг хоёр талаас нь тэмдэглэж, орлого/зардлаас хасна.
- **Атомчлал**: бичилт бүгд нэг транзакцид тул дундаас унавал мөр, хураангуй, түүх, `COMPLETED` event юу ч үлдэхгүй (бодит PostgreSQL дээр
  `import-pipeline.integration.test.ts`-ээр шалгасан).

BullMQ `err.name === 'UnrecoverableError'`-ийг дахин оролдохгүй тул processor `FAILED` үр дүнд `ImportJobFailedError` (нэр нь
`UnrecoverableError`) шидэнэ. `InlineImportQueue` (тест/dev) энэ нэрийг мэдэхгүй тул `attempts` удаа дахин дуудна; дараагийн дуудлага
`ALREADY_FAILED` гэж алгасаж, давхар event гаргахгүй.

## Хандалт (docs/01 §3)

Үүргийн (маршрут тутам) шалгалт `http/roles.ts` дахь `RolesGuard`; доорх нь service давхаргын хүрээ/эзэмшигчийн шалгалт.

| Үйлдэл | Хэн |
| --- | --- |
| Унших | ADMIN, APPROVER (байгууллагын даяар); BRANCH_MANAGER (өөрийн салбар); OFFICER (өөрийн салбар **ба** өөрийн үүсгэсэн) |
| Бичих (үүсгэх, upload, retry, recalc, reclassify, finalize, устгах) | ADMIN, BRANCH_MANAGER, OFFICER (APPROVER-ийн үүргийг хасаж шалгана) |
| Дүрэм үүсгэх / дүрмийн сан унших | зөвхөн ADMIN |
| Ангиллын жагсаалт | бүх үүрэг |
| Өөр байгууллагын (`orgId`) шинжилгээ | үргэлж `NotFound` (оршихыг задруулахгүй) |

Үүргийн шалгалт Nest `ForbiddenException`, шинжилгээ олдохгүй/өөр байгууллага нь `NotFoundException` (`common/request-context.ts`).
Салбарыг зөвхөн ADMIN сонгоно: бусад үүргийн хувьд шинжилгээ үүсгэх салбар `X-Branch-Id` толгойгоос, body-ийн `branchId` үл тооцогдоно.
Service метод бүрийн матриц: `authorization.test.ts` (үүрэг x салбар x эзэмшигч x байгууллага).

## Тохиргоо

Бизнесийн бүх босго `BsaSettings`-ээс (`BSA_SETTINGS`): `costOfGoodsRate`, `allowedPeriodMonths`, `minStatementMonths`, `maxFilesPerUpload`,
`maxUploadBytes`, `retentionYears`, `balanceTolerance`, `pushPolicyWhenPendingSuspicious` гэх мэт. Кодонд тогтмол утга байхгүй.

Техникийн хязгаар (`import.defaults.ts`, env-ээр дарна; буруу утга app асахад `EnvConfigError`):

| Env | Анхдагч | Утга |
| --- | --- | --- |
| `BSA_IMPORT_MAX_ROWS` | 50000 | Нэг файлын гүйлгээний дээд тоо (`TOO_MANY_ROWS`) |
| `BSA_IMPORT_EXTRACT_TIMEOUT_MS` | 180000 | Текст гаргах дээд хугацаа |
| `BSA_IMPORT_JOB_TIMEOUT_MS` | 300000 | Нэг ажлын нийт дээд хугацаа (`IMPORT_TIMEOUT`) |
| `BSA_IMPORT_CHUNK_ROWS` | 500 | Нэг багцын мөр (явцын шинэчлэлт) |
| `BSA_RETENTION_BATCH` | 100 | Нэг гүйлтэд устгах шинжилгээний тоо |
| `BSA_RETENTION_INTERVAL_MS` | 0 | Retention таймер; 0 = унтраалттай (гаднаас `purgeExpired`) |

`main.ts`: `enableShutdownHooks()` (queue явж буй ажлыг дуусгаад хаагдана, дараа нь Prisma салгагдана) ба бие хэмжээний хязгаар.

## Хугацаа ба DTI

- `periodMonths` = хүссэн сар. Горим: `MONTHS` (хуулгын хамрах хугацаа дуусах цэгт төгсөх сүүлийн N сар; сарын сүүлийн өдөр бол N бүтэн сар),
  `EXPLICIT` (огнооны муж, хамрах хугацаанд тайрна), `AUTO` (хугацаа өгөөгүй: зөвшөөрөгдсөн сарын жагсаалтаас `minStatementMonths`-ээс багагүй хамгийн бага нь).
- Хамрах хугацааны төгсгөл = COMPLETED ажлуудын хамгийн сүүлийн `periodTo`; шаардсан сар = `max(minStatementMonths, хүссэн)`.
- Заасан муж хамрах хугацаанаас гадуур бол бүх хамрах хугацаанд буцаж, `PERIOD_OUTSIDE_COVERAGE` анхааруулга өгнө.
- `dtiIncome = verifiedMonthlyIncome x (1 - costOfGoodsRate)`; `DTI = (санал болгосон төлбөр + одоогийн өр) / dtiIncome`.

## Хадгалах хугацаа (NFR-5)

`RetentionService.purgeExpired()`: org бүрийн `retentionYears`-аас хугацаа хэтэрсэн шинжилгээг олж, **эхлээд DB-ээс (cascade) устгаад
commit хийж, дараа нь** object store-оос файлуудыг устгана (best effort). Дундаас унавал өгөгдөл DB-д үлдэхгүй, гэхдээ файл өнчирч болно
(object store-д жагсаалт байхгүй тул одоогоор prefix sweep байхгүй). Дүн: `{examined, purged, objectsDeleted, objectFailures}`.
`subtractYears` 2-р сарын 29-ийг 28 болгож хадгалах хугацааг хэзээ ч богиносгохгүй.

## PII (NFR-3)

Файлын нэр, регистр, данс, нэр, гүйлгээний утга, OCR текст лог, `errors_json`/`warnings_json`, түүх, domain event, алдааны мессежид ОРОХГҮЙ.
Тэдгээрт зөвхөн код, тоо, id, хуудас/мөрийн дугаар. Мессеж бүр код тутамд тогтмол монгол текст (parser/verifier-ийн англи текстийг хаяна).
Лог `describeError` (класс + код)-оор. Хариуны харагдац регистр/данс/утсыг далдална (`******0203`). `pii.test.ts` нь амжилт, алдаа, дэд бүтцийн
саатал, administration замуудыг хуурамч PII тэмдгээр шүүнэ (ба тэр шалгалт бодитоор унаж чадахыг mutation-ээр шалгасан).

## Тест

```
cd apps/scoring && npx vitest run src/modules/bsa            # DB/Redis шаардахгүй (интеграцийн тест skip)
cd apps/scoring && npx vitest run src/modules/bsa/import/e2e  # HTTP e2e (in-memory)
cd apps/scoring && npx eslint src
```

Хоёр сценари хоёр дансны жишээ (`testing/scenario.ts`): 18 + 9 мөр, нэг шилжүүлгийн хос, DTI гараар тооцоолсон 39.0% (MEDIUM),
Түрээсийг `IRREGULAR_INCOME` болгоход 50.9%.

Бодит дэд бүтэцтэй (заавал биш, env-ээр нээгдэнэ; өгөгдөлгүй бол алгасна):

| Тест | Env | Агуулга |
| --- | --- | --- |
| `import-pipeline.integration.test.ts` | `TEST_DATABASE_URL` | `PrismaBsaRepository` + outbox: DTI, PII шифр, давхцал, атомчлал, зэрэгцээ upload, retention cascade, 2 x 1250 мөр |
| `import-worker.integration.test.ts` | `REDIS_URL_TEST` | BullMQ: end-to-end, түр алдааны дахин оролдлого, `UnrecoverableError`, `retryJob` |
| `e2e/bsa-api.integration.e2e.test.ts` | `TEST_DATABASE_URL` + `REDIS_URL_TEST` (+ заавал биш `DATA_ENCRYPTION_KEY`/`DATA_INDEX_KEY`) | HTTP e2e бодит Prisma + BullMQ + AES-GCM: бүтэн урсгал, мөрийн тоо, outbox, DB-ийн түүхий мөрөнд PII ил байхгүй, давхардал/tamper/retry/cascade |

Бэлтгэл: vitest globalSetup (`test/global-setup.ts`) `scoring` schema-г baseline + BSA migration-оор шинээр үүсгэнэ (`apps/scoring/prisma/README.md`). DB-ийн нэр `test`-ээр төгснө (TRUNCATE хийнэ).
**Бодит DB-тэй тестүүд файлаар дарааллаж ажиллана** (`@los/config` nest preset `fileParallelism: false` — тэдгээр нэг DB-г TRUNCATE хийдэг): `pnpm exec vitest run src/modules/bsa`. Persistence гэрээний тест,
event-publisher integration тест, энэ unit-ийн тест нэг DB-г TRUNCATE хийдэг тул зэрэгцээ ажиллахад бие биенийхээ өгөгдлийг устгана.

## Мэдэгдэж буй хязгаар

- `details` (дэлгэрэнгүй тайлан) хадгалагдахгүй: `summary_json`-ийн схем үл мэдэгдэх түлхүүрийг хасдаг тул `report()` бүрт дахин тооцоолно.
- **PDF + зураг давхар тоологдоно**: `common/persistence/dedupe-key.ts` нь нормчилсон тайлбарыг hash-д оруулдаг тул OCR-ээр тайлбар нь өөр болсон мөр
  ижил PDF-ийн мөртэй давхцахгүй (туршилтаар 27 гүйлгээний оронд 33). `STATEMENT_OVERLAP` анхааруулга гарна. Засвар persistence/pipeline дотор (энэ unit-ийн гадна).
- Parser-ийн `REGISTRY_DEFAULTS`/`COVERAGE_DEFAULTS`/`VERIFY_DEFAULTS` (зөвхөн `balanceTolerance`-оос бусад) env/`BsaSettings`-ээс тэжээгддэггүй.
- Upload-ийн санах ой ≈ `maxUploadBytes × maxFilesPerUpload` (memory storage). OFFICER-ийн `GET /bsa/jobs` нь шинжилгээ тутамд ≤1000 ажил нэгтгэнэ.
- `SuspicionCounter` анхдагчаар 0 (`NullSuspicionCounter`) тул `BLOCK` бодлого сэжигтэй гүйлгээний модуль бодит counter өгөх хүртэл хаахгүй.
- Зэрэгцээ redelivery үед `StatementImported` давхар гарч болзошгүй; эцсийн оролдлогын DB алдааны дараа ажил `PROCESSING`-д гацаж болзошгүй;
  `PENDING` ажлыг дахин дараалалд оруулах sweeper байхгүй.
- FAILED ажлын файлыг дахин upload хийвэл `DUPLICATE` болно (`retryJob` ашигла).
