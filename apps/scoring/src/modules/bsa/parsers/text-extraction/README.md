# bsa/parsers/text-extraction — файл → `StatementText`

Хамрах хүрээ: docs/02 BSA-FR-2.1 (PDF / зураг / CSV хүлээн авах), BSA-FR-2.3 (PDF metadata), NFR-9 (кирилл/латин холимог).
Үүрэг: хэрэглэгчийн оруулсан хуулгын файлыг `../statement.types.ts`-ийн `StatementText` болгоно. Parser зөвхөн энэ гаралтыг уншина.

**Банкны формат БАТАЛГААЖААГҮЙ:** `samples/` хоосон тул нүд таслах босго (`cellGapRatio`, `cellGapCharWidths`) зөвхөн ЗОХИОМОЛ PDF/зургаар тохируулагдсан — `TODO(samples)`.
Бодит хуулга ирмэгц `text-extraction.defaults.ts` дахь босгыг тохируулж, parser-ын тестийг дахин ажиллуулна.

## Урсгал

```
{ fileName, mimeType?, content } ─ StatementTextService.extract ─▶ StatementText { source, pages[], meta }
   │ хоосон → EMPTY, > maxBytes → TOO_LARGE
   ▼ file-kind.ts (БИТ эхэнд)
 PDF ──▶ pdf-text.extractor ─ text layer ✔ ─▶ source 'PDF_TEXT'
   │                         └ text layer ✘ ─ ocrFallback унтраалттай ▶ PDF_NO_TEXT_LAYER
   │                                         └ ocrFallback асаалттай   ▶ OcrProvider(PDF) ▶ source 'OCR' (+ meta.pdf)
 IMAGE ▶ OcrProvider(зураг) ▶ ocr-text.extractor ▶ source 'OCR' (+ meta.ocr)
 CSV ──▶ csv-text.extractor ▶ source 'CSV'      TEXT ▶ plain-text.extractor ▶ source 'TEXT'
 XLSX ─▶ UNSUPPORTED_FILE (CSV/PDF экспортлох заавар)   UNKNOWN ▶ UNSUPPORTED_FILE
```

`meta` = `{ fileName (зам/удирдлагын тэмдэгтгүй, ≤ 255), mimeType (агуулгаас гарсан каноник), sizeBytes, sha256, pdf?, ocr? }`.

## Файлын төрөл (`file-kind.ts`)

Дараалал: **бит (magic bytes) → MIME → өргөтгөл**. Клиентийн MIME/нэрэнд ганцаараа итгэхгүй.

| Бит | Төрөл |
| --- | --- |
| файлын эхэнд `%PDF-` | PDF |
| PNG, JPEG, TIFF (`II*\0` / `MM\0*`), WEBP (`RIFF....WEBP`) | IMAGE (`@los/ocr`-ийн `detectOcrMime`-тэй ижил тодорхойлолт) |
| `PK\3\4` / `PK\5\6` (zip) | XLSX |
| OLE2 + өргөтгөл `.xls` | XLSX |
| бусад: NUL-гүй, удирдлагын тэмдэгт ≤ 2%, эсвэл Unicode BOM | **текст** → MIME/өргөтгөлөөр CSV \| TEXT |
| бусад | UNKNOWN |

Текст үед: MIME `text/csv`, `application/csv`, `text/x-csv`, `text/tab-separated-values`, `application/vnd.ms-excel` (Windows) → CSV;
`text/plain` → TEXT (өргөтгөл `.csv`/`.tsv` бол CSV); MIME ерөнхий/хоосон бол өргөтгөл (`csv`, `tsv` → CSV; `txt`, `text` → TEXT); эс бөгөөс UNKNOWN.
Жишээ: `.pdf` нэртэй PNG → IMAGE; `.csv` нэртэй PDF → PDF; `application/pdf` MIME-тэй HTML алдааны хуудас → UNKNOWN.
PDF-ийн `%PDF-` нь заавал эхний байтууд (polyglot/хог өгөгдлөөс сэргийлнэ).

## PDF (`pdf-text.extractor.ts`, `pdf-layout.ts`, `pdf-metadata.ts`)

