# erp-sync — ERP / Core руу бизнес үйл явдал дамжуулах (FIN-SYNC)

**Шийдвэр (2026-10-29, хувилбар B): журналыг ERP эзэмшинэ, LOS зөвхөн бизнес үйл явдлыг дамжуулна.**
Зээл олгогдох, шимтгэл суутгах, эргэн төлөлт орж ирэх бүрд LOS нь **бизнес үйл явдал** (дүн, талууд, лавлах дугаар)-ыг
гадаад санхүүгийн систем (ERP эсвэл Core banking) рүү webhook/API-аар **найдвартай** илгээнэ. Дансны код, дебит/кредит,
журналын мөр, нийт дүн зэрэг нягтлан бодох бүртгэлийн ойлголт LOS-д **байхгүй** — ERP өөрийн дүрмээр журналаа өөрөө үүсгэнэ.
Найдвартай байдал: transactional outbox, дахин оролдлого (exponential backoff), dead-letter, нэг зээлийн дарааллыг хадгалах, idempotency.

| ID | Шаардлага |
| --- | --- |
| FIN-SYNC-1 | Зээл олгогдоход (`DISBURSEMENT`) үйл явдал ERP руу явна |
| FIN-SYNC-2 | Шимтгэл суутгах/хураахад (`FEE_DEDUCTION`) үйл явдал явна |
| FIN-SYNC-3 | Эргэн төлөлт орж ирэхэд (`REPAYMENT`) үйл явдал явна — үндсэн, хүү, торгууль, шимтгэл, илүү төлөлтийн хуваарилалттай |
| FIN-SYNC-4 | Үйл явдал бизнес мөртэй нэг транзакцид outbox-д бичигдэнэ; илгээлт амжилтгүй бол автоматаар дахин оролдоно (NFR-2) |
| FIN-SYNC-5 | Гадаад систем adapter (`integrations/erp`) ард: Mock + Real (webhook/API), `INTEGRATION_MODE`-оор солино |
| FIN-SYNC-6 | Ops (ADMIN): жагсаалт, төлөв, DEAD үйл явдлыг дахин оролдуулах/хаах |

## Урсгал

```mermaid
flowchart LR
  BIZ[disbursement / payment модуль] -->|ErpSyncService.emit*(tx)| OB[(origination.erp_event<br/>PENDING)]
  OB -->|claimNext · SKIP LOCKED · lease| RELAY[OutboxRelayService]
  RELAY -->|ErpGateway.post| GW{INTEGRATION_MODE}
  GW -->|mock| MOCK[MockErpClient]
  GW -->|real| HTTP[RealErpClient · HMAC webhook/API]
  HTTP --> ERP[(ERP / Core · журналыг өөрөө үүсгэнэ)]
  RELAY -->|SENT · RETRY backoff · DEAD| OB
```

## Бизнес модулиас дуудах

```ts
// OriginationModule-д ErpSyncModule-г import хийнэ; дараа нь:
await prisma.$transaction(async (tx) => {
  const req = await tx.disbursementRequest.update({ /* … status = SENT_TO_CORE, core_loan_id … */ });
  await erpSync.emitDisbursement({
    orgId, branchId, applicationId, contractNo, coreLoanId: req.coreLoanId,
    sourceId: req.id,              // бизнес баримтын ID — idempotency түлхүүрийн үндэс
    businessDate: '2026-10-28', currency: 'MNT', amount: req.disburseAmount.toString(),
  }, { tx });                      // бизнес мөртэй хамт commit / rollback
});

await erpSync.emitRepayment({
  orgId, applicationId, sourceId: 'QPAY:20261028-000123', businessDate: '2026-10-28', currency: 'MNT',
  receivedAmount: '1000000.00',
  principal: '800000.00', interest: '150000.00', penalty: '0.00', fee: '0.00', overpayment: '50000.00',
}, { tx });
```

