# bsa/parsers — банкны хуулгын parser, verifier, хамрах хугацааны шинжилгээ

Хамрах хүрээ: docs/02 (BANK STATEMENT ANALYSIS) BSA-FR-2.1 (банк таних), 2.2 (parse + баталгаажуулалт), 2.3 (хуурамч байдлын шалгалт),
2.4 (хамрах хугацаа), BSA-BR-5 (цаг хэвлэгдэх эсэх), NFR-5 (шинэ банк = profile + нэг бүртгэл), NFR-8 (тодорхойгүй шийдвэр бүр анхааруулгатай).

## Ажиллаж байгаа байдал (ЧУХАЛ)

**Долоон банкны (Хаан, Голомт, ХХБ, Хас, Капитрон, Төрийн банк, М банк) формат БҮГД ТААМАГЛАЛ — бодит файлаар баталгаажаагүй.**
`/samples/` хавтсанд одоогоор зөвхөн README.md байгаа. Тиймээс:

- Банк бүрийн `*_PROFILE.verified === false`; verifier ямагт `UNVERIFIED_PARSER` анхааруулга гаргана.
- Багана, түлхүүр үг, цаг хэвлэх эсэх зэрэг нь `TODO(samples)` тэмдэглэгээтэй таамаглал. Тест, fixture бүхэн ЗОХИОМОЛ (SYNTHETIC) өгөгдөл.
- Бодит хуулга ирмэгц `Samples-ийн ажлын дараалал` хэсгийн алхмаар баталгаажуулна.

## Бүтэц

```
parsers/
  statement.types.ts          Гэрээ (StatementText, ParsedStatement, StatementParser, VerificationResult...) — зөвхөн нэмэгдэж болно
  bank-policy.ts              DEFAULT_BANK_POLICY (acceptsImages, printsNonStandardIban)
  parser.registry.ts          PARSERS токен, StatementParserRegistry, UnsupportedBankError, AmbiguousBankError
  parsers.module.ts           NestJS модуль (parser-ууд, registry, QR_VERIFIER, StatementVerificationService)
  coverage.ts                 analyzeCoverage, dedupeKey, dedupeAcrossStatements
  index.ts                    Нийтийн гадаргуу — бусад BSA дэд модуль ЗӨВХӨН эндээс импортлоно
  engine/                     Тохируулгаар удирддаг ЦӨМ хүснэгтэн хуулгын engine (банкны мэдлэггүй)
  banks/                      Банк бүрийн BankProfile + нимгэн класс; BANK_PARSERS нэг бүртгэл
  verifier/                   verifyStatement, authenticity, QrVerifier порт, StatementVerificationService
  tests/                      Robustness/fuzz, samples hook, fixture drift тест
```

Өгөгдлийн урсгал: `StatementText` (text-extraction-аас) -> `registry.parse(text, bank?)` -> `ParsedStatement` ->
`StatementVerificationService.verify(parsed, meta, options)` -> `VerificationResult`. Олон хуулгыг `analyzeCoverage` + `dedupeAcrossStatements` нэгтгэнэ.

## Engine (`engine/`)

Нэг engine (`TableStatementParser`) бүх банкийг `BankProfile` өгөгдлөөр удирдана. Банкны код engine-д байхгүй.

- Толгой хэсэг: шошго (`DEFAULT_HEADER_LABELS`) + утга (ижил нүд, дараагийн нүд, дараагийн мөр) -> данс, IBAN, нэр, регистр, хугацаа, валют, эхний/эцсийн үлдэгдэл, мөрийн тоо.
- Хүснэгтийн толгой: нүд бүрийг `@los/ocr`-ийн `toMatchKey`-ээр нормчилж синонимоор таньна (`DEFAULT_COLUMN_SYNONYMS`; хамгийн урт синоним ялна; кирилл/латин холимог зөвшөөрнө).
- Мөр унших гурван горим: нүд тоо толгойтой тэнцүү бол байрлалаар; PDF хоосон нүд хасаж өгвөл `alignBody` (динамик програмчлалаар тулгах); нэг нүдтэй мөр бол token-оор баруунаас.
  Олон мөрт тайлбар (wrap), давтагдсан толгой, дэд дүн/хуудасны хөл, олон хуудас дэмжигдэнэ.
- Чиглэл (орлого/зарлага): дебит/кредит багана, тэмдэгтэй дүн, төрлийн багана, тодорхой `+`, эс бөгөөс үлдэгдлийн өөрчлөлт. Дийлэнх мөр үлдэгдэлтэй зөрвөл багана сольж (`DIRECTION_SWAPPED`).
  Шинэ -> хуучин дараалалтай хуулгыг эргүүлнэ (`REVERSED_ORDER`).
