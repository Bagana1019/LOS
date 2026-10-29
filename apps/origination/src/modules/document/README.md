# document (origination) — хүсэлтийн баримт бичиг, 8-р алхам

**Шаардлага:** FR-9.1 (баримт хавсаргах: төрөл, холбогдох зүйл, тайлбар, файл; ажилтан, огноо автоматаар), FR-9.2 (бүтээгдэхүүний checklist-ээр хангагдсан эсэх, 8-р алхам `document`).
Гарын авлага: `docs/05-collateral-documents.md` §3.2. Файл, баримтын мөр нь **dms**-ийнх (`apps/dms/src/modules/document/README.md`); энд зөвхөн хүсэлтийн хүрээ, төлөв,
checklist-ийн дүгнэлт, алхмын төлөв, OCR тулгалт.

## API (`/api/applications/:aid/documents`)

| Метод · зам | Эрх | Тайлбар |
| --- | --- | --- |
| `GET …/documents` | OFFICER (өөрийн), BRANCH_MANAGER (салбар), APPROVER, ADMIN | `ApplicationDocumentsResponse`: `items`, `checklist` (мөр бүр `satisfied`, `documents`), `extras`, `summary` |
| `POST …/documents` | OFFICER (өөрийн), ADMIN | `AttachDocumentRequest` → **201** `ApplicationDocumentMutationResponse` (`document` + шинэ `documents`) |
| `DELETE …/documents/:docId` | OFFICER (өөрийн), ADMIN | **200** `ApplicationDocumentMutationResponse` (`document: null`) |
| `POST …/documents/:docId/ocr` | OFFICER (өөрийн), ADMIN | **200** `DocumentOcrCheck`, `Cache-Control: no-store` |

Хүрээг `ApplicationAccessService` шийднэ (NFR-3): өөр ЗЭЗ / өөр салбар 403, байхгүй эсвэл өөр байгууллагын хүсэлт 404 `APPLICATION_NOT_FOUND`.
Бичих нь зөвхөн **DRAFT | RETURNED** төлөвт (409 `APPLICATION_NOT_EDITABLE`, `details.status`); унших, OCR тулгалт аль ч төлөвт.

## Урсгал

```
POST → эрх, төлөв → бүтээгдэхүүний checklist → холбоосыг шалгах → dms.create (HTTP, түгжээгүй)
     → богино транзакц: хүсэлтийг FOR UPDATE, төлөвийг дахин шалгах, аудит DOCUMENT_ATTACHED
     → reconcile: dms.list → түгжээд алхмыг бичих → dms.list дахин → зөрсөн бол давт (≤ MAX_RECONCILE_ATTEMPTS)
```

* **Түгжээ дор HTTP дуудахгүй.** dms руу дуудлага бүгд түгжээнээс гадна; `document` алхмыг үргэлж dms-ийн ШИНЭ жагсаалтаас (хуучин snapshot-оос биш) тооцно.
  Бичсэний дараа жагсаалтыг дахин уншиж, хооронд өөрчлөгдсөн бол давтана (хязгаартай — гацахгүй). Зэрэг attach/remove нь эцэст нь dms-ийн жагсаалттай нийцнэ.
* **Нөхөн цуцлалт:** dms-д бичигдсэн ч хүсэлт хаагдсан/алга болсон бол (`confirm` унасан) dms-ийн баримтыг буцааж устгаад алдааг дамжуулна — өнчин баримт үлдэхгүй.
* **remove:** баримт энэ хүсэлтийнх эсэхийг dms-ийн жагсаалтаар баталгаажуулна (өөр хүсэлтийн баримт 404 `DOCUMENT_NOT_FOUND`, dms руу устгал очдоггүй). dms-д аль хэдийн устсан (зэрэг устгал) бол алдаагүй, үр дүн адил.
* **Subscriber** (`document-events.subscriber.ts`): `DocumentUploaded`/`DocumentRemoved` ирэхэд алхмыг дахин тооцно — attach/remove дунд унасан, эсвэл dms-д өөр эх сурвалжаар орсон баримтыг барих нөөц.
  `idempotentHandler` (`processed_events`), consumer group **`origination-documents`**. Үл мэдэгдэх хүсэлт, өөр байгууллага, `applicationId = null`, засагдахгүй төлөв → чимээгүй алгасна;
  dms унавал алдаа шидэж bus дахин хүргэнэ. Event-д хэрэглэгч байхгүй тул dms-ийг үйлчилгээний хэрэглэгчээр (`SERVICE_PRINCIPAL`, ADMIN, `application:read`) дууддаг.

