# @los/valuation

Port 4004. Барьцааны үнэлгээ: суурь үнэ, арга, haircut, гадны үнэлгээ, дахин үнэлгээ

DB schema: `valuation`. Модулиуд: valuation, base-price, haircut.

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
Улсын дугаар URL/access log-д орохгүйн тулд хоёулаа `POST`.

| Endpoint | Body | Зориулалт |
| --- | --- | --- |
| `POST /api/valuate/vehicle-lookup` | `{ "plateNo": "уен 5246" }` | АТҮТ-ээс машины мэдээлэл авах. **Өмчлөгчийн регистр/нэр зөвхөн энд** буцна |
| `POST /api/valuate/auto` | `{ "assetType": "VEHICLE", "plateNo": "УЕН5246", "mileageKm": 90000 }` | зах зээлийн үнийн санал; `mileageKm` заавал биш (орхих эсвэл `null`; АТҮТ-д гүйлт байхгүй). Зөвхөн 1…2 000 000 бүхэл тоо: `0`, сөрөг, бутархай утга татгалзана |
| `GET /api/health` | | `{ "service": "valuation", "ok": true }` |

Улсын дугаар: 4 цифр + 2-3 кирилл үсэг, аль ч дарааллаар (`УЕН5246`, `1234УБА`). Зай/зураас арилгаж, том үсэг болгож
хэвийн болгоно (`уен 5246` → `УЕН5246`). Латин үсэг татгалзана.

Хүсэлтийн `X-Correlation-Id` толгойг (`[A-Za-z0-9_.:-]`, ≤128 тэмдэгт) хариунд тусгана; байхгүй эсвэл хэлбэр нь өөр бол UUID
үүсгэнэ. Middleware (`src/common/correlation-id.ts`) validation-ээс өмнө ажилладаг тул 200, 400, 404, 502 бүгдэд орно.
Controller-т хүрэхээс өмнө framework өөрөө татгалзах хүсэлт (буруу JSON бүтэц, хэт том body, байхгүй зам) `X-Correlation-Id`-гүй,
Nest-ийн анхдагч алдааны body-тай (`{ statusCode, message }`) ирнэ; доорх `{ code, message }` бүтэц зөвхөн сервисийн өөрийн алдаанд хамаарна.

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

Алдаа (body нь `{ code, message }`):

| HTTP | `code` | Тохиолдол |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | буруу улсын дугаар/`assetType`/`mileageKm`; `issues: [{ path, message }]`. Татгалзсан **улсын дугаарыг** буцааж хэвлэхгүй (`assetType`-ын "Invalid enum value" мессеж өгөгдсөн утгыг нэрлэж болно) |
| 404 | `VEHICLE_NOT_FOUND` | АТҮТ-д бүртгэлгүй дугаар |
| 502 | `REGISTRY_UNAVAILABLE` | АТҮТ хариулсангүй/алдаа/timeout (15с), эсвэл adapter-ийн хариу гэрээнд нийцэхгүй (`BAD_RESPONSE`). Зарын сайт унахад 502 **болохгүй**: `sources[].status = ERROR` |

Adapter-ийн хариуг (АТҮТ-ийн бичлэг: `@los/contracts` `VehicleInfo`; зарын жагсаалт: `VehicleListingSchema`) сервис шалгана. Нэг ч зар
гэрээнд нийцэхгүй бол тухайн сайт `ERROR` + `errorCode: BAD_RESPONSE` болно (зарыг тал нь үлдээхгүй). Гэрээ: сайт тутамд ≤ 1000 зар,
`price` төгсгөлөг тоо, `url` нь `http(s)` эсвэл `null`, тэмдэгт мөрүүд урттай (`title` ≤ 300 гэх мэт), `postedAt` нь ISO 8601
(цагийн бүсгүй бол UTC; өөр хэлбэрийг `STALE_LISTING` гэж хасна), `year` бүхэл тоо. Зөрчлийн лог нь зөвхөн талбарын зам, zod код
(`0.make:invalid_type`) бичнэ, утгыг бичихгүй.

Лог: `main.ts` нь `JsonLogger` (`src/common/json-logger.ts`) ашигладаг тул мөр бүр нэг JSON объект (`level`, `time`, `context`; үйл явдлын
мөрөнд `event`, `source`, `code`, `correlationId`). Улсын дугаар, өмчлөгч, adapter-ийн мессеж лог-д орохгүй. Тохиргооны утга
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

- Haircut ба барьцааны үнэлгээ (зах зээлийн үнэ × haircut), `collateral_valuation` хадгалалт, `override_reason` (docs/04 Модуль 6).
- `ValuationCompleted` event (outbox/event bus нь `TODO(M00)`).
- Автомашинаас бусад хөрөнгийн төрөл (`assetType` одоогоор зөвхөн `VEHICLE`), суурь үнийн сан (FR-14.1 суурь үнэ × элэгдэл, FR-14.5).
- Өмчлөлийн KYC (FR-6.5): өмчлөгчийн мэдээллийг зөвхөн лавлах оролт болгон буцаана, `kyc`/`origination` шийднэ.
- Хэрэглэгчийн эрх шалгах (gateway-д шийдэгдэнэ, CLAUDE.md §3.2 дүрэм 9).

### Ажиллуулах, шалгах

```bash
pnpm exec turbo run build --filter=@los/valuation...   # @los/contracts, @los/calc-ийг хамт бүтээнэ (тестэд заавал хэрэгтэй)
INTEGRATION_MODE=mock VALUATION_PORT=4104 node apps/valuation/dist/main.js
curl -s -X POST localhost:4104/api/valuate/auto -H 'content-type: application/json' \
  -d '{"assetType":"VEHICLE","plateNo":"УЕН5246","mileageKm":90000}'
cd apps/valuation && npx vitest run      # unit + e2e (supertest)
```
