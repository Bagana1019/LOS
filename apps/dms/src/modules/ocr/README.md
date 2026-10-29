# DMS: OCR модуль (`/api/ocr`)

Баримтын зураг/PDF-ээс (иргэний үнэмлэх, цалингийн тодорхойлолт, бусад) талбар задлах REST. Хөдөлгүүр ба задлагч нь
[`@los/ocr`](../../../../../packages/ocr/README.md) багцад, энд зөвхөн HTTP хэлбэр, файлын хяналт, алдааны зураглал байна.
Шаардлага: NFR-7 (гар утаснаас зураг upload), NFR-9 (кирилл/латин холимог утга таних), BSA 2.1 (JPG/PNG/PDF оруулах).

> Авторизаци, rate limit gateway-д (CLAUDE.md §3.2(9)). Энэ сервис gateway-ийн ард, `/api` угтвартай. Gateway-ийн proxy
> маршрут энэ өөрчлөлтөд ОРООГҮЙ (openIssues).

## Endpoint-ууд

### `POST /api/ocr/extract` (multipart/form-data)

| Талбар | Тайлбар |
|---|---|
| `file` | Заавал, нэг файл. PNG, JPEG, TIFF, WebP, PDF. Төрлийг **файлын эхний байтаар** (magic bytes) тодорхойлно; клиентийн `Content-Type`, өргөтгөлд итгэхгүй |
| `docType` | `ID_CARD` \| `SALARY_CERTIFICATE` \| `GENERIC` \| `AUTO` (анхдагч `AUTO`: агуулгаас танина, танихгүй бол `GENERIC`) |
| `includeText` | `true`/`1`/`false`/`0` (анхдагч `false`). `true` бол хариунд OCR-ийн бүтэн текст орно (**PII**; зөвхөн дебаг) |

Үл мэдэгдэх талбар (`debug=1` г.м.) = 400. Хариу `200`, `Cache-Control: no-store`:

```json
{
  "docType": "ID_CARD",
  "detectedDocType": "ID_CARD",
  "fields": {
    "registerNo": { "value": "ЖЮ85061512", "confidence": 0.93, "raw": "ЖЮ85061512", "note": "...", "alternatives": ["..."] }
  },
  "warnings": [],
  "ocr": { "engine": "tesseract", "meanConfidence": 0.91, "pageCount": 1, "durationMs": 650 }
}
```

- `fields.<нэр>.value` нь `null` байж болно (уншигдаагүй). `confidence` 0..1, `raw` нь баримтаас уншсан түүхий хэсэг
  (тооцоолсон бол `null`), `note` нь итгэл бага/таамагласан/тооцоолсон тухай тайлбар, `alternatives` нь өөр боломжит утгууд.
- Талбаруудын жагсаалт ба найдвартай байдал: `packages/ocr/README.md`. **Хариуг хүн шалгаж баталгаажуулна** — OCR үр дүнг
  автоматаар шийдвэрт ашиглахгүй.

### `GET /api/ocr/doc-types`

`{ docTypes: [{ code, name, fields[] }] }`: `AUTO`, `ID_CARD`, `SALARY_CERTIFICATE`, `GENERIC`.

### `GET /api/ocr/health`

`{ ok, provider, detail? }`. Хөдөлгүүр бэлэн биш (tesseract/хэл олдохгүй) бол **503**.

## Алдааны зураглал

Хариу: `{ statusCode, error, code, message }`. `message` нь **тогтмол** Монгол текст: provider-ийн мессеж, баримтын текст,
файлын нэр хариунд ХЭЗЭЭ Ч орохгүй.

| Нөхцөл | HTTP | `code` |
|---|---|---|
| `file` байхгүй/хоосон, multipart биш | 400 | `FILE_REQUIRED` |
| `docType`/`includeText` буруу, үл мэдэгдэх талбар | 400 | `VALIDATION_FAILED` (`issues[]`: зөвхөн зам + zod код) |
| Файл `OCR_MAX_FILE_BYTES`-аас том | 413 | (multer) |
| Нэгээс олон файл, өөр нэртэй файл талбар, хэт урт талбар | 400 | (multer) |
| Magic bytes таарахгүй | 415 | `UNSUPPORTED_MIME` |
| Зураг эвдэрсэн / уншигдахгүй | 400 | `INVALID_INPUT` |
| Текст олдсонгүй | 422 | `EMPTY_RESULT` |
| Mock-д fixture байхгүй (зөвхөн mock) | 422 | `NO_FIXTURE` |
| Завгүй (зэрэгцээ + дараалал дүүрсэн) | 429 | `BUSY` |
| Хөдөлгүүр байхгүй | 503 | `ENGINE_UNAVAILABLE` |
| Хугацаа хэтэрсэн | 504 | `TIMEOUT` |
| Хөдөлгүүр алдаа гаргасан | 502 | `ENGINE_FAILED` |

