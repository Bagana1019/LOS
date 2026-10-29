# @los/kyc

Port 4002. ХУР/ДАН/ЗМС/FICO/НДШ лавлагаа, хар жагсаалт тулгалт, PEP/AML, барьцааны өмчлөл/ачааллын лавлагаа.

DB schema: `kyc`. Модулиуд: inquiry, xyp, dan, cib, ndsh, aml, collateral-checks.

Энэ сервис Модуль 6 (барьцаа)-д **ХУР-ын хөрөнгө, өмчлөгч** (FR-6.3, FR-6.5) ба **ЗМС + ЭБ ачаалал** (FR-6.6)-ыг хариулна. Дуудагч нь зөвхөн `origination`
(CLAUDE.md §3.2.2); `web` шууд дуудахгүй. Шаардлага, нийт зураглал: `docs/05-collateral-documents.md` (§5, §9). Эдгээр endpoint-ууд DB-д юу ч **хадгалдаггүй**.

> **DEMO.** ХУР, ЗМС, ЭБ-ийн бодит холболт байхгүй тул `INTEGRATION_MODE=mock` (анхдагч) үед **зохиомол, deterministic fixture** хариулна. `INTEGRATION_MODE=real` үед
> бодит adapter `501 INTEGRATION_NOT_IMPLEMENTED` өгнө (endpoint-ийг таамаглахгүй). Production-д `INTEGRATION_MODE`-ийг тодорхой заана (заагаагүй бол сервис эхлэхгүй).

## Endpoint-ууд (`/api/...`, бүгд `POST`, HTTP 200)

| Зам | Эрх | Хүсэлт → хариу (`@los/contracts`) | Алдаа |
| --- | --- | --- | --- |
| `/xyp/citizen` | `customer:write` | `XypCitizenRequest` → `XypCitizen` (FR-2.2) | 400 `INVALID_REGISTER_NO`, 404 `XYP_NOT_FOUND`, 503 `XYP_UNAVAILABLE`, 501 |
| `/xyp/assets` | `customer:read` | `XypAssetsRequest {registerNo}` → `XypAssetsResponse {properties, vehicles, fetchedAt}` (FR-6.3) | 400 `INVALID_REGISTER_NO`, 400 `VALIDATION_FAILED`, 404 `XYP_NOT_FOUND` (регистр ХУР-д алга; хөрөнгөгүй бол хоосон жагсаалт), 503 `XYP_UNAVAILABLE`, 501 `INTEGRATION_NOT_IMPLEMENTED` |
| `/xyp/property` | `customer:read` | `XypPropertyRequest {propertyId}` → `XypPropertyAsset` өмчлөгчидтэй нь (FR-6.5) | 400 `VALIDATION_FAILED`, 404 `XYP_NOT_FOUND`, 503 `XYP_UNAVAILABLE`, 501 |
| `/collateral-checks/encumbrance` | `customer:read` | `EncumbranceCheckRequest {assetType, identifier}` → `EncumbranceCheckResult {status, sources[], checkedAt}` (FR-6.6) | 400 `VALIDATION_FAILED` / `INVALID_IDENTIFIER`, 422 `ENCUMBRANCE_CHECK_NOT_APPLICABLE`, 503 `ENCUMBRANCE_UNAVAILABLE`, 501 |

Алдааны мессеж монгол, `code` тогтвортой. `customer:read` нь `OFFICER`, `BRANCH_MANAGER`, `APPROVER`, `ADMIN` дүрд бий (`ROLE_PERMISSIONS`); `/xyp/citizen` нь зөвхөн `customer:write` (`OFFICER`).
Нэвтрээгүй хүсэлт 401, эрхгүй дүр 403.

### Ачаалал шалгах дүрэм
* `assetType` нь `VEHICLE`, `APARTMENT`, `HOUSE`, `LAND`, `EQUIPMENT` байна. `LIVESTOCK`, `INVENTORY`, `OTHER` → **422** (бүртгэл байхгүй; origination гараар `DECLARED` болгоно).
* `identifier`: VEHICLE → улсын дугаар (зай, зураас хасч том үсэг), APARTMENT/HOUSE/LAND → өмчлөх эрхийн дугаар, EQUIPMENT → серийн дугаар. Хэлбэрийг шалгахгүй.
* `sources` нь ЗМС (`ZMS`) эхэлж, дараа нь ЭБ (`EB`): эх сурвалж бүрийн `status` (`CLEAR`, `ENCUMBERED`, `DISPUTED`, `NOT_APPLICABLE`), `pledgee`, `registeredAt`, `note`.
* Нэгдсэн `status`: **`DISPUTED` > `ENCUMBERED` > `CLEAR`**. `checkedAt` нь `Clock`-оос.
* **Fail closed.** ЗМС эсвэл ЭБ-ийн аль нэг нь хариулаагүй, хариу дутуу (нэг эх сурвалж алга) / буруу хэлбэртэй / бүгд `NOT_APPLICABLE` бол **503 `ENCUMBRANCE_UNAVAILABLE`** —
  хэзээ ч `CLEAR` буцаахгүй. Тодорхойгүй алдаа ч мөн 503 (лог-д зөвхөн алдааны ангийн нэр).

