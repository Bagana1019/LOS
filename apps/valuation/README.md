# @los/valuation

Port 4004. Барьцааны үнэлгээ: суурь үнэ, арга, haircut, гадны үнэлгээ, дахин үнэлгээ

DB schema: `valuation`. Модулиуд: valuation (машины зах зээлийн жишиг), collateral-valuation, base-price, haircut.

## Барьцааны үнэлгээ (Модуль 6, FR-14.1–14.6)

origination-ий барьцааны карт эндээс **системийн санал**, **haircut**-ыг авч, эцсийн үнэлгээг энд **хадгална** (`collateral_valuation`) бөгөөд
`ValuationCompleted` event нь үнэлгээтэй нэг транзакцид outbox-д бичигдэнэ (CLAUDE.md §3.2 дүрэм 4). Дуудагч нь `origination` (sync REST,
CLAUDE.md §3.1); хүрээ, хүсэлтийн төлөв, бичих эрхийг тэнд шалгана. Gateway `/api/valuation/valuate/collateral`-ийг ажилтанд нээхгүй (зөвхөн дотоод).
Модулиуд: `collateral-valuation`, `base-price`, `haircut` (+ дээрх `valuation` нь машины зах зээлийн жишиг). Цэвэр томьёо нь
`@los/calc` `collateral-value.ts` (100% coverage); энд I/O, хадгалалт, шийдвэрийн дараалал л байна.

### Endpoint-ууд

| Endpoint | Эрх | Статус | Зориулалт |
| --- | --- | --- | --- |
| `POST /api/valuate/collateral/suggest` | `application:read` | 200 | Системийн санал + haircut. **Юу ч хадгалахгүй.** POST: тайлбарт улсын дугаар орно, URL/access log-д гарах ёсгүй |
| `POST /api/valuate/collateral` | `application:read` | 201 | Дотоод үнэлгээ хадгалах (FR-14.2). Санал серверт **дахин** бодогдоно: клиентийн хуулбарт итгэхгүй |
| `POST /api/valuate/collateral/external` | `application:read` | 201 | Гадны лицензтэй үнэлгээчний дүн (FR-14.3). Тайлангийн `reportFileId` заавал |
| `GET /api/valuate/collateral/:collateralId/history` | `application:read` | 200 | Үнэлгээний түүх `{ items }` (FR-14.6): `valuedAt`, дараа нь `createdAt`, `id`-аар, org-оор хязгаарлагдсан. Үнэлгээгүй/үл мэдэгдэх id нь хоосон жагсаалт |
| `GET /api/base-prices?assetType&history` | `application:read` | 200 | Суурь үнийн жагсаалт (массив): түлхүүр бүрийн **өнөөдөр** хүчинтэй сүүлийн хувилбар; `history=true` бол бүх хувилбар |
| `POST /api/base-prices` | `settings:manage` | 201 | Нэг үнэ нэмэх. Үргэлж **шинэ хувилбар** (`version = max + 1`), өмнөхийг дарахгүй (FR-14.5) |
| `POST /api/base-prices/import` | `settings:manage` | 201 | ≤ 5000 мөр, бүгд эсвэл юу ч биш (нэг транзакц). Хариу `{ created, byAssetType }` |
| `GET /api/haircuts?productId&assetType&includeInactive` | `application:read` | 200 | Haircut дүрмийн жагсаалт (массив). `productId=null` гэвэл зөвхөн бүх бүтээгдэхүүний (org-wide) дүрэм |
| `PUT /api/haircuts` | `settings:manage` | 200 | `(productId \| org-wide, assetType)`-аар upsert, `haircutRate` 0…1, **4 орноос ихгүй** аравтын (бөөрөнхийлөхгүй, 400) |
| `DELETE /api/haircuts/:id` | `settings:manage` | 200 | Идэвхгүй болгоно (soft delete, давтахад зөвшөөрнө), хариу нь дүрмийн view. Үл мэдэгдэх id 404 `HAIRCUT_NOT_FOUND` |

Хүсэлтийн хэлбэр нь `@los/contracts` `dto/collateral-valuation.ts` (`SuggestValuationRequest`, `SaveCollateralValuationRequest`,
`RecordExternalValuationRequest`, `BasePriceInput`, `HaircutRuleInput`). `description` нь `COLLATERAL_DESCRIPTION_SCHEMAS[assetType]`-аар энд
**дахин** шалгагдана (400 `VALIDATION_FAILED`, `details[].path = description.*`). Огноо (`valuedAt`, `validUntil`, `validFrom`) нь
Улаанбаатарын (UTC+8, тогтмол) хуанлийн өдөр: зөвхөн огноотой утга тухайн өдрийн 00:00 UB-д буудаг.