`pdfjs-dist` legacy build; програм CommonJS-ээр компайл хийгддэг тул `import('pdfjs-dist/legacy/build/pdf.mjs')` динамикаар. eval, системийн фонт,
фонт ачаалах, сүлжээ, stream/range, XFA унтраалттай; Node-д fake worker (үндсэн thread). Дуудагчийн `Buffer`-ийг хуулж өгнө.

**Мөр/нүд сэргээх** (бүх босго үсгийн өндөр `h`-д харьцангуй, `PdfLayoutOptions`):

1. Item бүрийг хуудасны харагдах координат (page `/Rotate`-тай) руу буулгаж, **давамгайлсан унших чиглэлд** (тэмдэгтийн тоогоор жинлэсэн) эргүүлнэ —
   контент нь 90° эргэсэн, бага зэрэг ташуу (скан) ч мөр хэвтээ болно. Давамгайлсан чиглэлээс зөрсөн item (усан тэмдэг) **тусдаа мөр болж хуудасны төгсгөлд** орно; хөндлөнгөөс холилдохгүй.
2. Мөр: baseline зөрүү ≤ `lineToleranceRatio` (0.5) × min(h); мөрийн дундаж y-тай харьцуулна (гинжин нэгдэхгүй).
3. Нүд: мөр доторх item-үүдийг x-ээр эрэмбэлж, харагдах зай (item-ийн төгсгөлийн хоосон зайг хасаж) > `cellGapRatio` (0.65) × h бол шинэ нүд;
   ≤ `wordGapRatio` (0.15) × h бол залгана; завсрын зайд нэг зай. Хоёр item-ийн өндөр өөр бол жижгээр хэмжинэ (нийлүүлэхээс таслах нь дээр).
4. Нэг item доторх ≥ 2 зайн дараалал (моноширин мөр нэг `Tj`-д) өөрийн геометрээр нэмэлт нүд болж таслагдана.
5. Ижил текстийг бараг ижил байрлалд давхар зурсан (хуурамч bold) item-ийн нэгийг л үлдээнэ (`overdrawRatio`). Өөр юу ч хасахгүй.
6. PDF-д хоосон нүд байхгүй: хоосон багана нүдгүй гарна (`cells` цөөн) — engine-ийн `alignBody` нөхнө.

**Text layer:** хуудас тутмын хоосон бус тэмдэгтийн дундаж ≥ `minAvgCharsPerPage` (30) бол text layer байна. Үгүй бол скан гэж үзнэ.

**Metadata (BSA-FR-2.3):** `producer`, `creator`, `title`, `author`; `creationDate`/`modDate` PDF огноо (`D:YYYYMMDDHHmmSSOHH'mm'`) → ISO 8601 UTC (бүс байхгүй бол UTC гэж таамагласан,
буруу огноо → null); `pageCount`; `isEncrypted` (нууц үггүй нээгдэх owner-password PDF ч true); `hasSignature` = AcroForm `SigFlags` эсвэл гарын үсгийн талбар (хоосон ч) байх.
**Гарын үсгийн криптограф шалгалт хийгдэхгүй** (TODO(authenticity)). QR задлах нь энэ модульд ороогүй (`meta.qrPayloads` хоосон).

## OCR (`ocr-text.extractor.ts`)

`OcrProvider` (`@los/ocr`, токен `OCR_PROVIDER`) -ээс ирсэн `OcrResult` → `StatementText`. Зураг (IMAGE) заавал; PDF зөвхөн `ocrFallback: true` үед.
`fileName` provider-т **дамжихгүй**; `mimeType` нь агуулгаас гарсан каноник.

Нэг `OcrLine` дотор дараалсан үгсийн зай > `max(cellGapCharWidths (1.2) × мөрийн үсгийн өргөний медиан, cellGapLineHeights (0.6) × мөрийн хайрцгийн өндөр)` бол шинэ нүд.
Зөвхөн босоо зураасаас бүтсэн үг (`|`, `¦`) — хүснэгтийн шугам — нүдний хил болж, текстэд орохгүй. Үгийн хайрцаггүй мөр → `[line.text]`.
Мөрийн дарааллыг provider-ийн хэвээр (дээрээс доош) хадгална. `meta.ocr = { engine, meanConfidence }`; `y` = мөрийн хайрцгийн дээд ирмэг (px).