## Тохиргоо (env)

| Env | Анхдагч | Тайлбар |
|---|---|---|
| `INTEGRATION_MODE` | `mock` | `mock` (deterministic fixture) \| `real` (Tesseract). Буруу утга = эхлэхэд Error |
| `OCR_MAX_FILE_BYTES` | `10485760` (10 MB) | Нэг файлын дээд хэмжээ (1..100 MiB) |
| `OCR_MAX_CONCURRENCY` | `2` | Зэрэг ажиллах OCR-ийн тоо (CPU хамгаалалт) |
| `OCR_MAX_QUEUE` | `8` | Хүлээх хүсэлтийн тоо; дүүрвэл 429 |

Бусад (`OCR_ENGINE`, `TESSERACT_BIN`, `OCR_LANGUAGES`, `OCR_TIMEOUT_MS` ...) нь `@los/ocr`-ийн README-д. Анхдагч утгууд
нэг газар: `ocr.config.ts` (`OCR_HTTP_DEFAULTS`). Env модуль үүсэх үед нэг удаа уншигдана.

## Бүтэц

```
ocr.module.ts        MulterModule (memory storage, limits), провайдерууд; OCR_PROVIDER-ийг экспортлоно
ocr.tokens.ts        OCR_PROVIDER / OCR_CONFIG / OCR_CLOCK (Symbol токенууд)
ocr.controller.ts    3 endpoint; magic bytes, @UseFilters(OcrErrorFilter)
ocr.service.ts       OcrDocumentService + concurrency gate + PII-гүй лог
ocr-error.filter.ts  OcrError/GateFullError -> HTTP
ocr.dto.ts           multipart талбарын zod schema
zod-validation.pipe  энэ модульд л хэрэглэх жижиг pipe
concurrency-gate.ts  зэрэгцээ ба дарааллын хязгаар
correlation.ts       X-Correlation-Id цэвэрлэгч
```

Provider солих/тест: `Test.createTestingModule({ imports: [OcrModule] }).overrideProvider(OCR_PROVIDER).useValue(...)`.
Constructor-ын хамаарал бүрд `@Inject(...)` тодорхой (esbuild `emitDecoratorMetadata` дэмждэггүй).

## Нууцлал, аюулгүй байдал

- Файл **санах ойд** (multer memory storage) л байна; DMS нь диск дээр баримт үлдээхгүй. Tesseract provider PDF/зургийг
  `mkdtemp` 0700 хавтсанд түр бичиж, дуусмагц (алдаатай ч) устгана.
- **Лог PII-гүй**: `{ event, correlationId, docType, engine, bytes, pages, fieldsFound, warnings, ocrMs }` л. Регистр, нэр,
  данс, OCR текст, файлын нэр лог/алдаанд орохгүй.
- `X-Correlation-Id` нь **зөвхөн лог**-д, `^[A-Za-z0-9._:-]{1,64}$` таарвал; хариунд буцаахгүй (log injection хамгаалалт).
- Клиентийн файлын нэр provider-т (multer basename болгосон) мэдээлэл болгон очно; Tesseract түүнийг замд ашиглахгүй.
- Хариу PII агуулдаг тул `Cache-Control: no-store`; gateway/proxy-д энэ хариуг cache хийхгүй байх.

## Туршилт

```bash
cd apps/dms && npx vitest run src/modules/ocr
```

Supertest-ээр бодит multipart (multer) дамжуулна: хэмжээ, magic bytes, алдааны зураглал, 429, PII-гүй лог, default wiring.
Файлууд зохиомол (magic bytes), provider нь `MockOcrProvider`/stub. Бодит Tesseract-ийн тест `packages/ocr`-д.
