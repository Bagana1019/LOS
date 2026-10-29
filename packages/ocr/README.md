# @los/ocr

OCR adapter (CLAUDE.md §3.2(7)): **interface + Mock + Real**, `INTEGRATION_MODE` env-ээр солино. Зураг/PDF-ээс текст
уншиж (`OcrProvider`), баримтын төрлөөр талбар задалдаг (`extractDocument`). Шаардлага: NFR-7 (гар утаснаас зураг upload),
NFR-9 (кирилл/латин холимог утга таних), BSA 2.1 (JPG/PNG/PDF).

> **Баталгаажаагүй.** Бодит иргэний үнэмлэх, цалингийн тодорхойлолт, банкны хуулгын дээж байхгүй. Шошго, байрлал,
> өгүүлбэрийн хэв маяг нь **зохиомол** fixture дээр боловсруулагдсан (`TODO(samples)`). Бодит баримтад нарийвчлал
> тогтоогдоогүй; задалсан утгыг хүн шалгаж баталгаажуулна. Бодит хэмжилт: `test-fixtures/README.md`.

## Бүтэц

```
OcrInput (Buffer + mime) -> OcrProvider.recognize() -> OcrResult (хуудас > мөр > үг, пиксел хайрцаг, 0..1 итгэл)
                                                         |
                                  extractDocument(ocr, docType | 'AUTO') -> DocumentExtraction { fields, warnings }
OcrDocumentService = provider + extractDocument  (DMS REST модуль үүнийг ашиглана)
```

| Файл | Үүрэг |
|---|---|
| `src/types.ts` | `OcrProvider`, `OcrInput`, `OcrResult`, `OcrError` (код: `UNSUPPORTED_MIME`, `INVALID_INPUT`, `ENGINE_UNAVAILABLE`, `ENGINE_FAILED`, `TIMEOUT`, `EMPTY_RESULT`, `NO_FIXTURE`) |
| `src/defaults.ts` | `OCR_DEFAULTS` — техникийн анхдагч утгууд НЭГ газар |
| `src/mime.ts` | `detectOcrMime(Buffer)` — magic bytes: PNG, JPEG, TIFF, WebP, PDF |
| `src/factory.ts` | `createOcrProvider(env)`, `OCR_ENGINES` бүртгэл |
| `src/providers/mock.provider.ts` | `MockOcrProvider` — deterministic, сүлжээ/цаг/санамсаргүй утгагүй |
| `src/providers/tesseract.provider.ts` | `TesseractOcrProvider` — Tesseract 5 CLI (+ PDF бол `pdftoppm`) |
| `src/extract/` | `extractDocument`, `detectDocType`; `ID_CARD`, `SALARY_CERTIFICATE`, `GENERIC` |
| `src/ocr-document.service.ts` | `OcrDocumentService.analyze()` |
| `src/text/` | Текст/тэмдэгт/огноо/дүн/дансны нийтлэг helper (өөр багийн хариуцлага, энд өөрчлөхгүй) |

### Mock

`MockOcrProvider` fixture-г дараах дарааллаар сонгоно: (1) агуулгын sha256 (`registerSha256`), (2) файлын нэрийн pattern
(`registerFileName`), (3) `mimeType: 'text/plain'` бол агуулга өөрөө OCR текст, (4) built-in fixture (файлын нэрэнд
`id-card` | `salary` | `statement`), (5) үгүй бол `NO_FIXTURE`. Текстийг бодит OCR шиг пиксел хайрцагтай хуудас болгож
байрлуулна (`\t` эсвэл 2+ зай = баганын завсар, `\f` = хуудасны хил), тогтмол итгэл 0.99. Built-in өгөгдөл бүр
`ЗОХИОМОЛ ӨГӨГДӨЛ` тэмдэгтэй. `ocrResultFromText(text)` нь downstream parser/extractor-ийн unit тест бичихэд тохиромжтой.