* `emitDisbursement` — **нийт** олгосон дүн (шимтгэлийг тусад нь `emitFeeDeduction`-оор).
* `emitFeeDeduction` — `fees: [{ kind: ORIGINATION | SERVICE | INSURANCE | OTHER, amount, memo? }]`. Нийт дүнг LOS тооцож `totalAmount` болгож дамжуулна.
* `emitRepayment` — `receivedAmount` ба хуваарилалт `principal / interest / penalty / fee / overpayment` **бүгд заавал** (тэг ч гэсэн); нийлбэр нь `receivedAmount`-тай тэнцэх ёстой. Мартсан бүрэлдэхүүн чимээгүй «илүү төлөлт» болохоос сэргийлнэ.
* `currency` заавал (анхдагч байхгүй): буруу валютаар чимээгүй бүртгэхгүй.
* `{ tx }` эсвэл `{ standalone: true }` заавал. `tx` мартвал `InvalidErpEventInputError` — outbox бичилт бизнес мөрөөс тусдаа commit болохоос сэргийлнэ. `standalone` нь зөвхөн скрипт/backfill-д.
* `sourceId` — `[A-Za-z0-9][A-Za-z0-9._:-]{0,99}` (HTTP толгойд явдаг тул). Олголт: `disbursement_request.id`; төлөлт: сувгийн гүйлгээний лавлах (`QPAY:<txn>`, банкны гүйлгээний ID).
* **Idempotency**: ижил `(orgId, EVENT, sourceId)` давтан дуудалт no-op (`created: false`). Агуулгын хэш нь *эдийн засгийн утга*-аас (eventType, sourceId, applicationId, currency, дүн/хуваарилалт/шимтгэлийн төрөл) тооцогдоно: ижил утгатай давталт, мөн зөвхөн `businessDate`/memo/correlationId өөрчлөгдсөн давталт no-op. Дүн өөр бол `IdempotencyConflictError`.
* Дүн: `number` (**≤ 2 орон**, ≤ 2^44; `0.1 + 0.2` зэрэг floating-point алдаатай утгыг **татгалзана**) эсвэл аравтын `string`/`Decimal`. Дотооддоо minor unit (bigint), гадагш `"1250000.00"` (numeric(18,2), ≤ 16 орон).
* Үйл явдал бичих үед илгээх payload-ийн шалгалтыг (`ErpEventPayload`) мөн хийнэ — дараа нь DEAD болж зээлийн дарааллыг хориглох мөр үүсгэхгүй.

## Дамжуулах формат (`schemaVersion: 1`)

Нийтлэг талбар: `eventId` (= `erp_event.id`, uuid), `idempotencyKey` (`<orgId>:<EVENT>:<sourceId>`), `eventType`, `orgId`, `branchId`, `applicationId`, `contractNo`, `coreLoanId`, `customerId`, `currency`, `businessDate`, `correlationId`, `createdAt`, дээр нь `eventType`-оор ялгагдах `data`:

| `eventType` | `data` |
| --- | --- |
| `DISBURSEMENT` | `{ "amount": "5000000.00" }` |
| `FEE_DEDUCTION` | `{ "fees": [{ "kind": "ORIGINATION", "amount": "100000.00", "memo"?: "…" }], "totalAmount": "150000.00" }` |
| `REPAYMENT` | `{ "receivedAmount", "principal", "interest", "penalty", "fee", "overpayment" }` — нийлбэр = `receivedAmount` |

Хүүгийн accrual (өдөр бүрийн хуримтлал), буцаалт/сторно, дансжуулалт энэ хувилбарт **байхгүй** — ERP эзэмшинэ.

## Outbox ба дахин оролдлого

`erp_event.status`: `PENDING` → `SENT` | `DEAD` | `CANCELLED`.

