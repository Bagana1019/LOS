# E-sign (FR-11.4) — үлдсэн ажил

Төлөв: Модуль 0-ийн суурь дээр (`@los/nest-common` guard/filter/context, `@los/database` encryptedField + outbox + idempotentHandler, gateway JWT + proxy, `dms.file` + MinIO) бүрэн суулгасан.
`apps/dms` (`modules/esign`, `integrations/{esign,tridum,monpass}`), `apps/origination` (`modules/contract`), `apps/gateway` (`modules/public-esign`), `apps/web` (`/sign/[token]`, `/verify/[code]`, `ContractSigningPanel`), `packages/contracts` (`dto/esign.ts`, 3 event). Migration нь зөвхөн incremental (dms `…_esign`, origination `…_contract_esign`).

## Хүний оролцоо шаардсан (кодоор шийдэгдэхгүй)
1. **Tridum / Monpass бодит API** — албан ёсны гэрээ, sandbox эрх, CA trust anchor, webhook баталгаажуулалтын схем, гэрчилгээнд регистр хадгалах талбар. `real` adapter-ууд `NOT_CONFIGURED`/`NOT_IMPLEMENTED` (fail closed).
2. **Хууль зүйн хяналт** — гарын үсэг нь provider-ийн detached CMS (`.p7s`) + PDF дээрх штамп/QR; embedded PAdES БИШ. Цахим гарын үсгийн тухай хууль, provider-ийн магадлан итгэмжлэл, "үзсэн + зөвшөөрсөн" аудитын хүчин төгөлдөр байдлыг production-оос өмнө батлуулна.
3. **SMS adapter** — origination-д `MockSigningLinkNotifier`; production/`real` горимд `UnconfiguredSigningLinkNotifier` (503). Бодит adapter-ыг notification модуль (M13) эзэмшинэ. Текст: илгээгчийн нэр, "бусдад бүү дамжуул", хугацааны цаг нэмэх.
4. **Гэрээний загвар (docx→PDF, M11)** PDF-ийн баруун доод буланг (захаас 8–26 мм) QR-д чөлөөтэй үлдээх ёстой; нууцлагдаагүй (encrypted биш) байх ёстой.

## Код — мэдэгдэж буй, хийгээгүй
* **origination**: `createRequest`-ийн хариу (timeout 3с) алдагдвал dms-д идэвхтэй хүсэлт үлдэж, өөрийн `contract` мөрд тэмдэглэгдээгүй байна → дараагийн `start` 409 ("идэвхтэй хүсэлт"), `resend/cancel` "идэвхтэй хүсэлт байхгүй" гэнэ (линкийн хугацаа дуустал, анхдагч 72ц). Засвар: dms-ийн `GET /api/esign/requests?applicationId=`-оор орфан хүсэлтийг олж adopt + resend. (Автоматаар `supersedeActive` хэрэглэхгүй — давхар дарахад 2 SMS, эхнийх нь үхнэ.)
* **origination**: `contract.signing_status` нь `PENDING` + төгсгөлийн төлвүүдийг л тусгана (`IN_PROGRESS`/`FINALIZING`-г `GET …/esign` dms-ээс шууд авна).
* **web**: `ContractSigningPanel` wizard-ийн `contract` алхамд холбогдоогүй (Модуль 2/11); staff API нь web-ийн нэвтрэлтийн клиент (Bearer) бэлэн болоход толгойг нэмнэ.
* **gateway**: in-memory rate limiter (instance бүр тусдаа) — олон instance-д Redis-ээр солино. `ThrottlerGuard`-ийн Redis storage орох үед нэгтгэнэ.
* **dms**: орфан signed файл цэвэрлэх (DMS-д delete API байхгүй); `file` retention (M11).
* **gateway CORS**: `enableCors` (`packages/nest-common/src/bootstrap.ts`) `exposedHeaders` тохируулаагүй тул веб (өөр origin) `Retry-After`, `Content-Disposition`-ийг уншиж чадахгүй — 429 дээр `EsignApiError.retryAfterMs` үргэлж `null`, шалгагдсан хугацаа биш экспоненциал backoff ажиллана. Засвар: `exposedHeaders: ['Retry-After', 'Content-Disposition']`.
* **gateway + web**: `ReviewStep`-ийн PDF `<iframe>` нь gateway-ийн origin-оос ачаалагддаг, харин gateway `helmet()` нь `X-Frame-Options: SAMEORIGIN` / `frame-ancestors 'self'` тавьдаг тул өөр origin-ийн вэб (`localhost:3000` ↔ `:4000`) iframe-д харуулж чадахгүй; «Бүтнээр нээх» холбоос л ажиллана. Засвар: `/api/public/esign/:token/document` хариунд `frame-ancestors <WEB_ORIGIN>` тавих (бусад зам хэвээр).
* **Event relay**: `OUTBOX_RELAY=off`/Redis-гүй орчинд `ContractSigned` origination-д очихгүй → G4 (олголт) нээгдэхгүй. Production-д Redis заавал.
