# esign

FR-11.4 цаасгүй гэрээ: зээлийг батлагдсаны дараа зээлдэгч салбарт ирэлгүй утсан дээрээ линк нээж, гэрээний PDF-ийг уншаад **Tridum** эсвэл **Monpass**-аар цахим гарын үсэг зурна.
DMS нь PDF дээр QR код + гарын үсгийн штамп тавьж, гарын үсэгтэй PDF ба `.p7s`-ийг файл санд хадгалан `ContractSigned` event гаргана.

## Урсгал
```
Ажилтан (web) ─► gateway ─► origination POST /contracts/:applicationId/esign
                              │ sync REST (origination → dms ЗӨВХӨН)
                              ▼
                   dms POST /api/esign/requests ──► PENDING, нэг удаагийн линк (токен)   [ContractSigningRequested]
 SMS(линк) ◄── origination
 Зээлдэгч утас ─► web /sign/[token] ─► gateway /api/public/esign/** (JWT-гүй, rate limit) ─► dms /api/public/esign/**
     GET :token → харагдац · GET :token/document → PDF (үзсэн гэж тэмдэглэнэ) · POST :token/start {provider, consent} → provider session
     (зээлдэгч Tridum/Monpass апп дээр баталгаажуулна) · GET :token/status poll ЭСВЭЛ provider webhook POST callback/:provider
 dms finalize: гарын үсэг + регистр + гэрчилгээ шалгах → QR+штамп → гарын үсэгтэй PDF + .p7s хадгалах → SIGNED   [ContractSigned → origination G4]
 PDF дээрх QR ─► web /verify/[code] ─► gateway ─► dms GET /api/public/esign/verify/:code
```
Сервисүүд бие биенээ дуудахгүй: origination → dms (sync) ба dms → origination (зөвхөн event). Хэрэглэгчийн PDF provider рүү явахгүй — зөвхөн **SHA-256 hash** (remote signing).

## HTTP (global prefix `/api`)

### Дотоод (origination → dms; gateway-ийн ажилтны proxy-д ХААЛТТАЙ — `/api/dms/esign/**` нь 404). Толгой: `X-User-Id`, `X-Org-Id`, `X-Roles` (main-ийн `CommonModule` guard: байхгүй бол 401), `X-Correlation-Id`.
Эрх: `application:write` (create, resend, cancel), `application:read` (get, list, татах). Бүх уншилт байгууллагаар (`X-Org-Id`) хязгаарлагдана — өөр байгууллагын id нь `404`. Create-ийн body-д `orgId` байхгүй.
| Method, зам | Үүрэг | Хариу |
| --- | --- | --- |
| `POST /esign/requests` | `CreateSigningRequest` (@los/contracts) → хүсэлт + нэг удаагийн линк | `201` `SigningRequestView` + `signingUrl` |
| `GET /esign/requests?applicationId=` | Хүсэлтийн түүх (шинэ нь түрүүлж) | `200` `SigningRequestView[]` |
| `GET /esign/requests/:id` | Нэг хүсэлт | `200` `SigningRequestView` |
| `POST /esign/requests/:id/resend` | Токен шинэчилнэ (хуучин линк тэр даруй үхнэ), хугацаа сунгана | `200` + шинэ `signingUrl` |
| `POST /esign/requests/:id/cancel` | PENDING \| IN_PROGRESS → CANCELLED (давтахад өөрчлөлтгүй) | `200` |
| `GET /esign/requests/:id/signed-document` | Гарын үсэгтэй PDF (`attachment`, `application/pdf`); татсан нь audit-д | `200` / `409` SIGNED биш |
| `GET /esign/requests/:id/signature` | Provider-ийн CMS `.p7s` (`application/pkcs7-signature`) | `200` / `409` |