### Tesseract

```
зураг: tesseract <in> stdout -l mon+eng --psm 6 --dpi 300 tsv
PDF:   pdftoppm -r 300 -png -f 1 -l <maxPages+1> -> хуудас бүрт tesseract
```

TSV-ээс хуудас, мөр, үг, хайрцаг, итгэл (`conf/100`; `-1` алгасна) уншина. Дэд процесс **shell-гүй**, `args` массивтай,
хугацаа ба stdout-ийн хязгаартай, environment allowlist-тай.

Суулгах (Debian/Ubuntu): `apt install tesseract-ocr tesseract-ocr-mon tesseract-ocr-eng poppler-utils`.

## Тохиргоо (env)

Тохиргооны алдаа = `Error` (сервис **эхлэхэд** унана, хүсэлт дээр биш).

| Env | Анхдагч | Тайлбар |
|---|---|---|
| `INTEGRATION_MODE` | `mock` | `mock` \| `real` |
| `OCR_ENGINE` | `tesseract` | `real` үед хөдөлгүүр; үл мэдэгдэх = Error |
| `TESSERACT_BIN` | `tesseract` | Бинарын нэр/зам (`-`-ээр эхэлж болохгүй) |
| `PDFTOPPM_BIN` | `pdftoppm` | |
| `OCR_LANGUAGES` | `mon+eng` | `+`-ээр тусгаарласан Tesseract хэл (`/^[a-z_]{3,12}$/`, дээд тал нь 6) |
| `OCR_PSM` | `6` | 0..13 |
| `OCR_DPI` | `300` | 70..2400 |
| `OCR_TIMEOUT_MS` | `60000` | Нийт хугацаа (PDF бол бүх хуудсанд), 1..600000 |
| `OCR_MAX_PAGES` | `20` | PDF/олон хуудас TIFF; илүүг нь алгасаж `warnings`-д бичнэ |
| `OCR_MAX_INPUT_BYTES` | `20971520` | Оролтын дээд хэмжээ |

DMS-ийн HTTP тохиргоо (`OCR_MAX_FILE_BYTES`, `OCR_MAX_CONCURRENCY`, `OCR_MAX_QUEUE`) нь `apps/dms/src/modules/ocr/README.md`-д.

## Хэрэглээ

```ts
import { createOcrProvider, OcrDocumentService } from '@los/ocr';

const service = new OcrDocumentService(createOcrProvider(process.env), () => ({ today: '2026-10-28' }));
const { extraction, ocr } = await service.analyze({ content, mimeType: 'image/png', docType: 'AUTO' });
extraction.fields.registerNo; // { value, confidence, raw, note?, alternatives? }
```

`today` өгвөл үнэмлэхний хугацаа дууссан эсэхийг шалгана (багц цагийг өөрөө уншихгүй, deterministic).

## Шинэ хөдөлгүүр (provider) нэмэх

1. `src/providers/<name>.provider.ts`-д `OcrProvider`-ийг хэрэгжүүл: `recognize(input): Promise<OcrResult>` ба (боломжтой бол) `healthCheck()`.
   Дотоод алдаа бүрийг `OcrError(<код>, <PII-гүй мессеж>)` болго; баримтын текстийг мессеж/логт оруулахгүй.
   Хуудсуудыг `assembleOcrResult(pages, meta)`-аар `OcrResult` болго. Оролтын magic bytes-ийг `detectOcrMime`-ээр өөрөө шалга.
2. `src/factory.ts`-ийн `OCR_ENGINES`-д `<name>: (env) => new <Name>Provider(...)` нэм (env-ийг энд парс хийж, буруу бол `Error`).
3. Анхдагч утгыг `src/defaults.ts`-д тавь (hardcode хийхгүй), `index.ts`-ээс экспортол.
4. Тест: `src/providers/<name>.provider.test.ts` (хуурамч runner/HTTP client; бодит сүлжээ/процесс хэрэглэхгүй), `factory.test.ts`-д `OCR_ENGINE=<name>` тохиолдол.
5. Шалтгаан бүрт `OcrError` код: хөдөлгүүр алга = `ENGINE_UNAVAILABLE`, хугацаа = `TIMEOUT`, бусад = `ENGINE_FAILED`. DMS энэ кодыг 503/504/502 болгоно.