- Нэмэлт үүрэг `ignoreAmount`: тоон дүнтэй боловч ашиглахгүй багана (мөр бүрийн "Эхний үлдэгдэл" гэх мэт).
- Анхдагч утгууд `engine/defaults.ts` дахь ГАНЦ газарт (`ENGINE_DEFAULTS`); `EngineOptions`-оор дарна.
- PII-г лог/анхааруулгын мессежид бичихгүй (тайлбар, нэр, данс, регистр байхгүй; зөвхөн код, хуудас, мөрийн дугаар).

### Parse анхааруулгууд (`engine/warnings.ts`, `PARSE_WARNING`)

| Код | Утга |
| --- | --- |
| UNPARSED_ROW | Мөр шиг харагдсан ч уншигдаагүй (verifier ERROR). Бүтэн тоо `ParsedStatement.unparsedRowCount` |
| REVERSED_ORDER | Шинэ -> хуучин дараалалтай байсан тул эргүүлсэн |
| DIRECTION_SWAPPED | Дебит/кредит системтэйгээр урвуу байсан тул сольсон |
| DIRECTION_FROM_BALANCE | Чиглэлийг үлдэгдлийн өөрчлөлтөөс тодорхойлсон |
| ROW_FALLBACK_LAYOUT | Мөр толгойн баганатай таараагүй тул token-оор уншсан |
| TABLE_HEADER_NOT_FOUND / TABLE_HEADER_CHANGED | Хүснэгтийн толгой олдоогүй / дунд нь өөрчлөгдсөн |
| HEADER_FIELD_CONFLICT / HEADER_FIELD_INVALID | Толгойн талбар зөрчилдсөн / буруу хэлбэртэй |
| PERIOD_DERIVED, CURRENCY_ASSUMED | Хугацааг гүйлгээнээс уламжилсан, валютыг анхдагчаар авсан |
| TIME_MISSING / TIME_UNEXPECTED | Банк цаг хэвлэдэг ч мөрөнд алга / хэвлэдэггүй ч гарсан |
| CONTINUATION_DROPPED, DATE_ONLY_LINE_MERGED, BALANCE_ROW_SKIPPED | Wrap, огноотой дан мөр, үлдэгдлийн мөр боловсруулсан тухай |
| WARNINGS_TRUNCATED | Нэг кодын анхааруулга `maxWarningsPerCode`-оос хэтэрсэн |

## Банк таних (`parser.registry.ts`)

- `parser.detect(text)` 0..1 оноо. Банкны нэрийн түлхүүр үг (гарчиг 0.45, толгой хэсэг 0.35) + хүснэгтийн толгой 0.25 + шошго/бүтцийн тэмдэг.
  Нэр олдоогүй бол оноо `noKeywordMax` (0.4)-ээс хэтрэхгүй. Гүйлгээний тайлбар дахь "Khan", "TDB" зэрэг үг оноонд нөлөөлөхгүй (зөвхөн толгой хэсэгт хайна).
- Registry: банк бүрийн хамгийн өндөр оноог авна; `minScore` (0.5)-аас доош бол `UnsupportedBankError`;
  өөр банкны хоёр оноо `ambiguityMargin` (0.05)-д багтвал `AmbiguousBankError` (хэрэглэгч гараар сонгоно). Parser throw хийвэл оноо 0.
- Гараар банк заавал (`parse(text, bank)`) detect-ийг алгасаж parse хийнэ; detect оноо `minScore`-оос доош бол `BANK_OVERRIDE_UNCONFIRMED` анхааруулга нэмнэ.
- `REGISTRY_DEFAULTS` нь ганц газар; `PARSER_REGISTRY_OPTIONS` токеноор (заавал биш) дарна. Алдааны мессежид зөвхөн банкны код, оноо байна.
- `registry.policyFor(bank)` -> `BankPolicy` (verifier ашиглана).

## Шинэ банк нэмэх (NFR-5)

1. `banks/<bank>.parser.ts` үүсгэнэ:
   - `export const <BANK>_PROFILE: BankProfile = { bank, parserId: '<bank>-table-v1', verified: false, nameKeywords, dateOrder, hasTime, acceptsImages, ... }`
   - `@Injectable() export class <Bank>StatementParser extends TableStatementParser { constructor() { super(<BANK>_PROFILE); } }`
2. `banks/index.ts` дахь `BANK_PARSERS` жагсаалтад нэг мөр нэмнэ (`BankCode` нь `@los/contracts`-д байх ёстой).
3. `banks/testing/bank-specs.ts` -> `BANK_SPECS` руу зохиомол layout нэмж, `<bank>.parser.test.ts` дотор `describeBankParser(spec)` дуудна (нийтлэг иж бүрэн тест).
4. `tests/fixtures-spec.ts`-д fixture нэмж `UPDATE_FIXTURES=1`-ээр үүсгэнэ.