* **Түрээс (lease)**: relay `claimNext` нь `FOR UPDATE SKIP LOCKED`-оор нэг бичилтийг `leaseMs` хугацаагаар түрээслэж `attempts + 1` хийнэ. Олон instance зэрэг ажиллана; worker унавал түрээс дуусмагц бичилт дахин авагдана. Shutdown үед (`enableShutdownHooks`) явж буй tick дуустал хүлээнэ.
* **Дараалал**: нэг `application_id` доторх үйл явдлууд `seq`-ээр дараалан илгээгдэнэ — өмнөх нь `PENDING`/`DEAD` байвал дараагийнх хүлээнэ (олголт → шимтгэл → төлөлт). **DEAD үйл явдал тухайн зээлийн дараагийн бүх үйл явдлыг хориглоно**; `requeue` эсвэл `cancel` хийснээр чөлөөлөгдөнө. Өөр зээлүүд үүнд нөлөөлөхгүй.
* **Дахин оролдлого**: сүлжээ, timeout, 5xx, 429/408/425, 401/403, redirect (`REDIRECT`), буруу замын статус 404/405/406/410/415/421 (`ROUTE_ERROR`), 2xx боловч лавлах дугаар байхгүй (`NO_ACK`), HTML хариу → `RETRYABLE`. Зөв URL/эрх тохируулмагц үйл явдлууд өөрөө өнгөрнө. Хоцрол: `base × 2^(n-1)` (jitter ±20%, дээд хязгаартай; `Retry-After`-г дагана). `ERP_MAX_ATTEMPTS` (анхдагч 48 ≈ 2 хоног) хэтэрвэл `DEAD (MAX_ATTEMPTS)`. Бусад 4xx болон буруу payload → шууд `DEAD`.
* **Tick таслалт ба cooldown**: нэг tick-д `ERP_ABORT_AFTER_FAILURES` дараалсан RETRYABLE алдаа гарвал tick зогсоно, relay `ERP_COOLDOWN_MS` (30с) хүртэл дахин ажиллахгүй — гадаад систем унасан үед бусад үйл явдлын оролдлогын тоолуурыг үрэхгүй.
* **Баталгаа**: at-least-once. Илгээлт амжилттай болж DB-д тэмдэглэхээс өмнө унавал дахин илгээгдэнэ — тиймээс хүлээн авагч `Idempotency-Key`-ээр давхардлыг хаах **ёстой** (ERP журналыг нэг үйл явдалд нэг л удаа үүсгэнэ). Түлхүүр `<orgId>:<EVENT>:<sourceId>`. Хүлээн авагч давхардлыг `Idempotent-Replayed: true` толгой эсвэл `{"duplicate": true}` биеээр, 200 эсвэл 409-өөр дохиолно. Дохиогүй `409` (жишээ нь «хаагдсан сар») нь давхардал биш — `DEAD (REJECTED)`, хүн засна.
* **Лавлах дугаар (ack)**: `ERP_REQUIRE_ACK=true` (анхдагч) үед 2xx хариунд лавлах дугаар (`reference` / `id` / `documentNo` / `journalId`…) эсвэл давхардлын дохио заавал; үгүй бол `NO_ACK` гэж дахин оролдоно (алдааг чимээгүй амжилт гэж тооцохгүй). Дугаар өгдөггүй системд л `false`.
* Оролдлого бүр `erp_delivery_attempt`-д (үр дүн, HTTP статус, хугацаа), гар үйлдэл (requeue/cancel) actor-тай хамт бичигдэнэ.

## Гадаад систем (adapter)

`apps/origination/src/integrations/erp/` — `ErpGateway` interface, `MockErpClient` (deterministic `MOCK-…` ref, санах ойд), `RealErpClient` (generic webhook/API).

`RealErpClient`: `POST ERP_API_URL`, JSON `ErpEventPayload` (`@los/contracts`, `schemaVersion: 1`, мөнгө `"1250000.00"` мөр).
Толгой: `Idempotency-Key`, `X-LOS-Event-Id`, `X-LOS-Event-Type`, `X-LOS-Timestamp`, `X-LOS-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`, `X-Correlation-Id`, `X-LOS-Attempt`, сонголтоор `Authorization: Bearer`.
Хүлээн авагч тал timestamp-ийг (жишээ нь ±5 минут) шалгаж replay-аас хамгаална. Redirect дагахгүй (токен/гарын үсэг өөр хост руу гарахгүй), хариуны бие хязгаартай, алдааны текстээс нууц/токен арилгана.
Vendor-specific (SAP, 1C, Core) payload хөрвүүлэлт хэрэгтэй бол `ErpGateway`-г өөр `RealXxx`-ээр хэрэгжүүлээд `erp.config.ts`-ийн factory-д бүртгэнэ.

## Тохиргоо (env)