> **Яагаад тусдаа consumer group?** `createRedisEventBus.subscribe` нь өөрт хамааралгүй төрлийн мессежийг XACK-аар устгадаг. CLAUDE.md §3.1-ийн "group = сервисийн нэр"-ээр
> `origination` group-д хоёр subscriber (гэрээ, баримт) байвал бие биенийхээ event-ийг залгина. Тусдаа group тус бүр stream-ийн бүх мессежийг авна.

## Checklist ба 8-р алхам (FR-9.2)

Checklist = `product.document_checklist_json`: `[{ key, name, required }]` (`document-checklist.ts`, цэвэр функц).

* **Нормчлол:** `key`, `checklistKey`, `type` → trim, NFC, жижиг үсэг, дотоод зай `_` (`ID Card` ≡ `id_card`). Бүтээгдэхүүний давхардсан түлхүүр нэг болно.
* **Хангагдсан:** мөрөнд ядаж нэг баримт (`checklistKey` таарсан). `type` нь checklist-ийн түлхүүртэй давхцвал тэр мөрийг хангана (`type: "id_card"` ≡ `checklistKey: "id_card"`).
* **extras:** түлхүүргүй баримт (`type: other`, чөлөөт төрөл) — checklist-ийг хангахгүй, харин жагсаалтад харагдана. Барьцааны (`COLLATERAL`) баримт хүсэлтийн checklist/items/extras-д **орохгүй**.
* **summary:** `{ productMissing, required, satisfied, complete, missing[] }`; `complete = бүтээгдэхүүнтэй && шаардлагатай бүх мөр хангагдсан`. Сонголттой (`required: false`) мөр алхмыг хаахгүй.
* **Бүтээгдэхүүн байхгүй** (4-р алхам дутуу): `productMissing: true`, хоосон checklist, `complete: false` — алхам PENDING. Төрлөөр (`type`) хавсаргаж болно; `checklistKey` өгвөл 422 `UNKNOWN_CHECKLIST_KEY` (`allowedKeys: []`).
* **Буруу checklist JSON** (хэлбэр эвдэрсэн): "бүгд эсвэл юу ч үгүй" — хоосон checklist гэж үзэж `op: checklist.invalid` анхааруулга логлоно (productId-тай, PII-гүй) (алдаа биш). `null` → хоосон, шаардлагагүй бүтээгдэхүүн (`complete: true`).
* **Алхам:** `complete` бол `COMPLETED` (+ `completed_at`), үгүй бол `PENDING`. `LOCKED` алхамд хэзээ ч хүрэхгүй; алхмын мөр байхгүй бол юу ч хийхгүй; `document`-ээс бусад алхамд хүрэхгүй;
  хүсэлт засагдахгүй төлөвт (SUBMITTED, …) алхмыг хөдөлгөхгүй.

## Холбоос (`relatedEntity`)

| Утга | Дүрэм |
| --- | --- |
| `APPLICATION` (анхдагч) | `relatedId` өгч болохгүй (422 `RELATED_ID_NOT_ALLOWED`) |
| `BORROWER` | `relatedId` заавал (422 `RELATED_ID_REQUIRED`), тэр харилцагч ЭНЭ хүсэлтийн оролцогч (аль ч дүр) байх (422 `BORROWER_NOT_ON_APPLICATION`) |
| `COLLATERAL` | 422 `USE_COLLATERAL_DOCUMENTS` — барьцааны баримт `…/collaterals/:cid/documents`-оор (Модуль 6); энэ endpoint-оор хасах ч боломжгүй |

Бусад кодууд: 400 `VALIDATION_FAILED` (`AttachDocumentRequest`), 422 `UNKNOWN_CHECKLIST_KEY` (`details.allowedKeys`), 422 `DOCUMENT_TYPE_REQUIRED`, 422 `FILE_NOT_FOUND` (файл байхгүй/устсан/өөр байгууллагын — dms),
404 `DOCUMENT_NOT_FOUND`, 502/504 `UPSTREAM_ERROR` (dms унасан). Мессеж монголоор, `code` тогтвортой.

## OCR тулгалт (`POST …/documents/:docId/ocr`)

**Зөвхөн `checklistKey = id_card`** баримтад (бусад → `NOT_APPLICABLE`, dms-д хандахгүй). Иргэний үнэмлэхийн регистрийг dms OCR-аар уншиж зээлдэгчийнхтэй тулгана:
баримт `BORROWER`-т холбогдсон бол тэр зээлдэгчтэй, хүсэлтийн түвшний баримт бол ҮНДСЭН зээлдэгчтэй (үндсэн зээлдэгчгүй бол 422 `PRIMARY_BORROWER_MISSING`; холбогдсон зээлдэгч хасагдсан бол 422 `BORROWER_NOT_ON_APPLICATION`).