### Зээлдэгчийн (public, JWT-гүй; эрх = токен). Бүх хариу `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`
| Method, зам | Үүрэг | Хариу |
| --- | --- | --- |
| `GET /public/esign/verify/:code` | QR-ийн баталгаажуулалт (`XXXX-XXXX-XXXX`, зураасгүй, жижиг үсэг ч болно). Регистр/утас/файлын id **гарахгүй** | `200` `SigningVerification` / `404` |
| `POST /public/esign/callback/:provider` | Provider webhook (`tridum` \| `monpass`, ЖИЖИГ үсэг). `req.rawBody`-оор HMAC шалгана | `204` / `401` (дэлгэрэнгүйгүй) / `404` / `503` (түр алдаа — provider дахин илгээнэ) |
| `GET /public/esign/:token` | `PublicSigningSession` харагдац. Хугацаа дууссан бол `status: EXPIRED` (200) | `200` |
| `GET /public/esign/:token/document` | Эх гэрээний PDF (`inline` stream). Нээсэн нь "үзсэн" болно — start-ын урьдчилсан нөхцөл | `200` / `410` |
| `POST /public/esign/:token/start` | `{ provider, consent: true, consentVersion }` (хувилбар session-ий `consentVersion`-тэй таарах ёстой, үгүй бол `CONSENT_VERSION_MISMATCH` 400) → provider session (PENDING → IN_PROGRESS), `challengeCode`, `deepLink` | `200` / `400` / `409` / `410` / `502` |
| `GET /public/esign/:token/status` | Poll: IN_PROGRESS үед provider-оос асууж, SIGNED бол finalize хийнэ | `200` / `503` |
| `POST /public/esign/:token/decline` | Зээлдэгч татгалзана (provider session нээлттэй үед) | `200` / `409` |
| `GET /public/esign/:token/signed-document` | Гарын үсэгтэй PDF (`attachment`); линкийн хугацаа дуусаагүй байхад | `200` / `409` / `410` |

`verify/:code`, `callback/:provider` нь `:token` route-уудаас **өмнө** зарлагдсан. Path параметрийн хэлбэр (токен 43 тэмдэгт base64url, код 12 тэмдэгт Crockford, provider, uuid) буруу бол service-д хүрэхгүй `404`.

### Алдааны бие — `{ code, message, reason?, issues? }`
`message` нь монгол, хэрэглэгчид харуулахад аюулгүй. Анхны алдааны мессеж, стек, оролтын утга (регистр, утас, токен), provider/DB-ийн дэлгэрэнгүй **хэзээ ч** гарахгүй.
| Статус | `code` | Хэзээ |
| --- | --- | --- |
| 400 | `SIGNING_VALIDATION` + `reason` (`DOCUMENT_NOT_VIEWED`, `CONSENT_REQUIRED`, `PROVIDER_NOT_ALLOWED`, `NOT_A_PDF`, `SOURCE_FILE_NOT_FOUND` …) | Бизнесийн шалгалт |
| 400 | `REQUEST_INVALID` + `issues: [{ path, code }]` | zod / буруу JSON / буруу `X-User-Id`. `issues` нь талбарын зам + төрөл — утга биш |
| 401 | `SIGNING_WEBHOOK_REJECTED` | Webhook-ийн гарын үсэг буруу / rawBody байхгүй |
| 404 | `SIGNING_NOT_FOUND` | Үл мэдэгдэх БА шинэчлэгдсэн токен (хоёр тохиолдолд бие нь яг ижил), буруу хэлбэр, үл мэдэгдэх id/код |
| 409 | `SIGNING_CONFLICT` + `reason` (`ACTIVE_EXISTS`, `INVALID_STATE`) | Нэг гэрээнд идэвхтэй хүсэлт байна / төлөвт тохирохгүй үйлдэл |
| 410 | `SIGNING_GONE` + `reason` (`EXPIRED`, `TERMINAL`) | Линк үхсэн |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | body-parser (100 KB) |
| 429 | `SIGNING_TOO_MANY_ATTEMPTS` | `ESIGN_MAX_ATTEMPTS` хэтэрсэн |
| 502 | `SIGNING_PROVIDER_UNAVAILABLE` | Provider дуудлага амжилтгүй |
| 503 + `Retry-After: 5` | `SIGNING_FINALIZATION_FAILED` | Finalize-ийн түр алдаа; хүсэлт IN_PROGRESS руу буцсан, дараагийн poll/webhook/sweeper дахин оролдоно |
| 500 | `INTERNAL_ERROR` | Танигдаагүй алдаа. Лог-д зөвхөн `{event, errorName, errorCode?, method, route, correlationId}` |

