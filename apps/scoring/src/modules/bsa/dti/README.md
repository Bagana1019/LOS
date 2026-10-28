# bsa/dti — DTI аггрегат ба BsaSummary builder

Ангилсан гүйлгээг (`../classify/`) ангилал × сарын нийлбэр болгож `@los/calc`-ийн `computeBsaDti`-д өгч, үр дүнгээс LOS-д
бичих `BsaSummary` ба тооцооллын `BsaScoringInput`-ийг бүрдүүлнэ. Бүгд цэвэр функц (I/O-гүй) + нимгэн Nest wrapper.
DTI-ийн томьёо/босго энд БАЙХГҮЙ — зөвхөн `@los/calc`-д (нэг эх сурвалж).

> Бүх тоо **зохиомол** хуулга дээр гараар тооцож шалгагдсан. Бодит банкны хуулгаар баталгаажаагүй (parser-ууд `verified: false`);
> бүтэн баримт: `docs/05-bsa-ocr.md`.

## Хэн дууддаг (REST -> DTI)

`DtiModule` нь `BsaModule`-д холбогдсон. `import/recalculation.service.ts` нь `DtiAnalysisService.analyze` -> `buildBsaSummary` / `buildScoringInput`-ийг дуудна:

| REST | Юу тооцогдох |
| --- | --- |
| импорт дуусах (`ImportPipelineService`) | мөр хадгалах, ангилах, DTI, `DRAFT` хураангуй хадгалах (нэг транзакц) |
| `POST /bsa/analyses/:id/recalculate` `{proposedMonthlyPayment?, periodMonths?, costOfGoodsRate?}` | зөвхөн DTI (`DtiRunInput` өөрчлөгдөнө; `null` = анхдагч руу) |
| `POST /bsa/analyses/:id/recalculate` (бие хоосон) | ангилал + DTI бүгд |
| `POST /bsa/analyses/:id/reclassify`, `POST /bsa/rules {analysisId}` | өөрчлөгдсөн гүйлгээ + DTI |
| `POST /bsa/analyses/:id/finalize` | `BsaSummary` (INT-4) -> LOS; `ANALYZED` |
| `GET /bsa/analyses/:id/scoring-input` | `BsaScoringInput` (INT-5; зөвхөн ANALYZED) |
| `GET /bsa/analyses/:id/breakdown` | `details` (ангилал x сар, аргачлал): хадгалагдахгүй, ангилалаас дахин тооцоолно |

`BsaSettings`-ээс (`toDtiParams`): ББӨ (`costOfGoodsRate`), `maxDti`, Бага/Дунд/Өндөр завсар, `otherShareThreshold`, найдварын жин.
Кодонд хатуу бичсэн бизнес утга байхгүй.

## Шаардлагын хамаарал

| Шаардлага | Хаана |
|---|---|
| BSA-FR-4.2 / 4.4 (DTI тойм, орлого/зарлагын задаргаа) | `aggregate.ts` → `@los/calc` `computeBsaDti`, `dti-analysis.service.ts` |
| BSA-FR-4.8 (санал болгосон төлбөр ЭТХ-ээс) | `dti-params.ts` (`DtiRunInput`) |
| BSA-BR-3 (шинжилгээний хугацаа) | `filterByPeriod` |
| BSA-BR-5 (өөрийн шилжүүлэг хасах) | `aggregate.ts` (бүрэн хасна) |
| BSA-BR-7 ("Бусад" босго) | `DtiAnalysisService` (`otherShareThreshold`) → `classify/other-share.ts` |
| INT-4 (`BsaSummary` → LOS) | `summary.builder.ts` `buildBsaSummary` |
| INT-5 (`BsaScoringInput`: Тооцоолол B/C-д) | `summary.builder.ts` `buildScoringInput` |

## Урсгал

```
ClassifiedTxn[] ── filterByPeriod ──▶ aggregateCategoryMonthly ──▶ computeBsaDti(@los/calc)
   (BSA-BR-3)        (BSA-BR-5)                          │
                                                                          ▼
                                                  buildBsaSummary / buildScoringInput (zod баталгаажуулалт)
```

## aggregate.ts

- `filterByPeriod(items, periodFrom, periodTo)` — хоёр захыг оролцуулсан (inclusive). Огноо нь буруу (`YYYY-MM-DD` биш) гүйлгээг
  АЛДАЖ ХАЯХГҮЙ — aggregate дараа нь `INVALID_DATE` гэж мэдээлнэ. Буруу/урвуу хугацаа → `RangeError`.