Engine, registry, module-д өөрчлөлт хэрэггүй.

### `BankProfile` талбарууд

| Талбар | Утга |
| --- | --- |
| bank, parserId | `BankCode`, `ParsedStatement.parserId` |
| verified | Бодит samples-аар баталгаажсан эсэх. Одоо бүгд false |
| nameKeywords / rejectKeywords | Таних түлхүүр үг / таарвал энэ банк биш (жишээ нь State Bank of India) |
| structuralCues | Толгой хэсгийн нэмэлт regex тэмдэг |
| dateOrder | `DateOrder` (`@los/ocr`: 'YMD' | 'DMY' | 'MDY') — жил сүүлд байгаа тоон огнооны өдөр-сарын дараалал. Одоо бүгд 'DMY' (таамаглал) |
| hasTime | Цаг хэвлэгддэг эсэх. BSA-BR-5: Голомт, Хас, Капитрон false; бусад true |
| acceptsImages | Зураг хүлээн авах эсэх. Зөвхөн Хаан false (samples/README.md) |
| printsNonStandardIban | true бол IBAN_INVALID анхдагчаар WARNING. Одоо бүгд false (үндэслэл алга) |
| debitMeans | 'Дебит' баганын чиглэл (анхдагч EXPENSE) |
| columnSynonyms / headerLabels / skipLineKeys | Анхдагчид нэмэх синоним, шошго, алгасах мөрийн угтвар |
| spaceThousands | "1 234 567" дүнтэй нэг нүдтэй мөр (М банк) |

## Verifier (`verifier/`)

`verifyStatement(parsed, options, meta, qrVerified?)` цэвэр функц; `StatementVerificationService.verify(parsed, meta, options)` registry-ээс `policy`-г авч, QR порт дууддаг.
Анхдагч утга, түвшин `verifier/verify-defaults.ts` (`VERIFY_DEFAULTS`) дахь ганц газар. Issue бүр `severity` = `ERROR | WARNING | OFF` (options-оор дарна, NFR-6).
Мессежид PII байхгүй.

| Код | Анхдагч | Шалгалт |
| --- | --- | --- |
| NO_TRANSACTIONS | ERROR | Гүйлгээ байхгүй |
| ROW_COUNT_MISMATCH | ERROR | Хуулгад заасан мөрийн тоо, эсвэл уншигдаагүй мөр байна |
| BALANCE_CHAIN_BREAK | ERROR | Мөр бүрийн дараах үлдэгдэл = өмнөх +/- дүн (tolerance 0.01). `maxListedBreaks` хүртэл жагсаана |
| OPENING_BALANCE_MISMATCH / CLOSING_BALANCE_MISMATCH | ERROR | Эхний / эцсийн үлдэгдэл гинжтэй зөрсөн |
| BALANCE_UNAVAILABLE | WARNING | Үлдэгдэлтэй мөр `minBalanceCoverage`-аас цөөн тул гинж шалгаж чадахгүй |
| IBAN_INVALID | ERROR (policy-оор WARNING) | Хуулгад хэвлэгдсэн IBAN-ий бүтэц, шалгах цифр (`isValidIban`, `@los/ocr`) |
| NAME_MISMATCH / REGISTER_MISMATCH | ERROR | Хуулгын эзэмшигч LOS харилцагчтай таарахгүй. Хуулгад хэвлэгдээгүй эсвэл `customer` өгөөгүй бол шалгахгүй |
| DATE_ORDER | WARNING | Огнооны дараалал эвдэрсэн |
| PERIOD_MISMATCH | WARNING | Заасан хугацаа гүйлгээний огнооноос зөрсөн |
| DUPLICATE_ROWS | WARNING | Бүх талбараараа ижил мөр (dedupeKey) |
| IMAGE_NOT_ACCEPTED | ERROR | Зураг хүлээн авдаггүй банкны зураг (policy) |
| OCR_LOW_CONFIDENCE | WARNING | OCR дундаж итгэл `ocrMinConfidence`-аас бага |
| PDF_METADATA_SUSPICIOUS / PDF_MODIFIED | WARNING | PDF producer засварлагч/оффис хэрэгслийн тэмдэгтэй; modDate - creationDate > 60 с |
| QR_NOT_VERIFIED | WARNING (банк татгалзвал ERROR) | QR шалгагдаагүй. Зөвхөн зураг эсвэл QR-тай файлд шаардлагатай (`requiresQr`) |
| UNVERIFIED_PARSER | WARNING | Parser бодит samples-аар баталгаажаагүй |