## Хувийн мэдээлэл (CLAUDE.md §6.5)
Регистр, өмчлөгчийн нэр, улсын дугаар, өмчлөх эрхийн дугаар нь хувийн мэдээлэл: зөвхөн дуудагчид буцна, **хадгалахгүй, лог-д бичихгүй, алдааны хариунд давтахгүй**. Тест: `test/pii-logs.e2e.test.ts`.

## DEMO fixture (mock)

Бүх нэр, хаяг, дугаар зохиомол. Deterministic: `Math.random`/`Date.now` ашиглахгүй, регистрийн hash (FNV-1a)-аас гарна; `fetchedAt` тогтмол `2026-01-01T00:00:00.000Z`.
Код: `src/integrations/xyp/xyp-assets.fixture.ts`, `src/integrations/encumbrance/encumbrance.fixture.ts`. Солих газар: `INTEGRATION_MODE=real` + бодит adapter (`RealXypClient`, `RealEncumbranceRegistry`, `TODO(human)`).

### ХУР: регистрийн дүрэм (`/xyp/assets`, `/xyp/property`, `/xyp/citizen` ижил)
| Регистрийн цифрүүд (иргэн: 2 үсгийн дараах 8, байгууллага: 7) | Үр дүн |
| --- | --- |
| бүгд `0` (`УБ00000000`, `0000000`) | ХУР-д олдохгүй → 404 `XYP_NOT_FOUND` |
| бүгд `9` (`УБ99999999`, `9999999`) | ХУР унасан → 503 `XYP_UNAVAILABLE` |
| буруу хэлбэр | 400 `INVALID_REGISTER_NO` |
| бусад | доорх хөрөнгө |

### ХУР: үл хөдлөх хөрөнгө
* **Иргэн**: 1–2 хөрөнгө. `MOCK-<РЕГИСТР>-1` үргэлж; нэмэх нь регистрийн hash-аар: 50% зөвхөн `-1`, 25% `-1` ба `-2` (газар эсвэл байшин, ганц өмчлөгч), 25% `-1` ба **`-9`**.
* **`MOCK-<РЕГИСТР>-9` = хамтран өмчлөгчтэй**: 2 өмчлөгч, тус бүр 50% (регистр + регистрээс гарсан зохиомол иргэний регистр, өөр нэртэй) — `OWNER_NOT_ON_APPLICATION` (docs/05 §6)-ийг үзүүлнэ.
* **Байгууллага**: яг 1 үйлчилгээний (`COMMERCIAL`) хөрөнгө `MOCK-<РЕГИСТР>-1`.
* `propertyId` DEMO формат `MOCK-<РЕГИСТР>-<n>` тул `/xyp/property` дугаараас өмчлөгчийг буцааж гаргана; жагсаалтад байхгүй `n`, танигдаагүй формат (`Ү-2201001234` г.м) → 404.
  Өмчлөгчийн нэр нь ХУР-ын иргэн/байгууллагын fixture (`/xyp/citizen`)-тэй ижил. Гэрчилгээний дугаар `DEMO-CERT-<6 цифр>`.
* Хаяг, талбай, давхар, бүтээгдсэн он hash-аас; `COLLATERAL_DESCRIPTION_SCHEMAS`-аар шалгагдах утгатай (тестээр баталгаажсан).

### ХУР: тээврийн хэрэгсэл (valuation-ий mock АТҮТ-тэй ижил)
Эдгээр нь `apps/valuation/src/integrations/vehicle-registry/mock-vehicles.ts`-ийн **талбар бүрээрээ** хуулбар. Хоёр файлыг хамт шинэчилнэ; зөрвөл `test/xyp-vehicles-sync.test.ts` унана.