| Хувьсагч | Анхдагч | Утга |
| --- | --- | --- |
| `INTEGRATION_MODE` | `mock` (production-д **заавал тодорхой**) | `mock` \| `real`. Production-д орхивол апп эхлэхгүй (чимээгүй mock-оор үйл явдал илгээгдэхгүй байхаас сэргийлнэ) |
| `ERP_API_URL` | — | `real` үед заавал, https (localhost-оос бусад; `ERP_ALLOW_INSECURE=true`-ээр dev-д) |
| `ERP_WEBHOOK_SECRET` | — | `real` үед заавал, ≥ 16 тэмдэгт (HMAC) |
| `ERP_API_TOKEN` | — | Bearer token (сонголт) |
| `ERP_REQUIRE_ACK` | `true` | 2xx хариунд лавлах дугаар шаардах |
| `ERP_TIMEOUT_MS` | 15000 | HTTP timeout (CLAUDE.md §3.1: гадаад 15с) |
| `ERP_RELAY_ENABLED` / `ERP_RELAY_INTERVAL_MS` | `true` / 5000 | relay асаах, polling интервал. `OUTBOX_RELAY=off` (docs/00-foundation.md §4) бол relay бас унтарна |
| `ERP_BATCH_SIZE` / `ERP_CONCURRENCY` | 20 / 1 | tick бүрийн дээд үйл явдал, зэрэгцээ worker |
| `ERP_LEASE_MS` | timeout + 30с | түрээсийн хугацаа (timeout-оос урт байх ёстой) |
| `ERP_MAX_ATTEMPTS` | 48 | дараа нь DEAD |
| `ERP_RETRY_BASE_MS` / `ERP_RETRY_MAX_MS` | 30000 / 3600000 | backoff эхлэл / дээд |
| `ERP_ABORT_AFTER_FAILURES` / `ERP_COOLDOWN_MS` | 3 / 30000 | tick таслах дараалсан алдааны тоо / дараа нь хүлээх хугацаа |

Буруу утга бүхий **бүх** хувьсагчийн нэр нэг алдаанд жагсаагдана (нууцыг агуулахгүй).

## Ops API (gateway-ээр, `erp-sync:manage` эрх = `ADMIN`; бүгд хүсэлтийн байгууллагаар (`X-Org-Id`) хязгаарлагдана, өөр байгууллагын үйл явдал 404)

* `GET /api/origination/erp-sync/events?status=&eventType=&applicationId=&errorCode=&limit=&cursor=` — жагсаалт (шинэ нь эхэнд)
* `GET /api/origination/erp-sync/events/stats` — төлөв тус бүрийн тоо, хамгийн хуучин PENDING, `lagSeconds`, `relay` (target, mode, cooldownUntil) — monitoring-д
* `GET /api/origination/erp-sync/events/:id` — `data` + оролдлогын түүх
* `POST /api/origination/erp-sync/events/:id/requeue` `{ note? }` — DEAD/PENDING-ийг даруй дахин оролдуулна (URL/эрх зассаны дараа)
* `POST /api/origination/erp-sync/events/requeue-dead` `{ errorCode?, limit?(≤500, 200), note? }` — DEAD үйл явдлуудыг бөөнөөр
* `POST /api/origination/erp-sync/events/:id/cancel` `{ "note": "…" }` — гараар шийдвэрлэсэн (ERP-д гараар бүртгэсэн) үйл явдлыг хаана
* `POST /api/origination/erp-sync/events/dispatch` — relay-г нэг удаа ажиллуулна

## Тест

`pnpm --filter @los/origination test` — нэгж тестүүд. `TEST_DATABASE_URL=postgresql://…/los_test` (нэр нь `test`-ээр төгсөнө) өгвөл суурийн global-setup `origination` schema-г шинээр migrate хийж, `*.pg.test.ts` (claim/lease, дараалал, e2e relay) бодит PostgreSQL дээр ажиллана ([docs/00-foundation.md §4](../../../../../docs/00-foundation.md)).

## Хязгаарлалт / дараагийн алхам

* Ordering нь commit хийгдсэн мөрүүдийн `seq`-ээр; хоёр транзакц нэг зээлд зэрэг бичвэл commit-ийн дараалал `seq`-ээс зөрж болно.
* `disbursement` (Модуль 11) ба төлбөрийн модуль `ErpSyncService.emit*`-ийг дуудаж холбоно; одоогоор дуудагч байхгүй (энэ PR бусад thread-ийн кодыг өөрчлөөгүй).
* Хүлээн авагч ERP-ийн тал: `eventId`/`Idempotency-Key`-ээр давхардал хаах, `X-LOS-Signature` шалгах, журналын дүрмээ (данс, дебит/кредит) өөрөө тодорхойлох — LOS-д энэ мэдээлэл байхгүй.
* `ErpEventSynced` domain event / DWH fact — шаардлагатай бол нэмнэ.
