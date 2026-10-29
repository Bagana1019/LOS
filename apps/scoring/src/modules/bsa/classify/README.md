# bsa/classify — Гүйлгээний ангилагч

Банкны хуулгын гүйлгээг (parser-ийн гаралт) ангилалд хуваарилна: гар засвар, өөрийн данс хоорондын шилжүүлэг, дүрэм
(түлхүүр үг / харьцсан тал / regex), суваг (QPay/POS/ATM), "Бусад". Ангилсан гүйлгээг `../dti/` аггрегат хийж `@los/calc`-ийн
`computeBsaDti`-д өгнө. Цэвэр (stateless, I/O-гүй) функцүүд + нимгэн Nest wrapper (`ClassifierService`, `ClassifyModule`).

> АНХААР (UNVERIFIED): банкны бодит хуулгын формат, утгын үг хэллэг, банк бүрийн онцлог (цаг байгаа эсэх, IBAN-ийн бүтэц)
> нь БОДИТ ХУУЛГА байхгүй тул баталгаажаагүй. Анхдагч сан болон таних дүрмийг `TODO(samples)` тэмдэглэгээтэй, жишээ
> хуулга ирмэгц шалгаж засна. Тестийн өгөгдөл бүгд зохиомол (SYNTHETIC).

## Шаардлагын хамаарал

| Шаардлага | Хаана хэрэгжсэн |
|---|---|
| BSA-FR-3.1 (ангилал оноох, итгэл %, суваг таних) | `classifier.ts`, `rule-engine.ts`, `channel.ts`, `classify.defaults.ts` (`CLASSIFY_CONFIDENCE`) |
| BSA-FR-3.2 + BSA-BR-5 (өөрийн данс хоорондын шилжүүлгийг хасах) | `own-transfer.ts` |
| BSA-FR-3.3 (бөөнөөр шилжүүлэх) | `reclassify.ts` (`planReclassification`) |
| BSA-FR-3.4 (гар засвар → дүрмийн сан, ижил утгад санал болгох) | `reclassify.ts` (`suggestedRule`, source `FEEDBACK`) |
| BSA-FR-3.5 (admin-ы дүрмийн сан) | `default-catalog.ts`, `rule-engine.ts` (`compileRuleSet` алдаа мэдээлнэ), `ClassifierService.validateRules` |
| BSA-FR-3.6 + BSA-BR-7 ("Бусад" босго) | `other-share.ts` |
| NFR-9 (кирилл/латин/холимог бичлэг) | `normalize.ts` (`@los/ocr`-ийн `toMatchKey`) |

## Ангилах дараалал

`classifyTransactions(txns, ctx, opts?)` гүйлгээ бүрд доорх дарааллаар шалгаж, эхэлж таарсныг авна:

1. **Гар засвар** (`manualCategoryCode`) — итгэл 100. Өөрийн данс илрүүлэлтэд ОРОХГҮЙ.
2. **Өөрийн данс** (BSA-BR-5) — `isOwnTransfer = true`; орлого → `OWN_TRANSFER_IN`, зарлага → `NON_EXPENSE`.
3. **Дүрэм** — `rule-engine.ts` (доор).
4. **Суваг** — түлхүүр үг таараагүй, зарлага, суваг QPAY/POS/ATM бол `CHANNEL_EXPENSE` (итгэл 60). Орлогод суваг fallback байхгүй.
5. **Бусад** — `OTHER_INCOME` / `OTHER_EXPENSE` (итгэл 30).

Зөвхөн (2) `isOwnTransfer`-ийг тавина; дүрэм эсвэл гар засвар хэзээ ч тавихгүй.

Системийн таван ангилал `ctx.categories`-д ЗААВАЛ байх ёстой: `OWN_TRANSFER_IN`, `NON_EXPENSE`, `OTHER_INCOME`,
`OTHER_EXPENSE`, `CHANNEL_EXPENSE`. Байхгүй бол `ClassifierConfigError` (`assertSystemCategories`). Persistence давхарга эдгээрийг
устгахыг зөвшөөрч болохгүй.

## Итгэлийн оноо (НЭГ газар: `classify.defaults.ts`)

| Эх сурвалж | Итгэл % |
|---|---|
| Гар засвар (MANUAL) | 100 |
| COUNTERPARTY дүрэм | 95 |
| KEYWORD дүрэм | 85 (бүтэн хэллэг, хоёр захаараа үгийн хилтэй бол +5 = 90) |
| REGEX дүрэм | 80 |
| FEEDBACK дүрэм (аль ч төрөл) | 85 |
| Сувгийн fallback | 60 |
| Таарсангүй (Бусад) | 30 |
| Өөрийн данс: ДАНС яг / далдалсан | 95 / 80 |
| Өөрийн данс: ХОС цаг баталгаатай / баталгаагүй | 90 / 75 |
| Өөрийн данс: НЭР (Голомт) | 60 |

