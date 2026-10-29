# valuation

Барьцааны үнэлгээ: суурь үнэ, арга, haircut, гадны үнэлгээ, дахин үнэлгээ

Одоогийн хэрэгжилт: **автомашины зах зээлийн үнийн автомат санал** — FR-14.1 (машины марк/загвар/он/гүйлтээр үнэ),
FR-14.2 (зах зээлийн үнийг систем санал болгоно, албан тушаалтан засч болно). Endpoint, хариуны бүтэц, алдааны код,
орчны хувьсагч нь `apps/valuation/README.md`-д. Haircut ба `collateral_valuation` хадгалалт нь docs/04 Модуль 6 (энд хийгээгүй).

## Файлууд

| Файл | Үүрэг |
| --- | --- |
| `valuation.controller.ts` | `POST /valuate/vehicle-lookup` (`customer:read`), `POST /valuate/auto` (`application:read`); `@los/nest-common`-ийн `ZodValidationPipe`, `@Ctx()` (correlationId) |
| `auto-valuation.service.ts` | Урсгалыг удирдана: АТҮТ → зарын сайтууд → `estimateMarketPrice` → хариуны DTO; adapter-ийн хариуг шалгана; JSON лог |
| `valuation-settings.port.ts` | `ValuationSettings` (`vehiclePricing()`): үнэлгээний бүх параметр |
| `demo-valuation-settings.ts` | DEMO утгууд; `origination.settings`-ийн projection-оор солигдоно |
| `valuation.module.ts` | `IntegrationsModule`-ийг импортлож, settings-ийг token-оор бүртгэнэ; `Clock`, алдааны фильтр, guard нь AppModule-ийн `CommonModule`-ээс |

Тооцооллын цэвэр функц нь `packages/calc/src/market-price.ts`, DTO нь `packages/contracts/src/dto/valuation.ts`,
АТҮТ/зарын сайтын adapter нь `src/integrations/`.

## Урсгал (`autoValuateVehicle`)

1. `now = clock.now()` (`@los/nest-common` `Clock`; тестэд `FixedClock`), `settings.vehiclePricing()` уншина.
2. АТҮТ-ээс улсын дугаараар машиныг авна (`callWithTimeout('ATUT', externalTimeoutMs)`).
   Олдохгүй → 404 `VEHICLE_NOT_FOUND`; алдаа/timeout → 502 `REGISTRY_UNAVAILABLE` (код нь лог-д, дугаар/өмчлөгч лог-д орохгүй).
3. Бүх зарын сайтыг **зэрэгцээ** асууна: марк, загвар, он ± `yearTolerance`. АТҮТ-ийн дараа үлдсэн `externalTimeoutMs`-ийг л авна (нэг төсөв). Сайт бүр тусдаа try-catch-тай:
   унавал `SourceReport.status = ERROR` + `errorCode` бичигдэж, `SOURCE_UNAVAILABLE` анхааруулга гарна, үнэлгээ үргэлжилнэ.
4. Зарыг сайтаар нь (`sources`-ийн дарааллаар) нэгтгэнэ; сайт хооронд давхардал арилгахгүй. `estimateMarketPrice`-д өгч
   хасагдсан шалтгаан, засварласан үнийг `comparables`-д буцаана.
5. Adapter-ийн хариу бүрийг (`VehicleInfo`, `VehicleListingSchema[]`) шалгана; нийцэхгүй бол `BAD_RESPONSE` (АТҮТ → 502, зарын сайт → `ERROR` тайлан).
   `estimate` байвал `status = OK`, үгүй бол `INSUFFICIENT_DATA`. `warnings`: `SOURCE_UNAVAILABLE`, `MILEAGE_NOT_PROVIDED`, `LOW_CONFIDENCE`.
6. Ашигласан бүх тоон тохиргоог `parameters`-д хадгална (дахин гаргах боломжтой).

## Дүрэм

- Stateless: DB, event, cache ашиглахгүй.
- Хувийн мэдээлэл (улсын дугаар, өмчлөгчийн регистр/нэр) лог-д бичихгүй, хадгалахгүй; өмчлөгч зөвхөн `vehicle-lookup`-ийн хариунд, `/auto`-ийн
  (хадгалагдах боломжтой) хариунд орохгүй (CLAUDE.md §6.5).
- Бизнес утга (ханш, хүлцэл, босго) логикт hardcode хийхгүй: `ValuationSettings`-ээс.
- Шинэ гадаад эх сурвалж нэмэх бол `src/integrations/README.md`-ийн "Adding a listing source".

## Тест

- `auto-valuation.service.test.ts` — fake registry/sources/settings/clock: тооцоо, алдааны замууд, timeout, параллель, лог-д хувийн мэдээлэл байхгүй.
- `valuation.controller.e2e.test.ts` — Nest + supertest, `INTEGRATION_MODE=mock` fixture-ууд болон `real` (502).

TODO: `base-price`, `haircut` модуль (FR-14.1 суурь үнэ × элэгдэл, FR-14.2 haircut, FR-14.5) — `modules/base-price`, `modules/haircut`.