## Төлвийн машин (`domain/status-machine.ts`)
```
PENDING     → IN_PROGRESS | EXPIRED | CANCELLED
IN_PROGRESS → FINALIZING | PENDING | DECLINED | EXPIRED | CANCELLED | FAILED
FINALIZING  → SIGNED | FAILED | IN_PROGRESS
```
* `PENDING → IN_PROGRESS`: зээлдэгч гэрээг үзээд зөвшөөрч provider сонгосон (`start`).
* `IN_PROGRESS → FINALIZING → SIGNED`: provider гарын үсэг буцаасан; `FINALIZING` нь штамп хийх үеийн түр түгжээ.
* `IN_PROGRESS → PENDING`: provider session дууссан/алдаатай ч линк хүчинтэй, оролдлого үлдсэн — зээлдэгч дахин сонгоно (`providerRef`, `challengeCode`, `deepLink` цэвэрлэгдэнэ). Татгалзсан (`DECLINED`) бол буцахгүй.
* `FINALIZING → IN_PROGRESS`: штамп/хадгалалтын түр алдаа — дараагийн poll/webhook/sweeper дахин оролдоно. Байнгын алдаа (`IDENTITY_MISMATCH`, `INTEGRITY_ERROR`) → `FAILED`.

Төгсгөл: `SIGNED`, `DECLINED`, `EXPIRED`, `FAILED`, `CANCELLED` — цаашид шилжихгүй; дахин илгээх = ШИНЭ хүсэлт (түүх хадгалагдана). Нэг гэрээнд идэвхтэй (PENDING \| IN_PROGRESS \| FINALIZING) хүсэлт ганц: `409`, эсвэл `supersedeActive: true` бол хуучин нь CANCELLED + audit `SUPERSEDED`.
Бүх шилжилт `SigningStore.transition` (compare-and-set) дамжина: poll, webhook, sweeper зэрэг өрсөлдөхөд яг нэг нь хожиж, `ContractSigned` ЯГ нэг гарна.

## Env
| Хувьсагч | Default | Тайлбар |
| --- | --- | --- |
| `INTEGRATION_MODE` | `mock` | `mock` \| `real`. `NODE_ENV=production` үед `mock` нь **эхлэхэд алдаа** |
| `ESIGN_PUBLIC_BASE_URL` | `http://localhost:3000` | Вэб origin: зээлдэгчийн линк `…/sign/<token>`, QR `…/verify/<code>`. Production-д https заавал |
| `ESIGN_CALLBACK_BASE_URL` | `http://localhost:4000/api` | Provider webhook дуудах gateway-ийн public суурь. Production-д https заавал |
| `ESIGN_LINK_TTL_HOURS` | `72` | Линкийн хугацаа (1–168); хүсэлтээр `ttlHours` дарна |
| `ESIGN_SESSION_TTL_SECONDS` | `300` | Provider session (30–3600); линкийн үлдсэн хугацаанаас хэтрэхгүй |
| `ESIGN_MAX_ATTEMPTS` | `3` | Зээлдэгчийн provider session эхлүүлэх дээд оролдлого (1–10) |
| `ESIGN_SWEEP_INTERVAL_SEC` | `60` | Sweeper-ийн интервал; `0` = унтраасан |
| `ESIGN_FINALIZING_STALE_SEC` | `300` | FINALIZING-д энэ хугацаанаас илүү гацсаныг sweeper дахин оролдоно |
| `ESIGN_SIGNED_COPY_TTL_DAYS` | `30` | Гарын үсэгтэй хувийг зээлдэгч линкээр татаж болох хугацаа (1–365), линкийн хугацаа дууссан ч |
| `DATA_ENCRYPTION_KEY[S]`, `DATA_INDEX_KEY` | — | `@los/database` (Модуль 0): регистр/утсыг AES-256-GCM (AAD `dms.signing_request`)-ээр шифрлэнэ |
| `MOCK_ESIGN_APPROVE_AFTER_MS` | `3000` | Mock зээлдэгч session нээснээс хойш хэдэн мс-д батлах |
| `MOCK_ESIGN_WEBHOOK_SECRET` | dev утга | Mock webhook HMAC-ийн нууц (≥16 тэмдэгт) |
| `TRIDUM_BASE_URL`, `TRIDUM_CLIENT_ID`, `TRIDUM_CLIENT_SECRET`, `TRIDUM_WEBHOOK_SECRET` | — | `real` горимд. `MONPASS_*` ижил |
| `DATABASE_URL`, `STORAGE_DRIVER`, `MINIO_*`, `OUTBOX_RELAY`, `REDIS_URL` | — | Модуль 0-ийн дараах нийтлэг тохиргоо (`docs/00-foundation.md`, `../file/README.md`) |
| `DMS_PORT` | `4005` | |