**Дутуу уншилт:** `OcrResult.warnings` (жишээ нь PDF-ийн эхний N хуудсыг л уншсан) байвал `rejectOnWarnings` (анхдагч true) үед `OCR_FAILED` — хуудас чимээгүй алдагдахаас сэргийлнэ.
Провайдер байхгүй / алдаа / хоосон текст → `OCR_FAILED` (шалтгааны шошго `error.detail`: `OcrError:ENGINE_UNAVAILABLE` гэх мэт; текст огт орохгүй).

Скан PDF: `ocrFallback: true` үед service PDF-ийг OcrProvider-т өгнө (Tesseract provider `pdftoppm`-ээр хуудас бүрийг растерлана). `source = 'OCR'`, `meta.pdf` хэвээр
(producer/огноо нь скан төхөөрөмжийн тухай мэдээлэл). OCR-ийн нарийвчлал доогуур тул verifier `OCR_LOW_CONFIDENCE`-ийг `meta.ocr.meanConfidence`-ээр ашиглана.

## CSV / текст

**Кодчилол** (`text-decoding.ts`): UTF-8 (BOM хасна), UTF-16LE/BE (BOM-той), эс бөгөөс UTF-8 хатуу декод; амжилтгүй бөгөөд 0x80+ байтын ≥ 70% нь кирилл үсгийн байт
(0xC0-0xFF ба Ё/Є/Ї-ийн байр) бол windows-1251. cp1251 үед Є/є/Ї/ї → Ө/ө/Ү/ү (монгол кирилл — **таамаг**, TODO(samples)). Бусад хагас эвдэрсэн UTF-8 → U+FFFD-тэй, няцаахгүй.

**CSV:** RFC 4180 (хашилт, `""`, хашилт доторх шинэ мөр / delimiter), CRLF/CR/LF. Delimiter auto-detect (`, ; TAB |`): эхний 50 бичлэгийг нэр дэвшигч бүрээр задалж,
"нүдний тоо ≥ 2 ба хамгийн олон давтагдсан тоотой тэнцүү" бичлэгийн тоог харьцуулна (тэнцвэл нүдний тоо их нь). `csv.delimiter`-ээр албадаж болно.
Бичлэг бүр нэг line; нүд цэвэрлэгдэнэ (хоосон зай, тэг өргөнтэй тэмдэгт; хашилт доторх шинэ мөр → зай); **хоосон нүд хадгалагдана** (CSV-д байрлал чухал); бүрэн хоосон бичлэг алгасагдана.
`y` = файл дахь бичлэгийн дугаар (1-ээс; алгассан хоосон бичлэг оролцоно). Формулын тэмдэгтүүд (`=`, `+`) зөвхөн уншигдах тул нөлөөгүй.

**Текст:** мөр бүр line; нүд = TAB эсвэл ≥ 2 зай (дараалсан тусгаарлагч нэг); NBSP = зай; `\f` = хуудасны таслал; хоосон мөр алгасагдана; `y` = хуудас доторх мөрийн дугаар.

## Алдаа (`errors.ts`) — `StatementExtractionError`

`code`, `message` (= `userMessage`, аюулгүй монгол, файлын агуулга/нэр/OCR текстгүй), `detail?` (ASCII шошго, логт аюулгүй).

| Код | Хэзээ |
| --- | --- |
| `UNSUPPORTED_FILE` | UNKNOWN төрөл; XLSX (мессеж: CSV/PDF-ээр экспортлох); `Buffer` биш оролт |
| `EMPTY` | 0 байт, эсвэл CSV/текст нь хоосон бичлэгээс л бүтсэн |
| `TOO_LARGE` | `maxBytes` хэтэрсэн, эсвэл PDF `maxPages` хэтэрсэн (чимээгүй таслахгүй) |
| `PDF_ENCRYPTED` | нууц үг шаардсан PDF (`PasswordException`) |
| `PDF_CORRUPT` | pdfjs нээж/уншиж чадаагүй (`detail` = pdfjs-ийн алдааны нэр) |
| `PDF_NO_TEXT_LAYER` | скан PDF, `ocrFallback` унтраалттай |
| `OCR_FAILED` | provider байхгүй / алдаа / хоосон / дутуу уншсан |

