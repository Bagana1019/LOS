# @los/origination

Port 4001. Хүсэлт, төлвийн машин, зээлдэгч, орлого, нөхцөл, ЭТХ, батлах урсгал, гэрээ, олголт, хар жагсаалт, мэдэгдэл, тайлан, админ

DB schema: `origination`. Модулиуд: application, borrower, income, loan-terms, schedule, approval, contract, disbursement, blacklist, notification, report, settings.

## Merchant POS (`src/modules/merchant`)

B2B2C мерчант POS портал: дэлгүүрийн кассир худалдан авагчид 1-2 минутанд лизингийн урьдчилсан шийдвэр өгч, OTP-оор зөвшөөрүүлж, хүргэлт/тооцоог хөтөлнө. Спек: `docs/05-merchant-pos.md` (бүх route §8). Контракт: `@los/contracts` (`merchant.ts`, `events.ts`), тооцоолол: `@los/calc` (`quotePosLease`, `decidePosLease`).

- Controller-ууд: `/api/merchant-portal/*` (MERCHANT_STAFF, MERCHANT_ADMIN), `/api/merchants`, `/api/pos-plans`, `/api/pos-leases` (ADMIN, APPROVER, BRANCH_MANAGER). Хэрэглэгчийн эрх gateway-ийн `x-*` толгойгоор ирнэ; өөр мерчант/дэлгүүр/салбарын нөөц **404**.
- Persistence: `MerchantModule.register({ persistence: 'prisma' | 'memory' })`. `memory` нь тест/demo-д л; `NODE_ENV=production`-д хориотой.
- Production guard: `register()` нь provider-ыг ЖИНХЭНЭЭР сонгох горимыг (`integrationMode` option эсвэл `INTEGRATION_MODE`) шалгана — `NODE_ENV=production` үед `real` биш бол, мөн `overrides` өгвөл модуль асахгүй (`PosConfigError`). `POS_CONFIG` нь тэр ижил горимоор үүснэ (provider-тэй зөрөхгүй).
- Optimistic lock: `merchant`, `merchant_store`, `pos_lease_plan` (мөн `pos_lease`) нь `version` (≥ 1)-тэй. `save*` нь уншсан version-ээр compare-and-set хийж +1 болгоно; зэрэгцээ өөрчлөлт давхарлагдвал хоцорсон хүсэлт **409 `CONCURRENT_UPDATE`** (event/outbox бичигдэхгүй) — статус, данс, `isActive`-г хуучин хуулбараар буцаахгүй. API-ийн view `version`-г гаргахгүй; клиент 409 авбал дахин уншаад давтана.
- Кэш: merchant API-ийн бүх хариу (алдаа ч) `Cache-Control: no-store` + `Pragma: no-cache` (`MerchantModule.configure`; зөвхөн энэ модулийн route, глобал биш) — хуваалцсан POS терминалд PII кэшлэгдэхгүй.
- Event (transactional outbox): `PosLeaseDecided | Accepted | Delivered | Settled | Cancelled`, `MerchantStatusChanged` — PII-гүй.
- PII (POS-BR-7): регистр/утас API, лог, event-д зөвхөн маскалсан (`УЕ******01`, `99****33`); регистр шифрлэгдэж, хайлт hash-аар.

Тохиргоо (env):

| Нэр | Утга |
|---|---|
| `INTEGRATION_MODE` | `mock` (анхдагч) \| `real`. `NODE_ENV=production` үед `real` заавал, эс бөгөөс сервис асахгүй |
| `POS_OTP_SECRET` | `real` үед заавал (≥ 16 тэмдэгт); OTP-ийн HMAC түлхүүр. Хэзээ ч код дотор хатуу бичихгүй |
| `PII_HASH_KEY` | Худалдан авагчийн регистрийн HMAC хайлтын hash-ийн түлхүүр; `real`/production үед заавал ба **≥ 16 тэмдэгт** (trim хийсний дараа; `POS_OTP_SECRET`-тэй адил), dev/mock-д DEV түлхүүр (анхааруулгатай) |
| `KYC_BASE_URL` | Худалдан авагчийн скрининг (`<url>/api/inquiry/pos-screening`); production-д заавал. `real` үед эхлэхэд шалгана: `http(s)://host[:port][/prefix]`, нэвтрэх мэдээлэл/query-гүй, `/api`-аар төгсөхгүй (adapter өөрөө `/api/...` залгана). Redirect дагахгүй; `x-correlation-id` (+ `x-org-id`) илгээнэ |
| `POS_DRAFT_TTL_MINUTES` `POS_REFERRAL_TTL_HOURS` `POS_OTP_TTL_SECONDS` `POS_OTP_MAX_ATTEMPTS` `POS_OTP_RESEND_SECONDS` `POS_OTP_MAX_SENDS` | Хугацаа/хязгаар (эерэг бүхэл тоо; анхдагч 60 / 72 / 300 / 3 / 30 / 5) |

`turbo run dev|test` нь env-ийг strict горимд цэвэрлэдэг тул `turbo.json`-ийн `globalPassThroughEnv` нь `NODE_ENV`, `PII_HASH_KEY`, `KYC_BASE_URL`, `POS_*`-ийг дамжуулна (нууцууд cache hash-д орохгүй); `INTEGRATION_MODE`, `DATABASE_URL` нь `globalEnv`-д. `test` task нь `build`/`dev`-ийн адил эхлээд `db:generate` ажиллуулна (Prisma client шаардлагатай).

### Demo (DEMO ONLY)

```bash
pnpm --filter @los/origination demo:merchant   # http://localhost:4000/demo
```