### Санал (suggest) хөрөнгийн төрлөөр

| `assetType` | `method` | Арга |
| --- | --- | --- |
| `VEHICLE` | `VEHICLE_MARKET_COMPARABLES` → `VEHICLE_BASE_PRICE` | 1) АТҮТ + зарын жишиг (`/valuate/auto` логик). 2) Боломжгүй бол суурь үнэ(make, model, он) × элэгдэл × гүйлтийн хасалт. 3) Суурь үнэгүй бол санал **байхгүй** |
| `APARTMENT`, `HOUSE` | `REALTY_BASE_PRICE` | дүүрэг/хорооны ₮/м² × талбай × давхар (зөвхөн орон сууц) × зориулалт × барилгын насны коэффициент. Хорооны үнэ байвал түүнийг, үгүй бол дүүргийнхийг |
| `LAND` | `LAND_BASE_PRICE` | дүүрэг/хорооны ₮/м² × талбай × газар ашиглалтын коэффициент |
| `LIVESTOCK` | `LIVESTOCK_UNIT_PRICE` | (төрөл, нас) нэгж үнэ × толгой |
| `INVENTORY`, `EQUIPMENT`, `OTHER` | байхгүй (`MANUAL_VALUE_ASSET`) | ЗЭЗ дүнг гараар оруулна (`manualValueRequired = true`). Бараанд тооллогын дүн/огноо `basis`-д давтагдана |

Машины санал байхгүй байх шалтгаан: `VEHICLE_NOT_FOUND` (АТҮТ-д дугаар алга, 404 **биш** 200-д `available=false`), `INSUFFICIENT_DATA` (жишиг зар
цөөн, суурь үнэгүй), `SOURCE_UNAVAILABLE` (АТҮТ/зарын сайт унасан, суурь үнэгүй). АТҮТ унасан үед суурь үнийг гараар бичсэн тайлбараас
(`make`, `model`, `manufactureYear`) авч, `basis.vehicleSource = DESCRIPTION`; ингэж fallback хийсэн шалтгаан `basis.fallbackReason`-д.
Хөрөнгө/суурь үнийн түлхүүр олдохгүй бол `NO_BASE_PRICE`. Бодогдсон дүн `(0, 1e12]`-оос гадуур бол санал болгохгүй (`INSUFFICIENT_DATA`).
`warnings`: `MILEAGE_NOT_PROVIDED`, `LOW_CONFIDENCE`, `BASE_PRICE_STALE` (суурь үнэ `basePriceStaleDays`-аас хуучин), `DEMO_PARAMETERS` (доорх DEMO
коэффициент хэрэглэгдсэн). `basis` нь тооцооны орц бүрийг (үнэ, `version`, `validFrom`, коэффициент) агуулна: **улсын дугаар, өмчлөгч, гудамжны хаяг орохгүй**.

`HOUSE`-ийн суурь үнэ барилгын үнэ: тайлбар дахь `landAreaM2` дүнд **нэмэгдэхгүй** (`basis.landValued = false`); газрыг тусад нь `LAND`
барьцаа болгох эсвэл `marketValue`-г шалтгаантайгаар засна.

### Haircut ба шийдвэрийн дүрэм

- **Haircut-ын дараалал** (`HaircutSource`): `PRODUCT_RULE` (бүтээгдэхүүн + төрөл, `haircut_rule`) > `PRODUCT_JSON` (хүсэлтийн `productHaircutRate`, `product.haircut_json`) >
  `ORG_RULE` (бүх бүтээгдэхүүн + төрөл) > `DEMO_DEFAULT` (доорх хүснэгт). `collateralValue = marketValue × haircut` (30 000 000 × 0.7 = 21 000 000, docs/04 M6 AC).
- **Шалтгаан** (`OVERRIDE_REASON_REQUIRED`, 422): гараар оруулдаг төрөл (бараа, тоног төхөөрөмж, бусад) биш ба (санал байхгүй **эсвэл** эцсийн дүн саналаас
  2 орон хүртэл бөөрөнхийлөхөд ялгаатай) үед заавал. Саналтай ижил дүнтэй хамт ирсэн илүү шалтгааныг хадгалахгүй. Санал байхгүй, `marketValue` өгөөгүй бол 422 `MARKET_VALUE_REQUIRED`.
- **Арга**: дүн саналтай ижил бол саналын `method`, өөрөөр `MANUAL` (бараа бол `INVENTORY_STOCKTAKE`); гадны бол `EXTERNAL_APPRAISAL`.
- **Гадны үнэлгээ заавал** (`externalRequired`): `externalValuationThreshold != null && marketValue >= threshold`. Босгыг бүтээгдэхүүнээс origination дамжуулна.
- **Хүчинтэй хугацаа**: дотоод = `now + validityDays`; гадны = `valuedAt + validityDays`, эсвэл тодорхой `validUntil` (тэр өдрийн төгсгөл, UB). Алдаа: `VALUED_AT_IN_FUTURE`,
  `VALID_UNTIL_INVALID` (`validUntil <= valuedAt`) 422; бодит бус хуанлийн өдөр 400.