- `aggregateCategoryMonthlyDetailed(classified, categories)` → `{ categories: BsaCategoryMonthly[], issues }`:
  - өөрийн шилжүүлэг (`isOwnTransfer`)-ийг бүрэн хасна;
  - идэвхтэй ангилал бүр гаралтад байна (гүйлгээгүй бол хоосон `monthly`);
  - сарын түлхүүр = `txnDate`-ийн `YYYY-MM`; нийлбэрийг BigInt минор нэгжээр (float-ийн алдаагүй), 2 оронтой;
  - асуудлыг тоолж `issues`-д цуглуулна: `UNKNOWN_CATEGORY`, `INACTIVE_CATEGORY` (гүйлгээтэй идэвхгүй ангилал), `DIRECTION_MISMATCH`,
    `INVALID_DATE`, `INVALID_AMOUNT` (сөрөг, NaN, Infinity, хэт том). Алдааны текстэд гүйлгээний утга/данс орохгүй.
- `aggregateCategoryMonthly(...)` — хатуу хувилбар: `issues` байвал `BsaAggregationError` шидэнэ (DTI-г чимээгүй буруу тооцохгүй).

## summary.builder.ts

- `buildBsaSummary(input)` — `BsaSummary` (INT-4); `buildScoringInput(input)` — `BsaScoringInput` (INT-5, `householdExpenseMonthly` орно).
- Гаралт `@los/contracts`-ийн zod схемээр `.parse` хийгдэнэ; тоон оролт (`transactionCount`, `pendingSuspiciousCount`, `version ≥ 1`)
  бүхэл, хязгаартай байх ёстой, `dtiResult`-ийн тоо төгсгөлтэй (зөвхөн `dtiRatio` Infinity байж болно) — үгүй бол `RangeError`.
- `pendingSuspiciousCount`, `reportPdfUrl`-ийг дуудагч өгнө (энэ unit-д эх сурвалж байхгүй).

## dti-params.ts

`toDtiParams(settings: BsaSettings, run)` — `BsaSettings`-ийг `BsaDtiParams` болгоно (бүтээгдэхүүний ББӨ override-тай). Бизнесийн утга
(ББӨ, дайчлах хувь, босго) энд хатуу бичигдээгүй — тохиргооноос.

## DtiAnalysisService

```ts
const out = dtiAnalysisService.analyze({ classified, categories, params, otherShareThreshold: settings.otherShareThreshold });
// out: { dti, categoryMonthly, transactionCount, ownTransferCount, outOfPeriodCount, otherShare }
```

`transactionCount` нь хугацаанд орсон БҮХ гүйлгээ (өөрийн шилжүүлгийг оруулан); `ownTransferCount` нь үүнээс хасагдсан хэсэг;
`outOfPeriodCount` — хугацаанаас гадуур тул тооцоонд ороогүй.

## Тест

```bash
cd apps/scoring && npx vitest run src/modules/bsa/dti
```

HTTP e2e (`import/e2e/bsa-api.e2e.test.ts`, бодит Postgres дээр мөн) нь `computeBsaDti`-г бүтэн урсгалаар дууддаг, гараар тооцсон утгатай:
суурь 27 гүйлгээ, баталгаажсан орлого 1,350,000, DTI орлого 1,215,000, 41.2% MEDIUM; «Борлуулалт» `BUSINESS_INCOME` болгоход 27.4% LOW;
төлбөр 700,000 үед 60.4% HIGH.

`dti-integration.test.ts` — `computeBsaDti`-г unit түвшинд ҮНЭХЭЭР дуудах файл (гараар тооцсон тоо: нийт сарын орлого 4,666,666.67,
баталгаажсан 2,700,000, DTI орлого 2,430,000, цэвэр мөнгөн урсгал 1,200,000, өр төлөлт 200,000, өрхийн зардал 100,000, DTI 20.6% LOW).
Бусад тест `computeBsaDti`-г дууддаггүй. Тестийн өгөгдөл зохиомол.

## Нээлттэй асуудал

- `BsaSummary` схемд `householdExpenseMonthly` байхгүй (зөвхөн `BsaScoringInput`, мөн `details.dti`-д).
- `@los/contracts` нь `BsaStatus` төрөл биш зөвхөн const tuple экспортолдог — энд локал төрөл тодорхойлсон.
- `details` хадгалагдахгүй (`summary_json`-ийн схем үл мэдэгдэх түлхүүр хасдаг): задаргаа авах бүрд ангилсан гүйлгээнээс дахин тооцоолно.
- `pendingSuspiciousCount` нь `SUSPICION_COUNTER` портоос (M12c хүртэл `NullSuspicionCounter` = 0).
- Хамтран зээлдэгчийн хүсэлтийн түвшний нэгтгэл (BSA-BR-9) энд ороогүй: шинжилгээ бүр нэг зээлдэгчийн.
