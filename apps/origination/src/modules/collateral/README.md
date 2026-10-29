# collateral — барьцаа, өмчлөл/ачаалал, үнэлгээ, G0 (Модуль 6)

Шаардлага: FR-6.1–6.9, FR-14.4, FR-14.6, G0 хаалт, 5-р алхам `collateral` (docs/01, docs/05-collateral-documents.md §3.1, §6, docs/04 Модуль 6).
Үнэ тогтоох логик нь **valuation** сервист (FR-14.1–14.3); энд origination нь хүсэлтийг барьцаа + бүтээгдэхүүнээс бүрдүүлж, үр дүнг барьцааны мөрөнд хуулна.

## Бүтэц
| Файл | Үүрэг |
| --- | --- |
| `collateral-gate.ts` | **Цэвэр** `evaluateCollateralGate` -> `{gate, summary, perCollateralIssues}`: 17 `GateIssueCode` бүгд (монгол мессеж, `details`), LTV (`@los/calc` `checkLtv`), checklist, хуучралт |
| `collateral-steps.ts` | **Цэвэр** `planCollateralStepUpdate`: `collateral` COMPLETED/PENDING, `score` -> STALE (`COLLATERAL_CHANGED`), LOCKED-д хүрэхгүй |
| `collateral-ownership.ts` | **Цэвэр**: бүртгэлийн эх сурвалж (АТҮТ/ХУР), `judgeOwnership` (VERIFIED / OWNER_MISMATCH / OWNER_NOT_ON_APPLICATION), регистр далдлалт |
| `collateral-candidates.ts`, `-data.ts`, `-warnings.ts`, `-monitoring.ts`, `-valuation-event.ts` | **Цэвэр** туслахууд: ХУР -> candidate, fingerprint, аудит snapshot, анхааруулга, мониторингийн шалтгаан, event-ийн шийдвэр |
| `collateral-view.ts`, `collateral-pledge.ts` | Prisma мөр -> `CollateralView`; давхар барьцааны хайлт ба `lockAssetKeys` (advisory lock) |
| `collateral-gate.service.ts` | `CollateralGateService.snapshot/evaluate`: DB-ийн төлвөөс G0, хураангуй, анхааруулга. **Модуль 10 (G1 илгээх) `evaluate`-ийг дахин дуудна** |
| `collateral-tx.service.ts` | Мутаци бүрийн зориулалт: `FOR UPDATE` -> төлөв -> бичих -> G0 -> алхам -> аудит + `CollateralChanged` (нэг транзакц) |
| `collateral.service.ts` | CRUD, `recheck`, ЭБ бүртгэл, чөлөөлөлт, мониторинг |
| `collateral-checks.service.ts` | ХУР-ын хөрөнгө (FR-6.3), өмчлөлийн KYC (FR-6.5), ачаалал (FR-6.6) |
| `collateral-valuation.service.ts` | Санал / хадгалах / гадны үнэлгээ / түүх (FR-14) ба `ValuationCompleted`-ийн нөөц синк |
| `collateral-document.service.ts` | Барьцааны баримт (FR-6.2, FR-6.7) |
| `collateral-events.subscriber.ts` | `ValuationCompleted` (group `origination-collateral` — гэрээний subscriber-ийн `origination` group-тэй тусдаа, event bus нь хамааралгүй төрлийг XACK-лдаг тул; `idempotentHandler`); bus `null` бол чимээгүй алгасна |
| `collateral.controller.ts`, `collateral.module.ts` | REST, DI. Статик замууд (`monitoring`, `xyp-assets`, `recheck`) `:collateralId`-аас өмнө |
| `ports/` | `KycAssetsPort`, `ValuationPort`, `FilePort` + HTTP хэрэгжилт (`InternalHttpClient`) |
| `testing/` | In-memory fake портууд, G0 fixture, DB тестийн kit (`nest build`-д орохгүй) |

## Портууд (CLAUDE.md §3.2.2, §3.2.7)
Гадны сервис рүү зөвхөн `origination -> {kyc, valuation, dms}` sync REST; DI token-оор солигдоно (`overrideProvider(KYC_ASSETS_PORT | VALUATION_PORT | FILE_PORT)`).
| Port | Дуудлага | Timeout | Тэмдэглэл |
| --- | --- | --- | --- |
| `KycAssetsPort` | `POST kyc /api/xyp/assets`, `/api/xyp/property`, `/api/collateral-checks/encumbrance` | 15с | ХУР унавал `XYP_UNAVAILABLE` 503 шууд дамжина; ачаалал **fail closed** (`ENCUMBRANCE_UNAVAILABLE`) |
| `ValuationPort` | `POST valuation /api/valuate/vehicle-lookup`, `collateral/suggest`, `collateral`, `collateral/external`; `GET collateral/:id/history` | 15с (POST), 3с (GET) | `OVERRIDE_REASON_REQUIRED`, `MARKET_VALUE_REQUIRED` 422 дамжина |
| `FilePort` | `GET dms /api/files/:id` | 3с | 404 -> `null` (`FILE_NOT_FOUND`) |