- **Хадгалалт**: нэг транзакцид (барьцаа бүрт advisory lock-той) projection `collateral` (тайлбараас `address.detail`, `location` хасагдсан) + `collateral_valuation`
  (`method_json = { suggestion, haircut, note? }`: дахин гаргах орц) + outbox `ValuationCompleted`. Аль нэг нь унавал бүгд буцна.
  Улсын дугаар/өмчлөгчийн мэдээлэл аудит, лог-д орохгүй.

### Суурь үнэ (`base_price`)

- Түлхүүр (`key_json`): машин `{ make, model, year }`, үл хөдлөх `{ district, khoroo? }`, мал `{ livestockType, ageGroup }`. Түлхүүрийг хэвийн болгоно: хоосон зайг цэгцлэх,
  дүүргийн төгсгөлийн "дүүрэг" нэмэлтийг хасах, **том/жижиг үсгийг ялгана** (`Toyota` ≠ `toyota`; нормчлол нь adapter/админы үүрэг). Мужийг (аймаг) түлхүүрт агуулаагүй тул
  УБ-аас гадуурх ижил нэртэй дүүрэг давхцана (нээлттэй асуулт).
- Хувилбар: `(org, assetType, key)` бүрт `version` өснө; `validFrom` нь тухайн огнооноос хүчинтэй. `validFrom`-д нь (УБ-ын өнөөдөр) хүрсэн хувилбаруудаас **хамгийн их `version`**
  хэрэглэгдэнэ; ирээдүйн `validFrom`-тэй хувилбар тэр өдөр хүртэл хэрэглэгдэхгүй. Өмнөх хувилбар түүхэнд үлдэнэ (`history=true`).
- Импорт: бүгдийг эхлээд шалгаж 422 `BASE_PRICE_IMPORT_INVALID` (`details`: мөрийн индекс + `BASE_PRICE_KEY_MISMATCH` / `BASE_PRICE_DATE_INVALID` / `BASE_PRICE_DUPLICATE`),
  дараа нь нэг транзакцид 1000-аар `createMany`. (org, төрөл) бүрт нэг зэрэг нэг л бичигч ажиллана (advisory lock), тиймээс `version` давхцахгүй.
- Body хязгаар `JSON_BODY_LIMIT = 2mb` (`src/configure-app.ts`; 5000 мөр Express-ийн анхдагч 100 kB-аас их). **Gateway-ийн хязгаарыг тусад нь шалгана.**

### DEMO параметрүүд ба тэдгээрийг солих

Бизнес баталгаажуулаагүй бүх тоо `// DEMO:` тэмдэглээтэй, нэг газраас солигдоно. Ашиглагдаж буй үед санал `DEMO_PARAMETERS` анхааруулгатай гарна (production-д энэ анхааруулга алга болтол DEMO-г солих ёстой).

| Юу | Одоогийн DEMO утга | Хаана | Хэрхэн солих |
| --- | --- | --- | --- |
| Машин: суурь үнийн элэгдэл | жилд 3%, дээд 50% | `modules/collateral-valuation/demo-collateral-pricing.ts` `vehicle` | `COLLATERAL_PRICING_SETTINGS`-д `origination.settings` projection (`CollateralPricingSettings`) холбох. Суурь үнийн жагсаалт одоо **шинэ машины** лавлах үнэ гэж үзнэ; жагсаалт нь хуучирсан (зах зээлийн) үнэ бол элэгдлийг 0 болгоно |
| Машин: гүйлтийн хасалт | жилд 15 000 км үнэгүй, давсан 10 000 км тутамд 1%, дээд 20% | мөн `vehicle` | мөн дээрхтэй адил |
| Давхрын коэффициент (орон сууц) | подвал 0.85, 1-р давхар 0.95, дунд 1, дээд 0.97 | `realty.floor` | мөн |
| Зориулалтын коэффициент | RESIDENTIAL 1, COMMERCIAL 1.15 | `realty.purpose` | мөн |
| Барилгын насны коэффициент | ≤5 жил 1.05, ≤15 1.0, ≤30 0.9, илүү 0.8, үл мэдэгдэх 0.95 | `realty.buildingAge` | мөн |
| Газар ашиглалтын коэффициент | RESIDENTIAL 1, COMMERCIAL 1.2, AGRICULTURAL 0.3, INDUSTRIAL 0.9, OTHER 0.8 | `land.landUse` | мөн |
| Суурь үнэ "хуучирсан" босго | 365 хоног | `basePriceStaleDays` | мөн |
| Haircut-ын сүүлийн fallback | VEHICLE .7, APARTMENT .8, HOUSE .75, LAND .6, LIVESTOCK .5, INVENTORY .5, EQUIPMENT .6, OTHER .4 | `defaultHaircuts` | Бодит утга `PUT /api/haircuts` (`ORG_RULE` / `PRODUCT_RULE`) эсвэл `product.haircut_json`. DEMO_DEFAULT-д хүрэхгүй болтол дүрмийг оруулна |
| Машины зах зээлийн жишгийн параметр | дээрх "Тооцооллын арга" хэсэг | `modules/valuation/demo-valuation-settings.ts` (`demo = true`) | `VALUATION_SETTINGS` token |
| Суурь үнэ (65 мөр), haircut дүрэм (seed) | `validFrom 2026-01-01`; УБ-ын 9 дүүрэг (орон сууц/байшин/газар), 3 хорооны орон сууц, мал 10, mock машин 5 × 5 он | `prisma/seed-data.ts` (`seedValuation`) | Seed нь **create-only** (давтахад давхардуулахгүй, админы оруулсан үнийг дарахгүй). Бодит үнийг `POST /api/base-prices/import`-оор оруулна; DEMO мөрүүд түүхэнд үлдэх тул шинэ `validFrom` өгнө |

