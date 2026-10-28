# 05 · Хамтран зээлдэгч/Батлан даагч · Төлбөр · Мэдэгдэл · Тайлан

`origination` сервис дэх дөрвөн модуль. Модуль бүрийн дэлгэрэнгүйг `apps/origination/src/modules/<модуль>/README.md`-с үз.
Шаардлага: docs/01 FR-1 (оролцогчид), FR-12.4 (эргэлт), NFR-2/4/5, CLAUDE.md §3.2. Хүснэгтийн нэр, баганын нэр docs/03-тай ижил.

## 1. Хэрэгжилтийн төлөв

| Модуль | Backend | Web | Бодит интеграци |
| --- | --- | --- | --- |
| Хамтран зээлдэгч / Батлан даагч / Барьцаалагч (`borrower`) | ✅ | ✅ wizard `client` алхам | — |
| Төлбөр (`payment`) — QPay · SocialPay · банкны шилжүүлэг | ✅ | ✅ `/los/loan/[id]/payments` | QPay Real (**баталгаажаагүй**); SocialPay, банк — skeleton |
| Мэдэгдэл (`notification`) — SMS · Email · Push · In-app | ✅ | ✅ хонх, `/notifications`, `/settings/notifications` | Email Real (SMTP); SMS, Push — skeleton |
| Тайлан / Dashboard (`report`) | ✅ 9 тайлан + Excel + dashboard | ✅ `/los/report`, `/los/report/[key]`, `/los/dashboard` | Core депозит — skeleton (mock өгөгдөл) |

## 2. API (gateway-ээр дамжина; сервис дотор `X-User-Id` … толгойд итгэнэ)

**borrower** — `GET|POST applications/:id/borrowers`, `GET …/borrowers/candidates`, `PATCH|DELETE …/borrowers/:borrowerId`, `POST …/make-primary`, `POST …/consent`.
Дүр: `PRIMARY` · `CO_BORROWER` · `GUARANTOR` · `PLEDGOR`. Хар жагсаалт, PEP, зөвшөөрөл, баталгааны хамрах хүрээ, хариуцлагын хувийн анхааруулга буцна (хадгалахыг хориглохгүй, батлагч шийднэ).

**payment** — `GET payments/providers`, `GET applications/:id/repayment-status`, `GET applications/:id/payments`, `POST payments/invoices`, `GET payments/invoices/:id`, `POST payments/invoices/:id/cancel`,
`POST payments/bank-transfers/reconcile`, `POST payments/bank-accounts/name-check`, `POST payments/dev/simulate` (зөвхөн mock + production биш),
callback: `GET|POST payments/callbacks/qpay`, `POST payments/callbacks/socialpay` (`@Public`; агуулгад итгэхгүй, provider-аас дахин баталгаажуулна).

**notification** — `GET notifications`, `GET notifications/unread-count`, `POST notifications/read-all`, `POST notifications/:id/read`,
`GET|PUT notifications/templates`, `POST notifications/templates/preview`, `GET notifications/deliveries`, `POST notifications/test-send`, `POST notifications/reminders/run`,
`POST|DELETE notifications/push-devices`, `GET|PUT notifications/preferences/:recipientType/:recipientId`.

**report** — `GET reports`, `GET reports/dashboard/summary`, `GET reports/:key`, `GET reports/:key/export` (xlsx).
Тайлан: `pipeline-progress`, `disbursed-loans`, `outstanding-balance`, `overdue-loans`, `closed-loans`, `upcoming-repayments`, `interest-payments`, `collateral-assets`, `deposit-balances`.

## 3. Event (`@los/contracts/events.ts`)

| Event | Гаргагч | Тайлбар |
| --- | --- | --- |
| `BorrowersChanged` | borrower | нэмэх / засах / хасах / үндсэн зээлдэгч солих; оролцогчдын одоогийн жагсаалттай (scoring, dwh) |
| `PaymentReceived` | payment | төлбөр бүртгэгдсэн; `unallocatedAmount`, `scheduleRowIds` |

Мэдэгдлийн consumer нь `ApplicationApproved`, `ApplicationReturned`, `DisbursementApproved`, `PaymentReceived`-ийг `notification` бүлгээр сонсож `processed_events`-ээр idempotent.

## 4. Тохиргоо