| Өмчлөгчийн регистр | Улсын дугаар | Тээврийн хэрэгсэл |
| --- | --- | --- |
| `УЕ00000001` | `УЕН5246` | Toyota Prius 2012, HYBRID |
| `0000001` (байгууллага) | `1234УБА` | Toyota Land Cruiser Prado 2015, DIESEL |
| `ЖИ00000002` | `5678УНА` | Hyundai Sonata 2017, LPG |
| `ТЭ00000003` | `7001УБЭ` | Lexus LX 570 2018, PETROL |
| `0000002` (байгууллага) | `3030БАА` | Daewoo Damas 2005, PETROL |

Бусад регистр тээврийн хэрэгсэлгүй (хоосон жагсаалт). Анхаар: өмчлөгчийн **нэр** хоёр mock-д ялгаатай (АТҮТ-д `Жишээ Сарангэрэл`, ХУР-д hash-аас) — холбоос нь регистр.

### Жишээ регистрүүд (баримт, тестэд тогтоосон)
| Регистр | Хөрөнгө |
| --- | --- |
| `УБ90010112` | `MOCK-УБ90010112-1` орон сууц 41 м², ганц өмчлөгч; тээврийн хэрэгсэлгүй |
| `УБ00000001` | `-1` орон сууц 41 м² ба `-2` газар 600 м² (ганц өмчлөгч) |
| `ЖИ00000002` | `-1` орон сууц 66 м², `-9` орон сууц 62 м² (**хамтран өмчлөгчтэй**) ба `5678УНА` |
| `УЕ00000001` | `-1` орон сууц 117 м² ба `УЕН5246` |
| `0000001` | `-1` үйлчилгээний байшин 158 м² (ХХК) ба `1234УБА` |

### ЗМС + ЭБ ачаалал (mock дүрэм, docs/05 §9)
Хөрөнгийн төрлөөс үл хамааран зөвхөн `identifier`-ийн хэлбэрээр шийднэ. **Сүүлийн цифр** гэдэг нь төгсгөлийн үсгийг тоохгүй сүүлийн ASCII цифр (`5677УБА` → 7).
| `identifier` | ЗМС | ЭБ | Нэгдсэн |
| --- | --- | --- | --- |
| `ERR`-ээр төгсөнө (том/жижиг үсэг ялгахгүй; бусад дүрмээс түрүүлнэ) | — | — | **503** `ENCUMBRANCE_UNAVAILABLE` |
| сүүлийн цифр **7** (`УЕН5247`, `5677УБА`) | `ENCUMBERED`, барьцаалагч `Жишээ ББСБ`, `registeredAt 2025-03-14` | `CLEAR` | `ENCUMBERED` |
| сүүлийн цифр **9** (`1239УБА`, `MOCK-…-9`) | `CLEAR` | `DISPUTED` | `DISPUTED` |
| бусад (цифргүй ч гэсэн) | `CLEAR` | `CLEAR` | `CLEAR` |

Дээрх 5 mock автомашины дугаар бүгд `CLEAR`. **Анхаар:** хамтран өмчлөгчтэй `MOCK-<РЕГИСТР>-9` нь сүүлийн цифр 9 тул ачаалал шалгахад мөн `DISPUTED` гарна
(өмчлөл ба ачааллын DEMO-г нэг хөрөнгөөр зэрэг үзүүлэхэд анхаар; ачаалалгүй хамтран өмчлөгчийг үзүүлэх шаардлагатай бол дугаарын дүрмийг `encumbrance.fixture.ts`-д солино).

## Бүтэц
```
src/integrations/xyp/            XypClient (getCitizen, getAssets, getProperty), MockXypClient, RealXypClient, xyp.fixture.ts, xyp-assets.fixture.ts
src/integrations/encumbrance/    EncumbranceRegistry, MockEncumbranceRegistry, RealEncumbranceRegistry, encumbrance.fixture.ts, encumbrance.module.ts
src/modules/xyp/                 XypController (/xyp/citizen, /xyp/assets, /xyp/property)
src/modules/collateral-checks/   CollateralChecksController + Service, encumbrance.rules.ts (цэвэр дүрэм)
test/                            e2e (supertest): xyp-assets, collateral-checks, pii-logs; xyp-vehicles-sync (valuation-тэй тулгалт)
```

## Тест
```bash
cd apps/kyc
TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/<db>test REDIS_URL=redis://127.0.0.1:6379/<n> pnpm exec vitest run
pnpm lint && pnpm build
```
`TEST_DATABASE_URL`-гүй үед DB-тэй e2e `describe.skipIf`-ээр алгасагдана; DB-гүй хэсэг (`createLightApp`: mode=real, алдаа дуурайлт, PII лог, Clock) үргэлж ажиллана.