Бүх DEMO үнэ **бодит зах зээлийн өгөгдөл биш**: бизнес баталгаажуулах хүртэл `docs/DECISIONS.md` M6-д бичигдсэн таамаглал.

### Алдааны код (энэ модулийн)

| HTTP | `code` | Тохиолдол |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | буруу body/`description`/огноо/`haircutRate` (4 оронгоос олон) |
| 404 | `HAIRCUT_NOT_FOUND` | идэвхгүй болгох дүрэм олдсонгүй |
| 422 | `MARKET_VALUE_REQUIRED`, `OVERRIDE_REASON_REQUIRED`, `VALUED_AT_IN_FUTURE`, `VALID_UNTIL_INVALID`, `BASE_PRICE_IMPORT_INVALID` | дээр тайлбарласан |
| 401/403 | `UNAUTHENTICATED`, `FORBIDDEN` | `/auto`-той адил |

### Дуудагчид (origination)

- Машины `suggest`/хадгалах нь АТҮТ + зарын сайтыг дууддаг тул нийт хугацаа 15с хүртэл. origination энэ дуудлагад дотоод sync-ийн 3с timeout-ыг **хэрэглэж болохгүй**: ≥ 20с.
- `ValuationCompleted`-ийг origination сонсоно (барьцааны LTV, ачаалал); at-least-once тул `eventId`-аар давхардлыг хаана. Outbox relay нь тестэд унтраастай (`OUTBOX_RELAY=off`).
- `reportFileId` нь `dms` дахь файл гэдгийг энд **шалгахгүй** (valuation нь dms-г sync дууддаггүй, CLAUDE.md §3.2 дүрэм 2): шалгах нь origination-ий үүрэг.

## Автомашины зах зээлийн үнийн автомат санал (FR-14.1, FR-14.2)

Албан тушаалтан улсын дугаар (жишээ нь `УЕН5246`) оруулахад сервис:

1. АТҮТ-ийн бүртгэлээс машины марк, загвар, үйлдвэрлэсэн он, хөдөлгүүр, өмчлөгчийг авна;
2. зарын сайтуудаас (unegui.mn төрлийн) ижил марк/загварын, он ±1 жилийн зарыг зэрэгцээ татна;
3. он/гүйлтийн зөрүүгээр засварласан зарын үнийн медианыг **зах зээлийн үнийн санал** болгон буцаана.

`marketValue` нь зөвхөн **санал** (FR-14.2): албан тушаалтан шалтгаан заан засч болно. Haircut (барьцааны үнэлгээ = зах зээлийн
үнэ × haircut), `collateral_valuation`-д хадгалах, `ValuationCompleted` event нь docs/04 Модуль 6 болон дуудагч талын ажил.
Endpoint нь stateless: юу ч хадгалахгүй.

### Endpoint-ууд

Дуудагч нь `origination` (CLAUDE.md §3.2 дүрэм 2); `/api` угтвартай, DTO нь `@los/contracts` (`dto/valuation.ts`).
Улсын дугаар URL/access log-д орохгүйн тулд хоёулаа `POST`. Gateway-ээр `/api/valuation/valuate/...` гэж дуудна
(gateway `/api/valuation`-ийг `/api` болгон шилжүүлнэ).

