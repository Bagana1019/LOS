# document (dms) — хүсэлтийн баримт бичиг

**Шаардлага:** FR-9.1 (төрөл, холбогдох зүйл, тайлбар, файл; оруулсан огноо, ажилтан автоматаар). Checklist-ийн тодорхойлолт `origination.product.document_checklist_json`,
дүгнэлт (8-р алхам) origination-д — `apps/origination/src/modules/document/README.md`. Гарын авлага: `docs/05-collateral-documents.md` §3.2.

`dms.document` нь `dms.file`-ийн хүсэлт/зээлдэгч/барьцаатай холбоос. Энэ модуль **зөвхөн origination (sync REST)**-ийн дууддаг дотоод API. Gateway-ийн ажилтны proxy
`/api/dms/documents`-ийг гаргахгүй (`INTERNAL_ONLY_PREFIXES`); origination хэрэглэгчийн толгойг (`X-User-Id`, `X-Roles`, `X-Org-Id`, `X-Correlation-Id`) дамжуулж дууддаг.
Хүсэлтийн хүрээ (NFR-3), төлөв (DRAFT/RETURNED), checklist-ийн түлхүүр, зээлдэгч/барьцааны холбоосын жинхэнэ шалгалт origination-д; dms-д зөвхөн байгууллага, файлын оршихуй, холбоосын бүрдэл.

## API (`/api/documents`)

Бүх замд `@Permissions('application:read')` — ADMIN-д `application:write` байхгүй тул origination ADMIN-ы нэрийн өмнөөс дуудахад унших эрх хэрэгтэй.

| Метод · зам | Тайлбар |
| --- | --- |
| `POST /documents` | `CreateDocumentRequest` → **201** `DocumentView`. `DocumentUploaded` outbox-д ижил транзакцид |
| `GET /documents?applicationId=` | `DocumentListQuery` (`relatedEntity`, `relatedId` нэмэлт) → `DocumentListResponse`. **Оруулсан цагаар өсөхөөр** (хуучин нь эхэнд), адил цагт `id`-аар |
| `GET /documents/:id` | `DocumentView` |
| `DELETE /documents/:id` | **204**. Файл файл санд үлдэнэ. `DocumentRemoved` outbox-д ижил транзакцид |
| `POST /documents/:id/ocr` | Хадгалсан файлыг OCR-д өгнө (доор). **200**, `Cache-Control: no-store` |

`DocumentView.uploadedBy` = `created_by`, `uploadedAt` = `created_at`; `fileName`/`mime`/`size` нь `dms.file`-ээс.

### Дүрэм
* **Байгууллага:** `X-Org-Id`-ээр хязгаарлана. Өөр байгууллагын баримт/файл 404 — оршихуйг задруулахгүй.
* **Файл:** `fileId` нь дуудагчийн байгууллагад байх, `purged_at IS NULL`. Үгүй бол 404 `FILE_NOT_FOUND` (өөр байгууллагынх, устгагдсан, байхгүй гурав адил).
  Нэг файл хэд хэдэн баримтад ашиглагдаж болно (нэг PDF хоёр checklist-ийг хангана). Давхар хавсралтыг dms хаахгүй — origination/UI-ийн хариуцлага.
* **Нормчлол:** `type`, `checklistKey` → trim, NFC, жижиг үсэг, дотоод зай `_` (`ID Card` → `id_card`). Нормчилсны дараа уртыг (100/60) дахин шалгана.
* **Холбоос:** `relatedEntity` `BORROWER`/`COLLATERAL` бол `relatedId` заавал (422 `RELATED_ID_REQUIRED`); `APPLICATION` бол `relatedId` өгч болохгүй (422 `RELATED_ID_NOT_ALLOWED`).
* **Устсан файл:** `purged_at`-тай файлын баримт жагсаалт/get/OCR-д гарахгүй (агуулга алга); устгах (`DELETE`) нь ажиллана.
* **Зэрэг устгал:** `deleteMany` тоогоор — яг нэг хүсэлт `DocumentRemoved` гаргана, бусад нь 404.
* **Алдаа:** `DomainError` — тогтвортой `code` + монгол `message`: `VALIDATION_FAILED` 400, `FILE_NOT_FOUND` 404, `DOCUMENT_NOT_FOUND` 404, `RELATED_ID_REQUIRED` / `RELATED_ID_NOT_ALLOWED` 422.

### Event (`@los/contracts` events.ts, version 1)
* `DocumentUploaded` {documentId, applicationId, `kind` = type, relatedEntity, relatedId, checklistKey, fileId}
* `DocumentRemoved` {documentId, applicationId, `kind`, relatedEntity, relatedId, checklistKey}

Сонсогч: origination (`document-events.subscriber.ts` — 8-р алхмыг дахин тооцно), dwh-sync.

## OCR (`POST /documents/:id/ocr`)

`OCR_PROVIDER`-ийг (`INTEGRATION_MODE=mock|real`) `/api/ocr/extract`-тэй адил `OcrService`-ээр ашиглана. Объект хадгалалтаас (`OBJECT_STORAGE`) файлыг уншиж,
magic bytes-аар төрлийг тодорхойлно (PNG/JPEG/TIFF/WebP/PDF; бусад 415 `UNSUPPORTED_MIME`).

| checklistKey | OCR төрөл |
| --- | --- |
| `id_card` | `ID_CARD` |
| `salary_statement` | `SALARY_CERTIFICATE` |
| бусад, түлхүүргүй (`type` ганцаараа сонгохгүй) | `GENERIC` |

`DEMO:` түлхүүр→төрлийн хүснэгт `document.rules.ts` `OCR_DOC_TYPE_BY_CHECKLIST_KEY` (ганц газар).

* Хариу: `{ documentId, docType, detectedDocType, fields, warnings, ocr: { engine, meanConfidence, pageCount, durationMs } }` — **`ocr.text` хэзээ ч байхгүй**, юу ч хадгалагдахгүй.
* Алдааны хөрвүүлэлт `OcrErrorFilter`-ийнх: `UNSUPPORTED_MIME` 415, `EMPTY_RESULT`/`NO_FIXTURE` 422, `ENGINE_UNAVAILABLE` 503, `TIMEOUT` 504, `ENGINE_FAILED` 502, дараалал дүүрсэн 429 `BUSY`.
  Нэмэлт: файл `OCR_MAX_FILE_BYTES`-аас том 413 `OCR_FILE_TOO_LARGE`; хадгалалтаас уншиж чадаагүй 502 `FILE_CONTENT_UNAVAILABLE`.
* **mock горимд** fixture-ийг файлын нэрээр сонгоно (`id-card`, `salary`, `statement` агуулсан нэр); таарахгүй бол 422 `NO_FIXTURE` — энэ нь хэвийн (бодит OCR-д байхгүй).
* PII: баримтын текст, талбар, файлын нэр, регистрийг ЛОГЛОХГҮЙ (`OcrService` зөвхөн хэмжээ/тоо логлоно).

## Тест
```bash
cd apps/dms
TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/<db>_test REDIS_URL=redis://127.0.0.1:6379/<n> pnpm exec vitest run src/modules/document test/document.e2e.test.ts
```
* `document.rules.test.ts` — нормчлол, холбоос, OCR төрөл. `document.service.test.ts` — OCR-ийн хэмжээ/хадгалалтын алдаа (сангүй).
* `test/document.e2e.test.ts` — supertest + бодит DB + санах ойн storage: CRUD, org тусгаарлалт, outbox (хоёр event), устсан/байхгүй файл, зэрэг устгал, OCR (mock fixture), эрх, лог-д PII байхгүй.
