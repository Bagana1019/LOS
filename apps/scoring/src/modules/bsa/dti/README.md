# bsa/dti — DTI аггрегат ба BsaSummary builder

Ангилсан гүйлгээг (`../classify/`) ангилал × сарын нийлбэр болгож `@los/calc`-ийн `computeBsaDti`-д өгч, үр дүнгээс LOS-д
бичих `BsaSummary` ба тооцооллын `BsaScoringInput`-ийг бүрдүүлнэ. Бүгд цэвэр функц (I/O-гүй) + нимгэн Nest wrapper.
DTI-ийн томьёо/босго энд БАЙХГҮЙ — зөвхөн `@los/calc`-д (нэг эх сурвалж).

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

`dti-integration.test.ts` — `computeBsaDti`-г ҮНЭХЭЭР дуудах цорын ганц файл (гараар тооцсон тоо: нийт сарын орлого 4,666,666.67,
баталгаажсан 2,700,000, DTI орлого 2,430,000, цэвэр мөнгөн урсгал 1,200,000, өр төлөлт 200,000, өрхийн зардал 100,000, DTI 20.6% LOW).
Бусад тест `computeBsaDti`-г дууддаггүй. Тестийн өгөгдөл зохиомол.

## Нээлттэй асуудал

- `BsaSummary` схемд `householdExpenseMonthly` байхгүй (зөвхөн `BsaScoringInput`-д).
- `@los/contracts` нь `BsaStatus` төрөл биш зөвхөн const tuple экспортолдог — энд локал төрөл тодорхойлсон.
- `DtiModule`/`ClassifyModule`-ийг app/BsaModule-д холбох нь энэ unit-ийн гадна.