| Endpoint | Эрх | Body | Зориулалт |
| --- | --- | --- | --- |
| `POST /api/valuate/vehicle-lookup` | `customer:read` | `{ "plateNo": "уен 5246" }` | АТҮТ-ээс машины мэдээлэл авах. **Өмчлөгчийн регистр/нэр зөвхөн энд** буцна |
| `POST /api/valuate/auto` | `application:read` | `{ "assetType": "VEHICLE", "plateNo": "УЕН5246", "mileageKm": 90000 }` | зах зээлийн үнийн санал; `mileageKm` заавал биш (орхих эсвэл `null`; АТҮТ-д гүйлт байхгүй). Зөвхөн 1…2 000 000 бүхэл тоо: `0`, сөрөг, бутархай утга татгалзана |
| `GET /api/health` | нийтийн | | `{ "service": "valuation", "ok": true, ... }` |

**Нэвтрэлт.** Module 0-ийн `CommonModule`-ийн глобал guard ажиллана (CLAUDE.md §3.2 дүрэм 9): gateway-ийн `X-User-Id`, `X-Roles`,
`X-Org-Id` толгой шаардлагатай (`INTERNAL_AUTH_SECRET` тохируулсан бол `X-Internal-Token` ч). Толгой байхгүй бол 401 `UNAUTHENTICATED`;
эрхгүй дүр (жишээ нь зөвхөн `X-Customer-Id` бүхий зээлдэгч) 403 `FORBIDDEN`. Өмчлөгчийн хувийн мэдээлэл буцдаг `vehicle-lookup` нь
`customer:read`, өмчлөгчгүй `auto` нь `application:read` шаардана (OFFICER, BRANCH_MANAGER, APPROVER, ADMIN дүр хоёр эрхийг хоёуланг нь агуулна).

Улсын дугаар: 4 цифр + 2-3 кирилл үсэг, аль ч дарааллаар (`УЕН5246`, `1234УБА`). Зай/зураас арилгаж, том үсэг болгож
хэвийн болгоно (`уен 5246` → `УЕН5246`). Латин үсэг татгалзана.

Хүсэлтийн `X-Correlation-Id` толгойг (`[A-Za-z0-9._-]`, ≤128 тэмдэгт) `@los/nest-common`-ийн `RequestContextMiddleware` хариунд тусгана;
байхгүй эсвэл хэлбэр нь өөр бол UUID үүсгэнэ. Validation-ээс өмнө ажилладаг тул 200, 400, 401, 404, 502 бүгдэд орно, алдааны body-д ч
`correlationId` орно. Зөвхөн body parser-ийн өөрийн татгалзал (буруу JSON, хэт том body) middleware-ээс өмнө гардаг тул толгойгүй,
`correlationId: null`-тай ирнэ (суурийн онцлог, энэ сервисийнх биш).

**Хугацаа.** Бүх гадаад дуудлага (АТҮТ, зарын сайтууд) нийлээд `externalTimeoutMs` (15с, CLAUDE.md §3.1) нэг төсөвтэй: АТҮТ өөрөө
төсвийн нэг хэсгийг ашиглавал зарын сайтуудад үлдсэн хугацаа л олгогдоно. Дуудагч (`origination`) энэ endpoint-д дотоод sync
дуудлагын анхдагч 3с timeout-ыг **ашиглаж болохгүй**: `externalTimeoutMs`-ээс урт timeout (≥ 20с) тохируулна, `kyc`-ийн `inquiry/fetch`-тэй адил.

Жишээ: `POST /api/valuate/auto` (хариуг товчилсон)

```json
{
  "assetType": "VEHICLE",
  "status": "OK",
  "valuedAt": "2026-10-28T09:37:16.731Z",
  "request": { "plateNo": "УЕН5246", "mileageKm": 90000 },
  "vehicle": { "plateNo": "УЕН5246", "make": "Toyota", "model": "Prius", "manufactureYear": 2012, "importYear": 2016, "engineCc": 1798, "fuelType": "HYBRID" },
  "estimate": {
    "marketValue": 25810000, "lowValue": 25480000, "highValue": 25940000, "meanValue": 25750000,
    "sampleSize": 11, "confidence": "HIGH", "currency": "MNT", "method": "MARKET_COMPARABLES_V1"
  },
  "comparables": [
    {
      "source": "MOCK_UNEGUI", "externalId": "UN-PRIUS-001", "title": "Toyota Prius 2012", "year": 2012, "mileageKm": 84000,
      "listedPrice": 25800000, "currency": "MNT", "priceMnt": 25800000, "adjustedPriceMnt": 25645200,
      "included": true, "exclusionReason": null
    },
    { "source": "MOCK_UNEGUI", "externalId": "UN-PRIUS-009", "adjustedPriceMnt": null, "included": false, "exclusionReason": "MODEL_MISMATCH" }
  ],
  "sources": [
    { "id": "ATUT", "kind": "GOVERNMENT_REGISTRY", "status": "OK", "count": 1, "errorCode": null },
    { "id": "MOCK_UNEGUI", "kind": "CLASSIFIED_ADS", "status": "OK", "count": 9, "errorCode": null },
    { "id": "MOCK_ADS_B", "kind": "CLASSIFIED_ADS", "status": "OK", "count": 6, "errorCode": null }
  ],
  "parameters": { "usdMnt": 3500, "yearTolerance": 1, "minComparables": 3, "externalTimeoutMs": 15000 },
  "warnings": []
}
```