| `verdict` | Утга |
| --- | --- |
| `MATCH` | OCR-ийн регистр = зээлдэгчийн регистр (`normalizeRegisterNo` + `blindIndex` тэнцэл) |
| `MISMATCH` | таарахгүй — анхааруулга нэмэгдэнэ |
| `UNREADABLE` | файл уншигдсангүй (төрөл, текст, хэмжээ), эсвэл регистр олдсонгүй — алдаа биш, хүн гараар шалгана |
| `NOT_APPLICABLE` | `id_card` биш баримт |

* **Зөвлөмж** — юу ч хадгалахгүй, баримт, алхам, аудитыг өөрчлөхгүй. Хүн баталгаажуулна; хүсэлтийг хаахгүй.
* **PII:** хариунд зөвхөн OCR-аар уншсан регистрийн **далдлагдсан** хэлбэр (`УБ****0001`, `maskRegisterNo`), итгэл, `docType`, анхааруулга. Түүхий регистр, OCR-ийн текст, нэр хэзээ ч
  буцаахгүй, логлохгүй, хадгалахгүй (`DmsDocumentOcr` zod нь бусад талбарыг хаяна). Лог: `{ op, applicationId, documentId, verdict, correlationId }`. Engine-ийн анхааруулгад регистр орсон бол хасна.
* dms-ийн OCR 4xx (`UNSUPPORTED_MIME`, `EMPTY_RESULT`, `NO_FIXTURE`, хэт том, буруу оролт) → `UNREADABLE`; dms түр завгүй (429) → 429 `OCR_BUSY`; унасан → 502/504.
  OCR-ийн timeout 15с (`DMS_OCR_TIMEOUT_MS`, `DEMO:` бодит хөдөлгүүрээр хэмжиж засна), бусад дуудлага 3с.

## Порт ба зохион байгуулалт

| Файл | Үүрэг |
| --- | --- |
| `document-checklist.ts` | Цэвэр: `parseProductChecklist`, `buildApplicationDocuments`, `planDocumentStep`, `sameDocuments`, `normalizeKey` |
| `document-ocr.ts` | Цэвэр: `compareRegisterNo`, `evaluateIdCardOcr`, монгол мессежүүд |
| `dms-documents.port.ts` | `DmsDocumentsPort` {create, list, remove, ocr} + `DMS_DOCUMENTS` токен, `DmsDocumentOcr` zod |
| `http-dms-documents.port.ts` | Бодит HTTP: `InternalHttpClient` (X-* толгой, зөвхөн GET retry, redirect дагахгүй), нэмэлт `delete()`. Лог: `{ op, status, correlationId }` — body-г логлохгүй |
| `testing/fake-dms-documents.ts` | e2e-ийн fake (build-д ордоггүй): dms-ийн дүрмийг дагана, `failNext`, `beforeList`, `afterCreate`, `insertDirect` зэрэг зэрэг-өөрчлөлт дуурайх hook |
| `document.service.ts` | `ApplicationDocumentService`: list, attach, remove, ocrCheck, recomputeFromEvent, reconcile |
| `document-events.subscriber.ts` | `DocumentUploaded`/`DocumentRemoved` → алхмын нөөц дахин тооцоолол |

Аудит (`recordAudit`, entity `DOCUMENT`): `DOCUMENT_ATTACHED` / `DOCUMENT_REMOVED` — зөвхөн `{ documentId, fileId, checklistKey, relatedEntity, relatedId }`. Тайлбар (`note`), файлын нэр, чөлөөт `type` аудит, логт **орохгүй**.
`DEMO:` тогтмолууд: `ID_CARD_CHECKLIST_KEY = 'id_card'` (OCR-ийн тулгалт хийх түлхүүр), `DMS_TIMEOUT_MS`, `DMS_OCR_TIMEOUT_MS`.

## Тест
```bash
cd apps/origination
export TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/<db>_test REDIS_URL=redis://127.0.0.1:6379/<n>
pnpm exec vitest run src/modules/document test/document.e2e.test.ts
```
* `document-checklist.test.ts`, `document-ocr.test.ts`, `http-dms-documents.port.test.ts`, `document-events.subscriber.test.ts` — DB-гүй unit.
* `document.e2e.test.ts` (модуль дотор) — supertest + бодит DB + dms-ийн fake: AC (3 төрөл → 2 PENDING, 3-р COMPLETED, хасвал PENDING), extras, BORROWER/COLLATERAL дүрэм, эрхийн матриц,
  төлөв (409), LOCKED, үл мэдэгдэх түлхүүр 422, бүтээгдэхүүнгүй, зэрэг өөрчлөлт/reconcile, dms унасан, subscriber (давхар хүргэлт), OCR дүгнэлтүүд, аудит/лог-д PII байхгүй.
* `test/document.e2e.test.ts` — AppModule wiring: бодит `HttpDmsDocuments` + dms-ийг дуурайсан HTTP сервер (толгой, DELETE, 502, OCR хариуны хэлбэр).