## Талбар задлалт

`extractDocument(ocr, docType | 'AUTO', options?)`. `AUTO` нь шошго/гарчгийн оноогоор таньж, танихгүй бол `GENERIC`
(`detectedDocType: null`). Талбар бүр `{ value, confidence (0..1), raw, note?, alternatives? }`; `value: null` = уншигдаагүй.
Итгэл = OCR үгсийн итгэл × баталгаажуулалт (регистрийн төрсөн огноо, IBAN mod-97, хуанли) × эвристик/тооцоолсон коэффициент.
`lowConfidenceThreshold` (анхдагч 0.6)-оос бага бол `note` нэмнэ. Босго, коэффициент: `src/extract/defaults.ts` (`EXTRACT_DEFAULTS`).

| Төрөл | Талбарууд |
|---|---|
| `ID_CARD` | `lastName`, `firstName`, `patronymic`, `registerNo`, `birthDate`, `gender`, `cardNumber`, `issueDate`, `expiryDate` |
| `SALARY_CERTIFICATE` | `employerName`, `employeeName`, `registerNo`, `position`, `monthlySalary`, `issueDate`, `periodFrom`, `periodTo`, `periodMonths` |
| `GENERIC` | `registerNos`, `ibans`, `dates`, `amounts`, `phones` (бүгд массив) |

Огноо `YYYY-MM-DD`, цалин/дүн тоо (MNT). Шошго таних нь OCR-ийн алдаанд тэсвэртэй (Левенштейн, кирилл/латин ижил
дүртэй үсгийн нэгтгэл `Н/H`, `В/B`...). Цифрийн алдаа (`O`/`0`, `l`/`1`) зөвхөн тоон талбарт зөвхөн хангалттай нотолгоотой үед засна.
Регистр: `parseRegisterNo`-аар шалгана; илүү 3 дахь үсгийг тэвчиж (note), `B` -> `Б` хувилбарыг `alternatives`-д өгнө; төрсөн огноо ба
хүйсийг регистртэй тулгана. Цалин: огноо, регистр, IBAN, цаг, утсыг далдалсны дараа "цалин" түлхүүр үгийн ойролцоох, мөнгөн
тэмдэгттэй дүнг сонгоно; "бонус/татвар"-ын дүнг хасч, хэд хэдэн нэр дэвшигч байвал `warnings` + `alternatives`.

### Найдвартай байдал (зохиомол цэвэр зураг дээр, бодит биш)

Найдвартай: овог/нэр, төрсөн огноо, хүчинтэй хугацаа, цалингийн дүн, тодорхойлолтын огноо, сарын тоо, байгууллага/ажилтны нэр.
Найдваргүй: **регистрийн үсэг** (илүү үсэг, `Б`/`В`/`B`), үнэмлэхний дугаарын үсэг (`MN`/`ММ`), албан тушаал, зураг (photo) дээрх хүйс.
Дэлгэрэнгүй тоо: `test-fixtures/README.md`.

## Хязгаар