(`comparables`, `sources`, `parameters` бүтнээрээ буцна; товчилсон мөрүүд, нэмэлт талбарууд хасагдсан.)
Хариу бүхэлдээ `collateral_valuation.method_json`-д хадгалахад тохирсон: оролт (`request`), үнийг дахин гаргахад шаардлагатай
`parameters`, эх сурвалж, зар бүрийн оролцсон/хасагдсан шалтгаан орсон. **Өмчлөгчийн мэдээлэл орохгүй** (хувийн мэдээлэл):
хэрэв origination өмчлөгчийг хадгалах бол `vehicle-lookup`-ийн хариунаас авч `encryptedField`-оор (CLAUDE.md §6.5) хадгална.

`status`:

| Утга | Утга учир |
| --- | --- |
| `OK` | `estimate` байгаа |
| `INSUFFICIENT_DATA` | хүчинтэй зар `minComparables`-аас цөөн; `estimate = null`, `comparables` харуулна. HTTP 200 хэвээр |

`warnings`: `SOURCE_UNAVAILABLE` (зарын сайтын аль нэг нь хариулсангүй; үнэлгээ бусдаар үргэлжилнэ, `sources`-д `ERROR` + `errorCode`),
`MILEAGE_NOT_PROVIDED` (гүйлт оруулаагүй тул гүйлтийн засвар хийгдээгүй), `LOW_CONFIDENCE` (`confidence = LOW`).

Алдаа (body нь суурийн хэлбэр `{ code, message, details?, correlationId }`, `message` монгол):

| HTTP | `code` | Тохиолдол |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | буруу улсын дугаар/`assetType`/`mileageKm`; `details: [{ path, message }]`. Татгалзсан **улсын дугаарыг** буцааж хэвлэхгүй (`assetType`-ын "Invalid enum value" мессеж өгөгдсөн утгыг нэрлэж болно) |
| 401 | `UNAUTHENTICATED` | gateway-ийн identity толгой байхгүй |
| 403 | `FORBIDDEN` | шаардлагатай эрхгүй дүр |
| 404 | `VEHICLE_NOT_FOUND` | АТҮТ-д бүртгэлгүй дугаар |
| 502 | `REGISTRY_UNAVAILABLE` | АТҮТ хариулсангүй/алдаа/timeout (15с), эсвэл adapter-ийн хариу гэрээнд нийцэхгүй (`BAD_RESPONSE`). Зарын сайт унахад 502 **болохгүй**: `sources[].status = ERROR` |

Adapter-ийн хариуг (АТҮТ-ийн бичлэг: `@los/contracts` `VehicleInfo`; зарын жагсаалт: `VehicleListingSchema`) сервис шалгана. Нэг ч зар
гэрээнд нийцэхгүй бол тухайн сайт `ERROR` + `errorCode: BAD_RESPONSE` болно (зарыг тал нь үлдээхгүй). Гэрээ: сайт тутамд ≤ 1000 зар,
`price` төгсгөлөг тоо, `url` нь `http(s)` эсвэл `null`, тэмдэгт мөрүүд урттай (`title` ≤ 300 гэх мэт), `postedAt` нь ISO 8601
(цагийн бүсгүй бол UTC; өөр хэлбэрийг `STALE_LISTING` гэж хасна), `year` бүхэл тоо. Зөрчлийн лог нь зөвхөн талбарын зам, zod код
(`0.make:invalid_type`) бичнэ, утгыг бичихгүй.

Лог: `bootstrapService` нь `@los/nest-common`-ийн `JsonLogger`-ийг тавьдаг тул мөр бүр нэг JSON объект (`ts`, `level`, `service`, `context`,
`msg`, хүсэлтийн `correlationId`, `extra`). Үйл явдал нь `msg` (`registry_failed`, `listing_source_failed`, `adapter_contract_violation`),
`extra` нь зөвхөн `source`, `code`, талбарын зам. Улсын дугаар, өмчлөгч, adapter-ийн мессеж лог-д орохгүй. Тохиргооны утга
`NaN`/дутуу байвал (`@los/calc` `RangeError`) endpoint 500 өгнө: шалгалтыг чимээгүй унтраахгүй.