POST дахин оролдохгүй; GET нэг удаа. Хариуг `@los/contracts` схемээр шалгана (нийцэхгүй бол 502). Зөвхөн хаалттай жагсаалтын 5xx код (`XYP_UNAVAILABLE`, `ENCUMBRANCE_UNAVAILABLE`, …) дамжина — үл мэдэгдэх 5xx-ийн агуулга эргэхгүй.
**Гадны дуудлага DB транзакцаас ГАДНА** хийгдэнэ (FOR UPDATE түгжээг HTTP даяар барихгүй); буцаж ирсний дараа транзакц дотор төлөв ба барьцааны fingerprint-ийг дахин шалгана -> өөрчлөгдсөн бол `409 COLLATERAL_CHANGED`.

## API
`docs/05` §3.1-тэй адил. Унших: OFFICER (өөрийн), BRANCH_MANAGER (салбар), APPROVER, ADMIN. Бичих: OFFICER (өөрийн), ADMIN. Төлөв `DRAFT`/`RETURNED`, өөрөөр `409 APPLICATION_NOT_EDITABLE`.
Үл хамаарах: үнэлгээ/гадны үнэлгээ `ACTIVE`-д ч (алхамд хүрэхгүй); ЭБ бүртгэл `APPROVED|DISBURSING|ACTIVE` (`APPLICATION_NOT_APPROVED`); чөлөөлөлт `CLOSED` (`APPLICATION_NOT_CLOSED`).

## Гол дүрмүүд
- **G0** `gate.complete` -> 5-р алхам COMPLETED (`completedAt`), үгүй бол PENDING. Барьцаа шаардахгүй бүтээгдэхүүн + барьцаа алга -> `skipped` (FR-6.4). Барьцаа, үнэлгээ нэмэх/засах/хасахад COMPLETED `score` -> STALE.
- **LTV** = зээл / Σ барьцааны үнэлгээ <= `product.max_ltv ?? setting br3.ltv_max` (яг хязгаарт хангана). Өмчлөл/ачааллын лавлагаа `inquiry.stale_days`-аас (30) НАСЖИЛТ > N хоног бол хуучирна (яг N хоногт хүчинтэй). Үнэлгээ `valid_until` өнгөрвөл (>) `VALUATION_EXPIRED`.
- **Давхар барьцаа**: `asset_key` (улсын дугаар/VIN, өмчлөх эрх, серийн дугаар) ба `registry_no` өөр SUBMITTED…MIGRATED хүсэлтийн чөлөөлөгдөөгүй барьцаанд байвал `409 COLLATERAL_ALREADY_PLEDGED` (нэмэх, PATCH, ЭБ) ба G0 `DUPLICATE_PLEDGE`. Өөр ноорог/буцаасан хүсэлтэд бол зөвхөн анхааруулга `IN_OTHER_DRAFT`. Race: хүсэлтийн мөрийн `FOR UPDATE` -> эрэмбэлсэн `pg_advisory_xact_lock`.
- **PATCH**: өмчлөгч эсвэл тодорхойлолт БОДИТООР өөрчлөгдвөл өмчлөл, ачаалал, үнэлгээ хүчингүй (баримт хэвээр). Өөрчлөлтгүй PATCH юу ч бичихгүй.
- **Өмчлөл**: бүртгэлийн өмчлөгч бүр хүсэлтийн барьцаалагч (PRIMARY/CO_BORROWER/PLEDGOR) байх ёстой, үгүй бол `OWNER_NOT_ON_APPLICATION` ("Барьцаалагч бүртгэнэ үү"). Зөвхөн батлан даагчаар бүртгэгдсэн бол `OWNER_NOT_PLEDGOR`. `DECLARED` нь бүртгэлгүй төрөлд л.
- **Event**: мутаци бүр `CollateralChanged` (outbox). `ValuationCompleted` нь sync хариуны нөөц: `DUPLICATE` (valuationId), `OLDER` (valuedAt), `SUPERSEDED` (барьцаа event-ээс хойш өөрчлөгдсөн) бол хэрэглэхгүй.
- **Хувийн мэдээлэл**: аудит/event/лог-д регистр, улсын дугаар, нэр ОРОХГҮЙ (`auditSnapshot`); хадгалсан өмчлөлийн JSON-д далдлагдсан регистр (`УЕ****0001`) + нэр.