## Дүрмийн хөдөлгүүр (`rule-engine.ts`)

Эрэмбэ: `priority` буурахаар → `source` ADMIN нь FEEDBACK-ээс түрүүнд → хэв (pattern)-ийн нормчилсон урт буурахаар
(нарийн тодорхой нь түрүүлж) → төрөл (COUNTERPARTY, KEYWORD, REGEX) → оруулсан дараалал. Эхэлж таарсан нь ялна.

Priority зурвас (`RULE_PRIORITY`): WEAK 100, NORMAL 200, STRONG 300 (анхдагч сан), FEEDBACK 500, ADMIN дарах дүрэм ≥ 1000.

- **KEYWORD**: `toMatchKey` араг ясаар (кирилл/латин нэг түлхүүр) үгийн хил мэдэрдэг. Зүүн хил үргэлж шаардлагатай. Баруун хил:
  яг (бүтэн үг) эсвэл нөхцөл залгасан (prefix) — сүүлийн үгийн араг яс ≥ 4 тэмдэгт үед л. Тиймээс `цалин` → `цалингийн` таарна;
  `ус` нь `мусак`, `Rus`-д таарахгүй (зөвхөн бүтэн үг). Гүйлгээний утга болон харьцсан талын нэрийг хамтад нь хайна.
- **COUNTERPARTY**: харьцсан дансны дугаар эсвэл нэр ЯГ таарна (хэсэгчилсэн биш).
- **REGEX**: `regex-guard.ts` — ReDoS-оос хамгаалсан (доор). Дүрэм буруу/аюултай бол алгасаж `RuleIssue`-д мэдээлнэ; хэвийг
  алдааны текстэд хэзээ ч хуулбарлахгүй (PII).

Буруу дүрэм (үл мэдэгдэх/идэвхгүй ангилал, чиглэл зөрсөн, хоосон хэв, буруу regex, хүчингүй чиглэл/төрөл/priority) шидэхгүй,
алгасагдаж `issues`-д орно. Ингэснээр нэг муу дүрэм ангилалтыг унагахгүй.

### ReDoS хамгаалалт (`regex-guard.ts`)

Node-д regex timeout байхгүй тул ИНГЭЖ хамгаална: (а) статик шинжилгээ — давталтан доторх давталт/сонголт, backreference, 2-оос
олон хязгааргүй давтагч (`*`, `+`, `{n,}`), `{n,m}`-ийн m > 100, хоосон текстэд таарах хэв, 200 тэмдэгтээс урт хэв
татгалзана; (б) flag `iu`; (в) regex-д өгөх текстийг 300 тэмдэгтээр хязгаарлана. Хэвийг эх текст БА `toMatchKey` хоёр дээр хоёуланд нь шалгана.
Тестүүд (`regex-guard.test.ts`) хугацааны төсөвтэй.

## Суваг (`channel.ts`)

`ATM` → `QPAY` (SocialPay-г багтаасан) → `POS` → `TRANSFER` (харьцсан данс байгаа эсвэл "шилжүүлэг" гэх мэт үг) → `OTHER`.
Түлхүүр үгс `CHANNEL_KEYWORDS`-д НЭГ удаа, кирилл хэлбэрээр. `TODO(samples)`: банк тус бүрийн бодит утгын үг.

## Өөрийн данс хоорондын шилжүүлэг (`own-transfer.ts`, BSA-BR-5)

`detectOwnTransfers(txns, { ownAccounts, customerNames }, opts?)` → `{ findings, truncatedPairCandidates }`. Давуу дараалал: ДАНС > ХОС > НЭР.

1. **ДАНС**: харьцсан данс харилцагчийн данстай яг тэнцүү (IBAN-ийн сүүл ≥ 8 цифр дотоодын дугаартай харьцуулагдана) эсвэл
   далдалсан ('50****4567') бол сүүлийн ≥ 4 цифр + урд угтвар таарна.
2. **ХОС**: ӨӨР `statementKey`, эсрэг чиглэл, ижил огноо, ижил дүн (бүхэл минор нэгжээр, float-ийн алдаагүй). Цаг минутаар
   таарах ёстой, гэхдээ аль нэг тал GOLOMT/XAC/CAPITRON (хуулгад цаггүй) бол цаг шаардахгүй (итгэл 75). Хамгийн ойр цагаар
   (greedy), гүйлгээ бүр ХАМГИЙН ИХДЭЭ ГАНЦ хостой. Бүлэг (огноо+дүн) нэг талдаа 500-аас их бол тасалж `truncatedPairCandidates`-д тооцно.
3. **НЭР** (зөвхөн GOLOMT): утга эсвэл харьцсан талын нэрэнд харилцагчийн нэрийн ≥ 2 үг дарааллаар (дурын чиглэлээр, завсар ≤ 2 үг).