### Тооцооллын арга (`MARKET_COMPARABLES_V1`, `@los/calc` `estimateMarketPrice`)

1. Хасах: үнэ буруу эсвэл `minPriceMnt`-ээс бага ("1" гэж бичсэн "договорная" мэт), валют MNT/USD биш, загвар таарахгүй (нормчилсон марк+загвар **яг** тэнцэх; `+` ба аравтын цэг ялгагдана:
   `Prius+` ≠ `Prius`, `Vitz 1.0` ≠ `Vitz 10`), он `yearTolerance`-ээс хол, `maxListingAgeDays`-ээс хуучин (цагийн бүсгүй огноог UTC гэж уншина).
2. Засвар: нэг жилийн зөрүүд `yearAdjustmentRate`, 10 000 км-ийн зөрүүд `mileageAdjustmentPer10kKm`; нийт засвар `±maxTotalAdjustment`.
   Үнэ болон засварласан үнийг бүтэн ₮ болгон бөөрөнхийлнө.
3. IQR (Tukey) аргаар хэтэрсэн үнийг хасах (`OUTLIER`), дээж ≥ `outlierMinSample` үед. IQR нь медианы `outlierMinRelativeSpread`-аас
   багагүй: бараг ижил үнэтэй зарууд бие биеэ хэтэрсэн гэж буруу тэмдэглэхгүй.
4. `marketValue` = медиан, `lowValue`/`highValue` = P25/P75, `roundToMnt`-ээр бөөрөнхийлнө.
5. `confidence`: `HIGH` = дээж ≥ `highConfidenceMinSample` ба CV ≤ `highConfidenceMaxCv`; `MEDIUM` = дээж ≥ `mediumConfidenceMinSample` ба
   CV ≤ `mediumConfidenceMaxCv`; бусад нь `LOW`.

Параметрүүд одоо **DEMO утга** (`src/modules/valuation/demo-valuation-settings.ts`): `usdMnt 3500`, `minPriceMnt 1 000 000`, `yearTolerance 1`,
`maxListingAgeDays 90`, `yearAdjustmentRate 0.05`, `mileageAdjustmentPer10kKm 0.01`, `maxTotalAdjustment 0.3`, `outlierIqrFactor 1.5`,
`outlierMinRelativeSpread 0.05`, `outlierMinSample 4`, `minComparables 3`, `highConfidenceMinSample 8`, `highConfidenceMaxCv 0.15`, `mediumConfidenceMinSample 5`,
`mediumConfidenceMaxCv 0.3`, `roundToMnt 10000`, `externalTimeoutMs 15000`. Бизнес баталгаажуулж `origination.settings`-ийн projection
(`valuation.vehicle.*` түлхүүр) болгон солино (CLAUDE.md §3.2 дүрэм 8, docs/01 §8). Хариуны `parameters` нь тухайн үнэлгээнд
ашигласан утгыг хадгална.

### Орчны хувьсагч

| Нэр | Утга | Тайлбар |
| --- | --- | --- |
| `INTEGRATION_MODE` | `mock` \| `real` | Гадаад интеграцийн adapter сонгоно (CLAUDE.md §3.2 дүрэм 7). Тохируулаагүй бол `mock`, **гэхдээ** `NODE_ENV=production` үед тохируулаагүй бол сервис эхлэхгүй. Өөр утга бол эхлэхгүй. `mock` үед эхлэх бүрд "SIMULATED" анхааруулга лог-д гарна. Deploy-д `INTEGRATION_MODE`-ийг заавал тодорхой заана |
| `VALUATION_PORT` | тоо | HTTP порт, анхдагч `4004` |

### Adapter-ууд (`src/integrations/`, дэлгэрэнгүй нь `src/integrations/README.md`)

| Port | Token | `mock` | `real` |
| --- | --- | --- | --- |
| `VehicleRegistry` (АТҮТ) | `VEHICLE_REGISTRY` | `MockVehicleRegistry` | `RealAtutVehicleRegistry` (stub) |
| `VehicleListingSource[]` (зарын сайт) | `VEHICLE_LISTING_SOURCES` | `MOCK_UNEGUI`, `MOCK_ADS_B` | `RealUneguiVehicleListingSource` (stub) |

`mock` нь deterministic fixture (дүнгүүд `mileageKm = 90000` үед; гүйлтгүй бол бага зэрэг өөр): `УЕН5246` (Prius, ≈25.8 сая ₮), `1234УБА` (Prado, ≈87.7 сая ₮), `5678УНА` (Sonata, ≈31 сая ₮),
`7001УБЭ` (зар цөөн → `INSUFFICIENT_DATA`), `3030БАА` (зар байхгүй → `INSUFFICIENT_DATA`). Бүх нэр, регистр, үнэ зохиомол.