Gateway + origination-ийг нэг процесст дууриана: санах ойн өгөгдөл, mock интеграци, OTP код үргэлж `123456`, 2 зохиомол мерчант (дэлгүүр тус бүр 2), 3 хөтөлбөр, сүүлийн 14 хоногийн ~25 лизинг. `/demo` дээр дүр (кассир ×2, мерчантын админ, лизингийн админ/шинжээч) сонгоход `demo_persona` cookie тохируулагдаж вэб апп (`DEMO_WEB_URL`, анхдагч `http://localhost:3000`) руу шилжинэ.

- Env: `DEMO_PORT` (4000), `DEMO_HOST` (анхдагч `127.0.0.1` — зөвхөн loopback), `DEMO_WEB_URL`, `DEMO_ALLOW_REMOTE`.
- **Нэвтрэлт байхгүй** (хэн ч лизингийн ADMIN дүрийг сонгож чадна) тул `DEMO_HOST` loopback биш (жишээ нь `0.0.0.0`) бол `DEMO_ALLOW_REMOTE=1` заавал, тэгээгүй бол асахаас татгалзана; тавьсан ч чанга анхааруулга хэвлэнэ. Хуваалцсан сүлжээнд хэзээ ч бүү ашигла.
- `NODE_ENV=production` (том жижиг үсэг үл ялгана) эсвэл `INTEGRATION_MODE=real` (эсвэл буруу утга) үед ойлгомжтой `REFUSED` мессежээр асахаас татгалзана.
- Gateway-ийн дүр нь клиентийн ирүүлсэн `x-user-id`, `x-org-id`, `x-roles`, `x-branch-id`, `x-merchant-id`, `x-store-id` толгойг **ямар ч замд** (`/api`, `/API` …) устгаж, зөвхөн сонгосон дүрийн толгойг тавина.
- Cookie нь хост-д холбогддог (`localhost` ≠ `127.0.0.1`): `/demo`-г вэб-ийн API суурьтай ижил хостоор нээ — анхдагчаар `http://localhost:4000/demo` (вэб-ийн `NEXT_PUBLIC_GATEWAY_URL` анхдагч `http://localhost:4000/api`). Баннер ижил хостыг хэвлэнэ. `127.0.0.1` ашиглах бол `DEMO_WEB_URL=http://127.0.0.1:3000` ба `NEXT_PUBLIC_GATEWAY_URL=http://127.0.0.1:4000/api`-ийг хамт тавь (CORS нь вэб origin болон түүний `localhost`/`127.0.0.1` ихэрийг зөвшөөрнө).

### Тест

```bash
pnpm --filter @los/origination test                 # unit + service + HTTP e2e (supertest) + санах ойн contract; DB шаардахгүй (DB-тэй тест алгасагдана)
TEST_DATABASE_URL=postgresql://los@localhost:5432/los_test pnpm --filter @los/origination test   # + ижил contract suite бодит PostgreSQL дээр (Module 0 global-setup schema-г шинээр үүсгэж migrate + seed хийнэ)
pnpm --filter @los/origination exec tsc --noEmit -p scripts/tsconfig.json   # scripts/ төрөл шалгалт
```

`TEST_DATABASE_URL` тавьсан үед (Module 0: нэр нь `test`-ээр төгссөн DB; global-setup `origination` schema-г DROP + migrate + seed хийж, `DATABASE_URL`-ийг түүнээс гаргана) Postgres suite ажиллана — dev-ийн `DATABASE_URL`-ийг хэзээ ч ашиглахгүй. Тест бүрийн өмнө merchant POS-ийн 6 хүснэгт (`merchant`, `merchant_store`, `pos_lease_plan`, `pos_lease`, `pos_lease_otp`, `pos_lease_event`)-ийг `TRUNCATE` хийх тул өгөгдлийн сангийн нэр тусдаа `test` үгтэй (`los_test`, `test-los`; `latest` биш) байх ёстой — эс бөгөөс suite алгасагдана (`dbTestGuard` нь Module 0-ийн "test-ээр төгссөн" шалгалтад нэмэлт хамгаалалт). Өөр нэртэй DB-д зөвхөн хөгжүүлэгч ӨӨРӨӨ `LOS_DB_TEST_ALLOW_TRUNCATE=1` тавьж болно. Хуваалцсан `origination.outbox`-ыг TRUNCATE ХИЙХГҮЙ: зөвхөн POS event төрлийн (`MerchantStatusChanged`, `PosLease*`) мөрийг устгаж/уншина, бусад модулийн event-д хүрэхгүй.

### Миграци

`prisma/migrations/20261029020000_merchant_pos` нь merchant 6 хүснэгт + CHECK invariant-ыг нэмнэ (өсөн нэмэгдэх; baseline-д хүрэхгүй — docs/00-foundation.md). `merchant`, `merchant_store`, `pos_lease_plan`, `pos_lease` бүр `version INTEGER NOT NULL DEFAULT 1` + `CHECK (version >= 1)` (optimistic lock). Drift шалгах: `prisma migrate diff --from-url <DB baseline + migration> --to-schema-datamodel prisma/schema.prisma` нь "empty migration" гэж хэлэх ёстой. `origination` schema болон `outbox`-ыг baseline `20261028000000_init` үүсгэдэг: `pnpm db:migrate` (`pnpm --filter @los/origination db:migrate`) хоёуланг дарааллаар нь хэрэглэнэ.

`vitest.config.mts` дахь `coverage` тохиргоо (v8) нь `@vitest/coverage-v8` devDependency нэмэгдсэний дараа `vitest run --coverage`-д ажиллана (одоогоор энэ package-д суугаагүй).