Тохиргооны алдаа апп эхлэхэд л гарна (чимээгүй fallback байхгүй); мессеж нь env-ийн НЭР-ийг л хэлнэ. `INTEGRATION_MODE`, `MOCK_ESIGN_*`, `TRIDUM_*`, `MONPASS_*`-ийг `EsignModule.register()` дуудагдах үед уншдаг тул `AppModule`-д `ConfigModule.forRoot()`-ийн ДАРАА байх ёстой (`.env`-ийн дараа). Бусад env provider factory-д апп босох үед уншигдана; Health: `/api/health` (liveness), `/api/health/ready` (DB + MinIO).

## Mock provider (`INTEGRATION_MODE=mock`)
Үр дүн **регистрийн сүүлийн 2 цифрээр**, цаг нь инжектлэсэн `Clock`-оор (deterministic):
| Сүүлийн 2 цифр | Үр дүн |
| --- | --- |
| бусад | `MOCK_ESIGN_APPROVE_AFTER_MS`-ийн дараа батлана (SIGNED) |
| `00` | Зээлдэгч татгалзана (DECLINED) |
| `99` | Хэзээ ч батлахгүй — session хугацаа дуусна; линк хүчинтэй бол PENDING руу буцна |
| `55` | Provider алдаа `MOCK_PROVIDER_ERROR` (линк хүчинтэй бол PENDING руу буцна) |
| `77` | SIGNED боловч гэрчилгээний регистр зөрнө → FAILED `IDENTITY_MISMATCH` |
| `11` | SIGNED боловч гарын үсэгт орсон hash зөрнө → FAILED `INTEGRITY_ERROR` |

Mock гарын үсэг нь тодорхой хуурамч (`MOCK-CMS` + JSON + HMAC), баталгаажуулах боломжгүй; гэрчилгээ олгогч `LOS MOCK CA (ТЕСТ)`; PDF дээр хуудас бүр "ТЕСТ — ХҮЧИНГҮЙ" ус тэмдэг, verify хариунд `mock: true`. Deep link `mock-tridum://` / `mock-monpass://`.
Dev endpoint (зөвхөн mock + `NODE_ENV!=production`): `POST /api/dev/esign/mock/:providerRef/approve|decline` — `providerRef` нь `deepLink`-ийн төгсгөл. Webhook-д `x-mock-signature: hex(HMAC-SHA256(rawBody, MOCK_ESIGN_WEBHOOK_SECRET))`, бие `{"providerRef":"…"}`.

