# loan-terms

FR-5 Зээлийн нөхцөл: **нөхцөл хадгалах (FR-5.1–5.3, 4-р алхам `loan`)** ба **эрсдэлд суурилсан үнэ тогтоолт (FR-5.5, BR-14)**.

| Endpoint | Эрх | Үүрэг |
| --- | --- | --- |
| `GET /api/loan-terms/products` | `application:read` | Идэвхтэй бүтээгдэхүүн + хязгаар (дүн, хугацаа, хүү) |
| `GET /api/loan-terms/cib-purposes` | `application:read` | ЗМС зориулалтын ангилал (DEMO каталог) |
| `GET /api/applications/:id/loan-terms` | `application:read` | Нөхцөл + хязгаар + `loan`/`installment` алхмын төлөв |
| `PUT /api/applications/:id/loan-terms` | `application:write` | Хязгаарт багтвал хадгална (үгүй бол 422 `LOAN_TERMS_OUT_OF_LIMITS`), `loan` → COMPLETED; ЭТХ-д нөлөөлөх талбар өөрчлөгдвөл `installment` → STALE, ЭТХ `is_stale`, `score` STALE (FR-7.3) |

Цэвэр дүрэм: `loan-terms.rules.ts` (`checkLimits`, `termsChanged`, `planTermsSteps`). Тест: `loan-terms-schedule.e2e.test.ts` (M5+M7 AC). ЭТХ: `../schedule`.

### Эрсдэлд суурилсан үнэ (FR-5.5, BR-14)

| Endpoint (`/api/loan-terms/pricing`) | Эрх | Үүрэг |
| --- | --- | --- |
| `GET /tiers?productId=` | `application:read` | Идэвхтэй шатлал (бүтээгдэхүүний өөрийнх, үгүй бол байгууллагын нийтлэг) |
| `PUT /tiers` | `settings:manage` (ADMIN) | Шатлал солих → шинэ `version`, `audit_log`, `SettingsChanged` (`key=pricing.tiers`) нэг транзакцид |
| `POST /quote` | `application:read` | `{ productId, soscoScore \| null, amount? }` → санал болгох хүү/шимтгэл |

- Тооцоо цэвэр функц: `@los/calc` `risk-pricing.ts` (`quoteRiskPricing`, `validateTierSet`). Сервис зөвхөн ачаалж, хадгалж, холбоно.
- **Нэгж:** `interestRate` = жилийн хувь (23.99), `feeRate` = бутархай (0.015). Quote-ын хүүг `annuityPayment`-д хөрвүүлэлтгүй өгнө.
- Шатлал `min_score` (0–1000) доод хязгаараар; оноо өндөр байх тусам хүү/шимтгэл өсөхгүй; яг нэг `is_default` (Sosco Score байхгүй үед).
- Хүү бүтээгдэхүүний `[min_rate, max_rate]`-д тайрагдана (BR-6); тайрсан бол `rateBound: 'MIN' | 'MAX'`.
- Хадгалалт: `pricing-tier.store.ts` — хүрээ (org × product) тус бүрээр advisory lock, мөр устгахгүй (`is_active=false` + шинэ version). Seed ижил функцийг `onlyIfAbsent`-тэй ашиглана.
- Quote нь САНАЛ: `soscoScore`-г дуудагч дамжуулна, автоматаар дахин үнэлэхгүй (DECISIONS.md). Хариуны `config.version`-г хүсэлтийн snapshot-д хадгална.
- Тест: `test/pricing.e2e.test.ts` (`TEST_DATABASE_URL`), `@los/calc` `risk-pricing.test.ts`.