Authenticity (`checkAuthenticity`): PDF producer/creator-ийг жижиг үсэг, үсэг-цифрээр нормчилж `suspiciousProducerSignatures`-тэй тулгана; modDate - creationDate зөрүү.
Эдгээр нь ЭВРИСТИК — банкны бодит PDF producer мэдэгдэхгүй.

QR (`qr-verifier.ts`): `QrVerifier` порт, `QR_VERIFIER` токен. Одоогоор `NullQrVerifier` (null = шалгаагүй) холбогдсон.
`TODO(bank API)`: банк бүрийн QR шалгах endpoint/нэвтрэх эрх олдсоны дараа тухайн банкны адаптер `useClass`-ыг солино. Service нь verifier throw хийвэл null гэж үзнэ.

## Хамрах хугацаа (`coverage.ts`)

- `analyzeCoverage(periods, required, options)`: `months` (шаардлагатай хугацаанд хамаарах календарийн сар бүр: тухайн сарын шаардлагатай өдрүүд БҮГД хуулгуудын нэгдлээр хамрагдсан эсэх),
  `gaps` (нэгдлийн хоосон хугацаа), `overlaps` (ЗӨВХӨН ижил данс — `bank|account` — дотор), `accountGaps` (дансны дотоод цоорхой), `ignoredPeriods` (буруу хугацаа).
  `gapToleranceDays` анхдагч 0 (`COVERAGE_DEFAULTS`).
- `dedupeKey` = огноо | цаг (минут) | дүн (2 орон) | чиглэл | үлдэгдэл | `toMatchKey(тайлбар)`. `dedupeAcrossStatements` нь multiset нэгдэл: хуулга ДОТОР жинхэнэ давтагдсан мөрийг хадгалж, хуулга ХООРОНД давхцсаныг арилгана.

## Тест

```
cd apps/scoring && npx vitest run src/modules/bsa/parsers
```

- `banks/*.parser.test.ts`: банк бүрийн зохиомол layout, detect, нэрийн хувилбар, near-miss.
- `engine/*.test.ts`: нэгжийн тест + layout матриц + 300 санамсаргүй layout.
- `parser.registry.test.ts`, `parsers.module.test.ts` (@nestjs/testing), `verifier/*.test.ts`, `coverage.test.ts`.
- `tests/robustness.test.ts`: хог/мутаци fuzz, гажиг оролт, 20 000 мөр < 3 с гүйцэтгэл, 5 MB мөр.
- `tests/fixtures.test.ts`: `test-fixtures/bsa/parsers/**` дахь зохиомол dump + `.expected.json`-ыг parse-тай тулгана (drift шалгалт).

### Fixture шинэчлэх

```
UPDATE_FIXTURES=1 npx vitest run src/modules/bsa/parsers/tests/fixtures
```

Fixture бүр `SYNTHETIC TEST DATA - NOT A REAL STATEMENT` гэсэн мөрөөр эхэлнэ. Бодит хувь хүний мэдээлэл ОРУУЛАХГҮЙ.

### Samples-ийн ажлын дараалал (parser-ийг баталгаажуулах)

1. Бодит хуулгыг (PDF/зураг, хувийн мэдээллийг нь нуусан) `samples/<bank>/` хавтсанд хийнэ (`samples/README.md`: khan, golomt, tdb, xac, capitron, state, m-bank; банк бүрт 5+ файл).
2. text-extraction-аар гарсан `StatementText`-ийг ижил нэртэй `.txt` dump болгон хажууд нь хадгална (жишээ `a.pdf` + `a.txt`). Dump-ийн хэлбэр (`engine/text-dump.ts`): хуудсыг form feed (`\f`), мөрийг шинэ мөр, нүдийг TAB-аар тусгаарлана.
3. `npx vitest run src/modules/bsa/parsers/tests/samples` — `tests/samples.test.ts` олдсон sample бүрийг parse хийж, verify хийнэ. `LOS_SAMPLES_DIR` орчны хувьсагчаар өөр хавтас зааж болно. Хавтас хоосон бол тест skip хийнэ.
4. Зөрүүг `BankProfile` (синоним, `dateOrder`, `hasTime`, түлхүүр үг) дээр засна. Engine-д банк тусгай код нэмэхгүй.
5. Үлдэгдлийн гинж, мөрийн тоо, нэр таарвал `verified: true` болгож `TODO(samples)`-ийг арилгана.

## Нууцлал

Лог, алдаа, анхааруулга, verifier мессежид регистр, дансны дугаар, нэр, гүйлгээний утга, OCR текст БИЧИХГҮЙ — зөвхөн код, тоо, хуудас/мөрийн дугаар.