## Аюулгүй байдал
* **Токен**: 32 санамсаргүй байт → base64url (43 тэмдэгт). DB-д зөвхөн `sha256(token)`. Токен ЗӨВХӨН create/resend-ийн хариуны `signingUrl`-д; лог/audit/event-д орохгүй. Resend хуучныг тэр даруй хүчингүй болгоно; үл мэдэгдэх ба хуучин токен нь ижил `404`.
* **Webhook**: provider-ийн adapter гарын үсгийг **ИЛГЭЭСЭН байтаар** (`req.rawBody`; `main.ts` `rawBody: true`, `app.setup.ts`) шалгана. Webhook-ийн биеийн төлөвт итгэхгүй — зөвхөн `providerRef` авч provider-оос дахин асууна. Баталгаажсан боловч үл мэдэгдэх session → `204` (хүчинтэй ref таах боломж өгөхгүй). JSON/urlencoded биш бие → rawBody байхгүй → `401`.
* **PII**: регистр, утас `@los/database` `encryptedField`-ээр (AAD `dms.signing_request`) шифрлэгдэж DB-д; хариу, лог, audit, event-д зөвхөн далдалсан хэлбэр (`УА****5678`, `+976 ****2233`, `Б. Болд`). Алдааны хариу оролтын утгыг дахин харуулахгүй; танигдаагүй алдааны мессеж лог-д бичигдэхгүй.
* **Бүрэн бүтэн байдал**: хүсэлт үүсэх үед эх PDF-ийн SHA-256 хадгалагдаж provider-д очно; зээлдэгчид үзүүлэх, finalize хийх бүрд файлыг дахин унших ба hash зөрвөл татгалзана. Finalize: hash, гэрчилгээний регистр (латин/кирилл look-alike нормчилсон, тогтмол хугацаат тулгалт), гэрчилгээний хүчинтэй хугацаа, гарын үсгийн цаг (зөвшөөрлөөс өмнө/ирээдүйд биш) шалгана.
* **Public хариу**: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` (алдаанд ч). PDF-ийн `Content-Disposition` нь кирилл нэрийг RFC 5987-оор (`filename*`) дамжуулна.
* **Холболтын мета** (audit-д л): IP = gateway-ийн тавьсан `X-Forwarded-For`-ийн ЭХНИЙ hop (IP биш бол сокетын хаяг), User-Agent 255 тэмдэгтээр таслагдана. dms нь gateway-ийн ард дотоод сүлжээнд байх ёстой — гаднаас шууд хандах боломжтой бол `X-Forwarded-For`, `X-User-Id`-д итгэж болохгүй (CLAUDE.md §3.2.9).
* **Эрх**: `/api/esign/**` нь `@Permissions('application:read|write')` + `X-Org-Id` байгууллагын хязгаар. Gateway нь энэ замыг ажилтны proxy-гоор гаргадаггүй — origination л дуудна. Public замууд `@Public()`; ирсэн `X-User-Id` үл тооно — үйлдэл `BORROWER` гэж бичигдэнэ.

## Шинэ provider нэмэх
1. `@los/contracts` `ESignProvider` enum-д код нэм (web-ийн i18n нэр, `PROVIDER_KEYS` мөн).
2. `integrations/<name>/<name>.mock.ts` (`MockRemoteSigner`-ээс удамшуулж) ба `<name>.real.ts` (`ESignProviderPort`: `createSession`, `getSession`, `cancelSession`, `parseWebhook`) бич. `parseWebhook` нь гарын үсэг/нууц буруу бол `ESignProviderError('INVALID_WEBHOOK')` шидэж, зөвхөн `providerRef` буцаана. `real` нь тохиргоо дутуу бол `NOT_CONFIGURED`, webhook-ийг ХЭЗЭЭ Ч зөвшөөрөхгүй (fail closed).
3. `integrations/esign/integrations.module.ts`-ийн `buildProviders`-д mock/real хоёуланг нэм; `real-config.ts`-д `RealProviderPrefix` нэм.
4. Webhook зам автоматаар `callback/<код жижиг үсгээр>` болно (`params.ts` нь `ESignProvider`-оос үүсгэнэ); gateway-ийн `ProviderPipe`-д мөн нэм.
5. Тест: mock-ийн fixture, `integrations.module.test.ts`, e2e-д provider-ийн жишээ урсгал.

## Тест
`pnpm --filter @los/dms test` — нэгж + HTTP (memory store) тестүүд. DB-тэй тестүүд `TEST_DATABASE_URL` (нэр нь `test`-ээр төгссөн DB) байхгүй бол алгасагдана (`docs/00-foundation.md` §4):
`TEST_DATABASE_URL=postgresql://los@localhost:5432/los_dms_test REDIS_URL=redis://localhost:6379/1 pnpm --filter @los/dms test`.
| Файл | Хамрах |
| --- | --- |
| `http/esign.e2e.test.ts` | Бүтэн урсгал (Tridum poll, Monpass dev approve, webhook), татгалзах, хугацаа дуусах, давхар хүсэлт/supersede, resend, ажилтны татаж авалт, outbox event, PII-гүй хариу/лог. memory store, mock provider, удирдаж болох цаг |
| `http/esign.http.e2e.test.ts` | Эрх/контекст (401/403/байгууллагын тусгаарлалт), параметр/биеийн шалгалт, алдааны хөрвүүлэлт, кэшгүй толгой, холболтын мета |
| `http/esign.prisma.e2e.test.ts`, `stores/prisma-signing.store.test.ts` | Бодит Postgres: DB шифрлэлт, зэрэгцээ create/poll+webhook, `dms.file` + object storage |
| `http/*.test.ts`, `domain/*.test.ts` | filter, pipe, толгойн задлалт, төлвийн машин, токен, штамп гэх мэт нэгж тест |
| `esign.module.test.ts` | Wiring, production тохиргооны хамгаалалт, sweeper |

## Үлдсэн ажил
* `docs/06-esign-open-items.md`.
* dms-д файл оруулах HTTP endpoint (document/template модуль, Модуль 9/11): `sourceFileId`-ийг гэрээ үүсгэгч (docx→PDF) гаргах ёстой. Тэр хүртэл main-ийн `POST /api/files`-аар PDF оруулна.
* `real` provider-ууд (Tridum, Monpass) STUB: албан ёсны API гэрээ, sandbox эрх, CA trust anchor байхгүй тул `NOT_IMPLEMENTED` — `integrations/*/*.real.ts`-ийн TODO.