`real` adapter-ууд одоогоор stub: `NOT_IMPLEMENTED` алдаа шиднэ, тиймээс `INTEGRATION_MODE=real` үед endpoint 502
`REGISTRY_UNAVAILABLE` буцаана. Жинхэнэ adapter холбох:

1. АТҮТ-ийн хандалтын хэлбэр (шууд эсвэл ХУР gateway), зарын сайтын өгөгдөл авах эрх (гэрээ эсвэл scraping) гэсэн бизнес/хууль зүйн
   асуулт шийдэгдсэний дараа port-ыг (`VehicleRegistry`/`VehicleListingSource`) хэрэгжүүлнэ; `ctx.signal`-ыг хүндэтгэж, зарын
   марк/загварыг АТҮТ-ийн бичлэгт нормчилно (загвар **яг** тэнцэж шалгагддаг).
2. `integrations.module.ts`-ийн `real` салбарт бүртгэнэ (үйлчилгээний код өөрчлөгдөхгүй: token-оор л хамаарна).
3. Adapter-ийн тестийг хажууд нь нэмнэ. Хувийн мэдээлэл (регистр, нэр) лог-д бичихгүй.

### Мэдэгдэж буй хязгаарлалт

- Нэг машин хоёр сайтад зарагдсан бол **хоёр дахин** тоологдоно (сайт хооронд давхардал арилгахгүй): `sampleSize` ба `confidence`
  хэт өндөр гарч болно. Давхардал илрүүлэх түлхүүр (утас, VIN, дугаар) нь жинхэнэ adapter-ууд бэлэн болсны дараах ажил.
- Загварыг яг тэнцүүлж шалгадаг тул нормчлол муутай adapter олон зарыг `MODEL_MISMATCH` гэж хасч, `INSUFFICIENT_DATA` өгнө.

### Хамрах хүрээнээс гадуур

- Барьцааны карт, хүсэлттэй холбох, ачаалал, өмчлөлийн KYC (FR-6.5) нь `origination`/`kyc`; энэ сервис зөвхөн үнэлгээг хариуцна. Haircut, `collateral_valuation` хадгалалт, `override_reason`, `ValuationCompleted` нь дээрх "Барьцааны үнэлгээ" хэсэгт.
- Автомашин бус хөрөнгийн зах зээлийн жишиг (unegui-ийн үл хөдлөх, мал): суурь үнийн сангаар төлөөлнө.
- Нэвтрэлт, дүр/салбарын хүрээ: gateway шийднэ; энд зөвхөн `@Permissions` шалгана. `/valuate/auto` юу ч хадгалахгүй (stateless).
- Бодит АТҮТ ба зарын сайтын adapter: stub (`NOT_IMPLEMENTED`), дээрх тайлбар.

### Ажиллуулах, шалгах

```bash
pnpm exec turbo run build --filter=@los/valuation...   # @los/contracts, @los/calc-ийг хамт бүтээнэ (тестэд заавал хэрэгтэй)
INTEGRATION_MODE=mock VALUATION_PORT=4104 node apps/valuation/dist/main.js   # DATABASE_URL (valuation схем) хэрэгтэй: PrismaService
curl -s -X POST localhost:4104/api/valuate/auto -H 'content-type: application/json' \
  -H 'x-user-id: dev-officer' -H 'x-roles: OFFICER' -H 'x-org-id: dev-org' \
  -d '{"assetType":"VEHICLE","plateNo":"УЕН5246","mileageKm":90000}'
cd apps/valuation && npx vitest run      # unit + e2e (supertest); `TEST_DATABASE_URL` (нэр нь `test`-ээр төгссөн DB) тохируулбал AppModule-ийн тест ч ажиллана
cd packages/calc && pnpm exec vitest run src/collateral-value.test.ts --coverage   # цэвэр томьёо, 100% coverage
```

DB-тэй тест: `TEST_DATABASE_URL=postgresql://<user>@127.0.0.1:5432/<db>test REDIS_URL=redis://127.0.0.1:6379/<n> npx vitest run`. Глобал setup нь
`valuation` schema-г **устгаж** дахин migrate + seed хийнэ: зөвхөн тест DB-д. Root `.env` үүсгэж болохгүй (`INTERNAL_AUTH_SECRET` тохирч, тест унана). Тестийн цаг
`FixedClock` (2026-10-29); `test/app.ts` нь `createApp()`, `as(user, orgId)` helper өгнө. Тест нь `tsc`-ээр шалгагддаггүй (`@types/supertest` байхгүй), `nest build` нь `src/**/testing/**`-ийг хасдаг.