Гар засвартай гүйлгээ илрүүлэлтээс гадуур. `collectAccountsFromStatements(statements)` хуулгуудын `accountNo`/`iban`-аас
`ownAccounts`-ийг нэгтгэнэ (давхардал арилгана).

## "Бусад" босго (`other-share.ts`, BSA-BR-7)

`computeOtherShare(classified, categories, threshold)` — ОРЛОГО, ЗАРЛАГА тус тусад "Бусад" (groupCode `?`, үл мэдэгдэх кодыг оруулан)
дүнгийн хувь. Өөрийн шилжүүлэг, `dtiRole = EXCLUDE` ангиллыг хасна. Босго `0..1` (өөрөөр `RangeError`); хувийг BigInt ppm-ээр
харьцуулна — яг босготой тэнцүү бол ХЭТЭРЭЭГҮЙ. Босгыг энэ unit-д хатуу бичээгүй: `BsaSettings`-ээс ирнэ.

## Бөөнөөр дахин ангилах (`reclassify.ts`, BSA-FR-3.3 / 3.4)

`planReclassification({ txns, selectedKeys, targetCategoryCode, applyToSimilar, similarBy, categories })`:

- Зорилтот ангилал байх, идэвхтэй байх, чиглэл нь сонгосон гүйлгээнийхтэй ижил байх ёстой. Үгүй бол `ReclassifyError`
  (`EMPTY_SELECTION`, `UNKNOWN_CATEGORY`, `CATEGORY_INACTIVE`, `SELECTION_NOT_FOUND`, `DIRECTION_MISMATCH`).
- `similarBy = DESCRIPTION`: утгын "үндэс" — `toMatchKey`-ийн үгсээс цифр хассан үлдэгдэл (`Цалин 2026-03 #1234` = `Цалин 2026-04 #1299`).
  Үндэс < 3 тэмдэгт бол ерөнхийлөхгүй. `COUNTERPARTY`: бүтэн данс, үгүй бол нэр.
- Өмнө гараар засварласан ижил гүйлгээг дарж бичихгүй; чиглэл зөрөх гүйлгээнд хүрэхгүй.
- `suggestedRule`: source `FEEDBACK`, priority 500; сонгосон бүх гүйлгээ НЭГ үндэс/талтай үед л. `applyToSimilar`-аас үл хамаарна.
  PII АНХААР: үндэсд хүний нэр орсон байж болно, тиймээс дүрмийн санд хадгалахаас өмнө ADMIN хянаж батлах ёстой.

## Анхдагч сан (`default-catalog.ts`)

`DEFAULT_BSA_CATEGORIES` — 23 ангилал (12 орлого, 11 зарлага; docs/02 §4-ийн жин, бүлэг, `dtiRole`).
`DEFAULT_BSA_RULES` — 150 KEYWORD дүрэм, бүгд source `ADMIN`; priority нь WEAK/NORMAL/STRONG. Persistence unit эхний seed-ийг эндээс авна.
Үг хэллэг ЗОХИОМОЛ/ШАЛГАГДААГҮЙ (`TODO(samples)`). Мэдэгдэж буй санаатай орхилт: зарлагын "хүү" (хүү = хүүхэд гэсэн утгатай мөргөлддөг).

## Мөнгөн дүн

`money.ts`: дүнг бүхэл минор нэгж (×100) болгож BigInt-ээр нэмнэ (шинэ dependency нэмээгүй). `toMinorOrNull` нь NaN/Infinity/хэт том/тоо биш утганд
шидэхгүй `null` буцаана — нэг муу мөр бусдыг унагахгүй.

## Хэрэглээ

```ts
import { classifyTransactions, DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES, collectAccountsFromStatements, ownAccountKeys } from '../classify';

const ownAccounts = ownAccountKeys(collectAccountsFromStatements(statements));
const results = classifyTransactions(txns, {
  categories: DEFAULT_BSA_CATEGORIES,
  rules: DEFAULT_BSA_RULES,
  ownAccounts,
  customerNames: ['<овог нэр>'],
});
```

Nest: `ClassifyModule` импортлоод `@Inject(ClassifierService)`-ээр авна (бүх метод цэвэр функц руу дамжуулна).

## Гүйцэтгэл

20,000 гүйлгээ × 150 дүрэм < 2 сек (`classifier.test.ts` дотор хугацааны тест; ердийн ажиллагаа ≈ 0.5–0.8 сек).

## Тест

```bash
cd apps/scoring && npx vitest run src/modules/bsa/classify
```

Тестэд PII байхгүй (зохиомол өгөгдөл); бүх лог/алдааны мессеж утга, данс, нэр агуулахгүй.

## Нээлттэй асуудал

- Бодит хуулгын формат, банкны утгын үг, IBAN-ийн бүтэц, цаггүй банкуудын жагсаалт баталгаажаагүй (`TODO(samples)`).
- `ClassifyModule`-ийг app/BsaModule-д холбох нь энэ unit-ийн гадна.
