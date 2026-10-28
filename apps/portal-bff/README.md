# @los/portal-bff

Харилцагчийн өөртөө үйлчлэх портал (гар утасны апп / вэб)-ын Backend-for-Frontend. Port **4007**.
Бүрэн баримт: [`docs/05-portal-bff.md`](../../docs/05-portal-bff.md).

Зээлдэгч OTP-оор нэвтэрч **үлдэгдэл**, **эргэн төлөлтийн хуваарь** харах, **гэрээ татах**, **төлбөр хийх** боломжтой. Энэ апп өгөгдөл хадгалахгүй; `origination`-ий `/api/internal/portal/*` дотоод API-г дуудна (CLAUDE.md §3.2).

## Ажиллуулах

```
pnpm install
pnpm exec turbo run build --filter=@los/portal-bff^...   # @los/contracts, @los/calc (dist/ git-д байхгүй)
pnpm --filter @los/portal-bff dev      # mock горим, Redis/origination хэрэггүй
curl localhost:4007/api/health
```

Demo харилцагч: `УБ90010112` / `99112233` (идэвхтэй зээл `loan_demo_001`), `УА85050505` / `88112233` (хугацаа хэтэрсэн `loan_demo_003`). Mock горимд OTP код тогтмол `123456` (`PORTAL_MOCK_OTP_CODE`-оор солино; real горимд хориотой).

## Тест

```
pnpm --filter @los/portal-bff test            # unit + e2e (mock ба real(HTTP) горим)
TEST_REDIS_URL=redis://localhost:6379 pnpm --filter @los/portal-bff test   # Redis store-ыг мөн шалгана
pnpm --filter @los/portal-bff lint && pnpm --filter @los/portal-bff build   # lint = eslint + tsc --noEmit
```

## Бүтэц

```
src/
  config/          env → PortalConfig, production-д fail-fast
  common/          алдааны каталог (монгол мессеж), correlation-id, crypto, mask, date (Asia/Ulaanbaatar)
  store/           KvStore порт: Memory | Redis (OTP, session, rate-limit, idempotency)
  security/        rate limit guard, idempotency
  audit/           AuditSink порт (одоо JSON лог)
  integrations/    порт бүр: interface + Mock + Real (INTEGRATION_MODE)
    customer-directory/  otp-sender/  loan-servicing/  contract-files/  payment-collection/
    mock/          нэг stateful MockLedger (төлбөр → үлдэгдэл/ЭТХ өөрчлөгдөнө)
  modules/         auth · loans · contract · payments
  testing/         createTestApp, FakeOrigination (origination-ийн дотоод гэрээний лавлах хэрэгжилт)
```

DTO / zod схем: `packages/contracts/src/portal.ts` (`@los/contracts`). Тооцоолол (аннуитет) `@los/calc`.

## Үндсэн env

`INTEGRATION_MODE` (`mock`|`real`), `ORIGINATION_URL`, `REDIS_URL`, `PORTAL_JWT_SECRET`, `PORTAL_HASH_SECRET`, `PORTAL_CORS_ORIGINS`, `PORTAL_TRUST_PROXY`. Бүрэн жагсаалт: docs/05 §7. Production **болон** `INTEGRATION_MODE=real` үед mock OTP, memory store, дутуу/давхцсан нууц, тодорхой бус `ORIGINATION_URL`-г `loadConfig` хүлээж авахгүй.
