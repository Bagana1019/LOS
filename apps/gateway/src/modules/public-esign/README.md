# public-esign

**Зээлдэгчийн (JWT-гүй) public e-sign proxy — FR-11.4** (цаасгүй гэрээ). Ажилтны proxy (`../proxy`) өөрчлөгдөөгүй.

Зээлдэгч LOS-ийн хэрэглэгч биш: утсан дээрх `web /sign/[token]` хуудас `GET|POST /api/public/esign/**`-ийг JWT-гүй дууддаг.
Gateway rate limit хийж, параметрийг шалгаад dms-ийн `/api/public/esign/**` руу дамжуулна (dms нь дотоод сүлжээнд, `DMS_URL`, default `http://localhost:4005`).
Глобал `JwtAuthGuard`-аас `@Public()`-ээр, глобал `ThrottlerGuard`-аас `@SkipThrottle()`-ээр гарч, доорх өөрийн rate limit-ээр хязгаарлагдана.

## Route (dms-тэй яг ижил зам; бүгд `@Public()`)

| Gateway `/api/public/esign/…` | dms | Rate бүлэг | Бие (max) |
| --- | --- | --- | --- |
| `GET verify/:code` | ижил | read | — |
| `POST callback/:provider` (provider webhook) | ижил | webhook | 64 KB, байтаар |
| `GET :token` | ижил | read | — |
| `GET :token/document` (PDF stream) | ижил | read | — |
| `POST :token/start` | ижил | action | 8 KB |
| `GET :token/status` (poll) | ижил | poll | — |
| `POST :token/decline` | ижил | action | 8 KB |
| `GET :token/signed-document` (PDF stream) | ижил | read | — |

`verify/…`, `callback/…` нь `:token` route-уудаас өмнө зарлагдсан. Query string дамжихгүй.

## Ажилтны proxy-д хаалттай замууд
`/api/dms/esign/**` (origination л дуудна: гэрээний төлөв, хүрээ шалгасны дараа), `/api/dms/public/**`, `/api/dms/dev/**` → 404 (`../proxy/route-policy.ts` `isInternalOnly`; задлах/`//`/том жижиг үсгээр тойрохыг хаасан).

## Параметрийн шалгалт (dms руу очихгүй 404)
* `token` `^[A-Za-z0-9_-]{43}$` · `code` Crockford base32 `^[0-9A-HJKMNP-TV-Z]{12}$`; `XXXX-XXXX-XXXX` хэлбэрийг зураасгүй болгож дамжуулна · `provider` `^(tridum|monpass)$` (жижиг үсэг).
* Буруу бол `404 {code:'NOT_FOUND'}`. Шалгалт нь rate limit-ийн ДАРАА тул буруу параметртэй хүсэлт ч тоологдоно (токен таамаглахыг хязгаарлана).

## Толгойн бодлого
* Энгийн route: dms руу **зөвхөн** `content-type` (бие байгаа үед), `x-correlation-id` (клиентийнх `^[A-Za-z0-9._:-]{1,128}$` бол, үгүй бол шинэ UUID), `x-forwarded-for` (жинхэнэ клиент IP). `cookie`, `authorization`, `x-user-id`/`x-roles`/`x-org-id`/`x-internal-token` ХЭЗЭЭ Ч дамжихгүй.
* Webhook: provider-ийн гарын үсгийн толгой хэрэгтэй тул denylist — hop-by-hop, `cookie`, `host`, `content-length`, `content-encoding`, `accept-encoding`, `x-forwarded-*`/`forwarded`/`x-real-ip`, дотоод итгэмжлэлийн толгойнуудаас бусдыг дамжуулна. Gateway нь `bodyParser: false` тул бие байт хэвээр, хязгаартай уншигдаж дамжина — HMAC-ийг dms шалгана. Шахсан (`content-encoding`) бие → 415.
* Клиентийн IP: Express `req.ip`. `TRUST_PROXY` (`configure.ts`) тохируулаагүй бол сокетын хаяг — клиентийн X-Forwarded-For-д итгэхгүй.
* Хариу: статус, `content-type`, `content-disposition`, `content-length` (бие шахагдаагүй үед), `x-correlation-id` дамжина. `set-cookie`, `location`, `server`, upstream-ийн `cache-control` гарахгүй. **Хариу бүрд** (алдаа ч) `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
* PDF нь buffer-лэгдэхгүй stream-ээр дамжина; клиент таслагдвал dms руу хүсэлт ч таслагдана. dms-ийн redirect (3xx) → 502.

## Алдаа — `{ code, message }` (message монгол, дотоод мэдээлэлгүй)
`NOT_FOUND` 404 · `RATE_LIMITED` 429 (+`Retry-After`) · `PAYLOAD_TOO_LARGE` 413 · `UNSUPPORTED_MEDIA_TYPE` 415 · `UPSTREAM_UNAVAILABLE` 502 · `INTERNAL_ERROR` 500.
dms-ийн өөрийн 4xx/5xx хариу (статус + бие) хэвээр дамжина. Timeout: толгой 15 с; JSON/webhook нийт 15 с; PDF нийт 120 с. Лог: `{event, route, correlationId, reason}` — токен, URL, толгой бичигдэхгүй.

## Rate limit (in-memory — `rate-limiter.ts`; instance бүр тусдаа тоолно)
Тогтмол 60 с-ийн цонх, түлхүүр = `бүлэг + клиент IP` (IPv6 нь /64-өөр нэгдэнэ). Түлхүүрийн тоо хязгаартай (50k).

| Бүлэг | Хязгаар/мин | Env |
| --- | --- | --- |
| read (verify, `:token`, document, signed-document) | 60 | `ESIGN_RATE_LIMIT_PER_MIN` |
| poll (`status`) | 60 | `ESIGN_RATE_LIMIT_PER_MIN` |
| action (`start`, `decline`) | min(10, `ESIGN_RATE_LIMIT_PER_MIN`) | — |
| webhook | 600 НИЙТ (IP тус бүрээр хязгаарлахгүй) | `ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN` |

Анхаар: Монголын гар утасны оператор CGNAT ашигладаг тул олон зээлдэгч нэг IP-ээс харагдаж болно — шаардлагатай бол `ESIGN_RATE_LIMIT_PER_MIN`-ийг өсгө.

## Env
`DMS_URL` (default `http://localhost:4005`) · `ESIGN_RATE_LIMIT_PER_MIN` (60) · `ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN` (600) · `TRUST_PROXY`. Буруу утга бол эхлэхэд алдаа.

## Тест
`public-esign.proxy.test.ts` — supertest + ephemeral порт дээрх хуурамч dms (зам/method, параметр, толгой, webhook байт, PDF stream, 429, 502, timeout, хэмжээний хязгаар). `test/public-esign.e2e.test.ts` — бодит gateway AppModule (JWT/throttler-тэй) дээр public зам JWT-гүй, ажилтны proxy-д dms-ийн дотоод замууд хаалттай (DB шаардана).