Мессежийн жишээ: `Файл хэт том байна (дээд хэмжээ 20 МБ).`

## Тохиргоо ба DI

Анхдагч утга НЭГ газар: `text-extraction.defaults.ts` → `TEXT_EXTRACTION_DEFAULTS` (env уншихгүй). Буруу тохиргоо эхлэхэд `Error`.

| Талбар | Анхдагч | Утга |
| --- | --- | --- |
| `maxBytes` | 20 MiB | файлын дээд хэмжээ (`@los/ocr`-тэй нэгдмэл) |
| `ocrFallback` | false | text layer-гүй PDF-ийг OCR-ээр унших (provider заавал) |
| `pdf.maxPages` | 200 | NFR-1: 6 сар ≈ 60-70 хуудас |
| `pdf.minAvgCharsPerPage` | 30 | text layer байгаа гэж үзэх доод хэмжээ |
| `pdf.lineToleranceRatio` / `wordGapRatio` / `cellGapRatio` / `overdrawRatio` | 0.5 / 0.15 / 0.65 / 0.2 | дээрх геометр (h-д харьцангуй) |
| `ocr.cellGapCharWidths` / `cellGapLineHeights` | 1.2 / 0.6 | OCR нүд таслах |
| `ocr.rejectOnWarnings` / `ocr.languages` | true / provider-ийн анхдагч | |
| `csv.delimiter` / `sniffRecords` / `sniffMaxChars` | auto / 50 / 200000 | |
| `csv.cp1251Dominance` / `remapMongolianCp1251` | 0.7 / true | |

```ts
@Module({ imports: [TextExtractionModule] })                                   // OCR_PROVIDER = createOcrProvider(process.env), INTEGRATION_MODE=mock|real
@Module({ imports: [TextExtractionModule.register({ options: { ocrFallback: true, maxBytes: 10 * 2 ** 20 } })] })
@Module({ imports: [TextExtractionModule.register({ ocrProvider })] })         // бэлэн provider
// constructor(@Inject(StatementTextService) private readonly text: StatementTextService)
```

`OCR_PROVIDER` (Symbol) болон `TEXT_EXTRACTION_OPTIONS` (хэсэгчилсэн тохиргоо) токенууд `index.ts`-ээс гарна. Nest модуль нь `StatementTextService` ба `OCR_PROVIDER`-ийг экспортолно.

## Аюулгүй байдал ба PII

- Лог/алдаанд файлын агуулга, нэр, дансны дугаар, гүйлгээний утга, OCR текст **орохгүй**; `detail` нь `[A-Za-z0-9_.:-]` ≤ 64.
- Тест/fixture бүгд ЗОХИОМОЛ (`test-fixtures/bsa/text-extraction/README.md`).
- PDF: хуудасны тоо, байт хязгаартай; pdfjs-ийн script/XFA/eval унтраалттай. Задарсан контентын хэмжээ (decompression bomb) болон хугацааны хязгаар энд БАЙХГҮЙ —
  BullMQ ажлын timeout/санах ойн хязгаар (import дэд модуль) хариуцна.

## Мэдэгдэж буй хязгаарлалт

- Бодит банкны PDF/скан хуулгаар босго тохируулагдаагүй (TODO(samples)); PDF-д хоосон нүд бүртгэгдэхгүй.
- XLSX/XLS дэмжигдэхгүй (TODO: баталгаатай сан сонгох); HEIC зураг дэмжигдэхгүй (OCR provider-ийн жагсаалт: PNG, JPEG, TIFF, WEBP).
- Олон баганат (хуудас хоёр хуваагдсан) бүдүүвч, баруун-зүүн бичгийн PDF-д зориулсан тусгай логик байхгүй.
- Гарын үсгийн криптограф баталгаажуулалт, XMP metadata, QR задлах — энэ модульд ороогүй.

## Тест

```
cd apps/scoring && npx vitest run src/modules/bsa/parsers/text-extraction
```

`ocr.integration.test.ts` нь жинхэнэ `tesseract` (+ `mon`, `eng`; скан PDF-д `pdftoppm`) байхгүй бол өөрөө skip хийнэ. PDF-үүдийг тест дотор `pdf-lib`-ээр (`testing/pdf-builder.ts`) үүсгэнэ.