## DEMO утгууд ба солих газар
| Юу | DEMO утга | Солих газар |
| --- | --- | --- |
| Нэг барьцаанд баримтын дээд тоо | 20 | `collateral.constants.ts` `MAX_DOCUMENTS_PER_COLLATERAL` (эзний шийдвэр хүлээгдэж байна) |
| DECLARED зөвшөөрөх, бүртгэлтэй төрлүүд | өмчлөл: АТҮТ = VEHICLE, ХУР = APARTMENT/HOUSE/LAND; ачаалал: ЗМС+ЭБ = VEHICLE, үл хөдлөх, EQUIPMENT | `collateral-ownership.ts` (`OWNERSHIP_REGISTRY`, `ENCUMBRANCE_REGISTRY`) |
| Байгууллагын 7 оронт регистр далдлалт | сүүлийн 2 тэмдэгт | `collateral-ownership.ts` `maskRegister` |
| Haircut, суурь үнэ, коэффициент, хүчинтэй хугацаа | valuation `haircut_rule`, `product.haircut_json`, setting `valuation.*_validity_days` | **энд хардкодгүй** |
| LTV дээд, хуучралт, дахин үнэлгээ, даатгалын сануулга | 70% / 30 / 365 / 30 хоног | `product.max_ltv`, setting `br3.ltv_max`, `inquiry.stale_days`, `collateral.revaluation_interval_days`, `collateral.insurance_reminder_days` |
| ХУР, ЗМС, ЭБ, АТҮТ | kyc/valuation mock fixture (ачаалал: идентификаторын сүүлийн цифр 7 -> ENCUMBERED, 9 -> DISPUTED) | `INTEGRATION_MODE=real` (kyc, valuation) |
| Гадны үнэлгээчний лиценз | шалгахгүй (чөлөөт текст) | бодит лицензийн бүртгэл |
| Demo хүсэлт | `DEMO-COL-0001`, VEHICLE, 20,000,000 / 36 сар | `prisma/seeds/demo-collateral.ts` (production seed-д орохгүй) |

## Demo seed
```bash
SEED_DEMO=1 pnpm --filter @los/origination db:seed        # эсвэл: cd apps/origination && SEED_DEMO=1 node ../../scripts/prisma.mjs origination seed
```
Нэг ноорог хүсэлт (`DEMO-COL-0001`; бүтээгдэхүүн VEHICLE, 20,000,000 ₮, 36 сар, ЗЭЗ А, Төв салбар), PRIMARY зээлдэгч регистр `УЕ00000001` (kyc mock ХУР, valuation mock АТҮТ-ийн өмчлөгчтэй таарна — шифрлэгдсэн + blind index), 12 алхам (1-4 COMPLETED, 5-9 PENDING, 2-р үе шат LOCKED).
Create-only, давтан ажиллуулахад юуг ч дарахгүй. Дараа нь: `GET /applications/<id>/collaterals/xyp-assets?ownerCustomerId=` -> автомашин `УЕН5246` -> нэмэх -> өмчлөл -> ачаалал -> үнэлгээ -> баримт.
Анхаар: 20 сая зээл LTV 70%-д ≥ 28.6 сая ₮-ийн барьцааны үнэлгээ шаардана (haircut 0.7 -> зах зээл ≥ 40.8 сая); хүрэхгүй бол `LTV_EXCEEDED` гарна — энэ нь хаалтын жишээ.

## Тест
```bash
cd apps/origination
TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/<db>test REDIS_URL=redis://127.0.0.1:6379/<n> pnpm exec vitest run src/modules/collateral test/collateral
```
- `src/modules/collateral/*.test.ts` — цэвэр дүрэм (G0, алхам, өмчлөл, candidate, анхааруулга, мониторинг, event шийдвэр), портын HTTP (fake fetch), subscriber (DB-гүй).
- `test/collateral*.e2e.test.ts` — бодит Postgres: `collateral` (бүрэн зам, docs/04 M6 AC, эрх, төлөв), `collateral-lifecycle` (давхар барьцаа, зэрэгцээ хүсэлт, PATCH, ACTIVE дахин үнэлгээ, ЭБ/чөлөөлөлт, мониторинг), `collateral-events` (subscriber, хувийн мэдээлэл), `collateral-demo-seed`, `collateral-app` (AppModule + бодит HTTP портууд).