| Env | Утга |
| --- | --- |
| `INTEGRATION_MODE` (`mock` анхдагч \| `real`), `INTEGRATION_MODE_<NAME>` | `QPAY`, `SOCIALPAY`, `BANK_TRANSFER`, `SMS`, `EMAIL`, `PUSH`, `CORE_DEPOSIT` тус бүрийг тусад нь солино |
| `QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_INVOICE_CODE`, `QPAY_CALLBACK_BASE_URL`, `QPAY_BASE_URL` | QPay real |
| `SOCIALPAY_*`, `BANK_GATEWAY_*`, `SMS_*`, `PUSH_*`, `CORE_DEPOSIT_*` | skeleton-ийн **түр** нэрс — бодит баримт ирэхэд өөрчлөгдөнө |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email real |
| `NOTIFICATION_QUEUE=inline` (анхдагч: `REDIS_URL` байвал BullMQ), `NOTIFICATION_SWEEP*`, `NOTIFICATION_REMINDER_CRON`, `NOTIFICATION_WORKER_CONCURRENCY` | хүргэлтийн дараалал, сануулгын cron |
| `PAYMENT_MAINTENANCE=off`, `PAYMENT_MAINTENANCE_INTERVAL_SEC`, `PAYMENT_RECONCILE_INTERVAL_MIN`, `PAYMENT_EXPIRED_RECHECK_INTERVAL_MIN` | invoice sweep / банкны тулгалтын timer |
| `REDIS_URL`, `EVENT_BUS=memory`, `OUTBOX_RELAY=off` | Redis Streams (`REDIS_URL` байхгүй бол процесс доторх bus); outbox relay унтраах (тест) |
| `REPORT_DASHBOARD_CACHE_SECONDS` | dashboard-ын кэш |

Байгууллага бүрийн утга (`setting`): `borrower.max_co_borrowers` (3), `borrower.max_guarantors` (3), `payment.invoice_ttl_minutes` (60), `payment.min_amount` (1000),
`payment.collection_account`, `notification.reminder_before_due_days` ([3,1,0]), `notification.reminder_overdue_days` ([1,3,7]), `notification.max_attempts` (5),
`notification.channels_customer` (SMS/EMAIL/PUSH), `report.max_export_rows` (50 000). Түлхүүрүүд `@los/contracts` `SETTING_REGISTRY`-д бүртгэлтэй (анхдагч утга тэндээс; seed байгууллага бүрт мөр үүсгэнэ); уншилт `shared/org-settings.ts` → M0 `SettingsService`. BR-г кодод hardcode хийгээгүй.

## 5. Туршилт

```bash
pnpm exec turbo run build --filter=@los/origination...
# Postgres 16 + Redis (docker байхгүй бол өөрийн суулгасан binary-аар)
cd apps/origination
TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/los_test REDIS_URL=redis://127.0.0.1:6379/1 pnpm exec vitest run
pnpm --filter @los/web test; pnpm --filter @los/calc test; pnpm --filter @los/database test
```

Integration тест Module 0-ийн `test/global-setup.ts`-ээр `TEST_DATABASE_URL` дээр схемийг устгаж `prisma migrate deploy` + seed хийнэ (нэр нь `test`-ээр төгссөн DB л зөвшөөрөгдөнө) — **ажиллаж буй өгөгдлийн сан руу бүү заа**.
Алдааны хэлбэр M0-ийнх: `{ code, message, details?, correlationId }`; zod алдаа = 400 `VALIDATION_FAILED` + `details: [{ path, message }]`.
Регистр `maskRegisterNo`, данс `maskAccountNo` (M0 `@los/database`).
`report` модулийн perf тест (10k зээл) ~35 секунд.

## 6. Мэдэгдэж буй хязгаарлалт

- **QPay Real** нийтийн баримтаар бичигдсэн боловч sandbox/credential-аар **туршаагүй** (`qpay.real.ts` толгойд таамаглалууд жагсаасан).
- **SocialPay, банкны gateway, SMS (Mobicom/Unitel/Skytel…), Push (FCM/APNs), Core депозит** — `NotImplemented` skeleton. `real` горимд эдгээр нь 501/503 буюу `FAILED/NOT_IMPLEMENTED` болно. Mock горим deterministic.
- Төлбөр буцаалт (reversal) байхгүй; бүрэн төлөгдсөн зээлийг `CLOSED` болгох нь энэ хүрээнд биш.
- ЭТХ дахин үүсгэгдэж мөрийн ID солигдвол өмнөх `payment_allocation` шинэ мөрүүдэд шилжихгүй.
- Dashboard/тайлан Core-ийн бодит үлдэгдлийг бус LOS-ийн ЭТХ ба `payment`-ийг үндэслэнэ; DWH ETL (`dwh-sync`) энэ хүрээнд хийгдээгүй.
- **Gateway callback:** `payments/callbacks/*` нь `@Public` боловч gateway-н global JWT guard-ийн ард тул QPay/SocialPay-аас шууд дуудагдахгүй. Gateway-д зөвхөн эдгээр замыг JWT-гүй дамжуулах allowlist (+ provider IP/signature шалгалт) нэмэх **follow-up** хэрэгтэй (DECISIONS.md).
- Web shell (нэвтрэх хуудас, layout) M0-д ороогүй тул хонх layout-д залгагдаагүй (`NotificationBellContainer` зөвхөн экспортлогдсон); web-ийг gateway-ээр дамжуулан e2e ажиллуулаагүй.
- Prisma миграци: M0-ийн суурь дээр **нэг инкремент** `20261028120000_borrower_payment_notification_report` (`prisma migrate diff`-ээр үүсгэсэн). Дараагийн өөрчлөлт тус бүр шинэ миграци.
- Web компонентууд бодит хөтөч дээр интерактивээр шалгагдаагүй (SSR render + цэвэр логикийн тест).