- Оролт: PNG, JPEG, TIFF, WebP, PDF (≤ `OCR_MAX_INPUT_BYTES`). Бусад = `UNSUPPORTED_MIME`; текст олдохгүй = `EMPTY_RESULT`.
- Хуудасны тоо `OCR_MAX_PAGES`; нийт хугацаа `OCR_TIMEOUT_MS`; stdout 16 MB, stderr 8 KB.
- `PDF` нь зураг болгон рендерлэгддэг (текст давхарга ашиглахгүй), тиймээс `dpi` ихсэх тусам удаан, санах ой их.
- Гараар бичсэн текст, гэрэл муутай/хэт эвдэрсэн зураг, эргэсэн (> ~2°) зураг найдваргүй. Эргэлт засах (deskew) энд ХИЙГДЭЭГҮЙ.
- Хөдөлгүүр нэг процесс тутамд CPU-г их ашиглана; DMS нь зэрэгцээ ажиллагааг `OCR_MAX_CONCURRENCY`-ээр хязгаарлана.
- Банкны хуулгын зураг: энэ багц зөвхөн текст/хайрцаг буцаана; хуулгын мөр parse хийх нь BSA parser-ийн хэрэг.

## Нууцлал (PII)

- Баримтын текст, талбарын утга, файлын нэр, регистр, данс **хэзээ ч** лог/алдааны мессежид орохгүй. `OcrError` мессеж тогтмол.
- Tesseract-ийн stderr алдааны мессежид орохдоо цэвэрлэгдэнэ (`scrubDiagnostic`: зөвхөн ASCII, 4+ цифр далдлагдсан, ≤ 160 тэмдэгт, түр замыг сольсон).
- Түр файл `mkdtemp` (0700) хавтсанд, `input.<ext>` нэртэй (клиентийн нэрийг ашиглахгүй), дуусмагц (алдаатай ч) устгана.
- Tesseract танигдаагүй файлыг "зургийн замуудын жагсаалт" гэж уншдаг (локал файл уншуулах эрсдэл), тиймээс provider **magic bytes-ийг заавал шалгаж**
  зөвхөн зураг/PDF-ийг дамжуулна.
- Fixture-ууд бүгд зохиомол (`SYNTHETIC_MARK`). Бодит баримтыг repo-д оруулахгүй.

## Туршилт

```bash
cd packages/ocr
npx vitest run                    # unit тестүүд; tesseract + mon хэл байвал бодит интеграцийн тест (үгүй бол алгасна)
npx vitest run src/integration    # зөвхөн бодит Tesseract
OCR_REPORT=1 npx vitest run src/integration   # талбар бүрийн хүснэгт
```

`@los/*` vitest дээр эх кодоос resolve хийгддэг; Nest/DMS-ийн runtime-д `dist` хэрэгтэй (`pnpm --filter @los/ocr build`).

**Хурдны (adversarial оролт) тест** — шинэ тестэд `expect(performance.now() - t0).toBeLessThan(5_000)` гэх мэт тогтмол wall-clock хязгаар тавихгүй:
CI-д олон багцын тест зэрэг ажиллахад процесс хоцорч, код өөрчлөгдөөгүй мөртлөө унадаг (ачаалалтай үед ~10 дахин удаашрахад л хангалттай).
Оронд нь `src/testing/scaling.ts`-ийн `expectNearLinear(prepare, size, { maxLargeMs })` ашиглана: `prepare(n)` нь оролтыг (хэмжилтийн гадна) бэлдэж,
боловсруулдаг thunk буцаана; оролтыг 8 дахин нэмэхэд **CPU хугацаа** (хоцрогдол тоологдохгүй, ачаалалд бага өртөнө; үлдэх нөлөөг харьцаа нь хасна)
~8 дахин (шугаман) өсдөг эсэхийг шалгана, квадрат хэрэгжилт ~64 дахин өсч унана. `maxLargeMs` нь харьцаанд харагдахгүй тогтмол удаашралыг барих өгөөмөр CPU таазлалт.
`src/**/testing/**` нь build (`dist`) болон coverage-аас хасагдсан. `names/amount/date/match-key/account` тестүүд хуучин wall-clock бюджетээ (1–3 с, бодит хугацаанаас 40+ дахин их) хэвээр
хадгалж байгаа; ачаалалд (нэг цөмд 20 завгүй процесс) тэсвэртэй нь шалгагдсан.
