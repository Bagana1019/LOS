# notification — Мэдэгдлийн систем (FR-13.2)

Хоёр төрлийн хүлээн авагч:

| Хүлээн авагч | Суваг | Хэзээ |
| --- | --- | --- |
| Ажилтан (`USER`) | `IN_APP` (хонх) | батлах хүсэлт ирэх, буцаагдах, батлагдах, олголт зөвшөөрөгдөх, SLA, @mention, хугацаа хэтэрсэн зээл |
| Зээлдэгч (`CUSTOMER`: PRIMARY + CO_BORROWER) | `SMS`, `EMAIL`, `PUSH` | зээл батлагдсан, олголт зөвшөөрөгдсөн, төлбөр хүлээн авсан, **төлөлт сануулах** (төлөх өдрөөс өмнө / өдөр нь / хэтэрсэн) |

## Бүтэц

```
NotificationController            — REST (доорх хүснэгт)
NotificationService (exports)     — notifyUsers / notifyCustomers / dispatch / list / markRead / markAllRead
TemplateService (exports)         — кодонд суулгасан монгол загвар + `notification_template` override, render, preview
DeliveryProcessor                 — нэг хүргэлтийг gateway-ээр илгээнэ (claim → SENT / дахин оролдлого / FAILED / SKIPPED), sweep()
ReminderService                   — төлөлт сануулах (cursor-оор багцлан), cron-д runAllOrgs()
NotificationEventConsumer         — ApplicationApproved / ApplicationReturned / DisbursementApproved / PaymentReceived → мэдэгдэл
NotificationRuntime               — queue worker + cron + sweep() timer; унтрахад хаана
PreferenceService / PushDeviceService / DeliveryAdminService
notification.queue.ts             — NotificationQueue порт: InlineNotificationQueue | BullMqNotificationQueue
../../integrations/{sms,email,push}  — Gateway interface + Mock + Real (CLAUDE.md §3.2.7); ../channel — нийтлэг ChannelError
```

Бусад модуль (approval, comment …) `NotificationModule`-ийг import хийж `NotificationService`-ийг дуудна:

```ts
// ажилтны хонх — бизнес өөрчлөлттэй нэг транзакцид
await notifications.notifyUsers({ orgId, userIds: [officerId], type: 'RETURNED', applicationId, payload: { applicationNo, comment } }, tx);
// зээлдэгчид — tx-тэй бол commit-ийн дараа dispatch
const r = await notifications.notifyCustomers({ orgId, customerIds, type: 'APPROVED', applicationId, payload, dedupeBase: `approved:${eventId}` }, tx);
await notifications.dispatch(r.deliveryIds); // tx-гүй дуудвал өөрөө queue-д оруулна
```

## Бизнес дүрэм

- **Суваг сонголт** (зээлдэгч бүр): `notification.channels_customer` (setting) ∩ `NotificationPreference` opt-out ∩ холбоо барих мэдээлэл (утас→SMS, имэйл→EMAIL, идэвхтэй `PushDevice`→PUSH; нэг зээлдэгчид хамгийн сүүлд харагдсан ≤ 3 төхөөрөмж).
- **Давхардал**: `dedupeKey = ${dedupeBase}:${customerId}:${channel}` (unique); PUSH-д төхөөрөмж бүрээр `…:PUSH:${deviceId}` (төхөөрөмжийн `lastSeenAt`-ийн эрэмбээс хамаарахгүй, тогтвортой). `createMany(skipDuplicates)` тул зэрэгцээ/дахин ажиллуулалт аюулгүй.
- **Queue хүрэхгүй (Redis унтарсан)**: `enqueue` хэзээ ч гацахгүй — producer холболт `enableOfflineQueue:false` (шууд алдаа) + `enqueueTimeoutMs` (анхдагч 3с) timeout. `dispatch()` / `sweep()` эхний алдаанаар зогсоно (QUEUED мөр DB-д үлдэж дараагийн sweep авна). Эхлэлд cron scheduler бүртгэл timeout (5с) болоод амжилттай болтол 15с тутам дахин оролдоно — модулийн эхлэлийг гацаахгүй. `close()` унтарсан Redis дээр ч албадан салгаж дуусна.
- **Тохиргооны хил**: `NotificationPreference` нь `(orgId, subjectType, subjectId, channel)` unique; уншилт/бичилт/`notifyUsers`/`notifyCustomers` бүгд `orgId`-аар шүүнэ. Ажилтан (iam схем) origination-д байхгүй тул USER-ийн org-д харьяалагдахыг шалгах боломжгүй — ADMIN зөвхөн өөрийн org-ийн мөрийг үүсгэнэ/уншина.
- **Утас**: `+976XXXXXXXX` (8 орон, 5–9-өөр эхэлнэ). Буруу утас/имэйл → `SKIPPED` + `lastError='INVALID_ADDRESS'`, алдаа шидэхгүй.
- **Дахин оролдлого**: retryable алдаанд `attempts++`, `nextAttemptAt = now + 30с·2^(attempts-1)`; `notification.max_attempts` (анхдагч 5) хүрвэл `FAILED`. Non-retryable → `FAILED`. `INVALID_TOKEN` → `PushDevice.isActive=false` + `SKIPPED`. Тохиргоогүй/хэрэгжээгүй Real gateway → `FAILED` (`NOT_CONFIGURED` / `NOT_IMPLEMENTED`).
- **Илгээсний дараах DB алдаа**: gateway амжилттай болсны дараа `SENT` бичилт унавал gateway-н алдаа биш — богино завсартай (100мс, 500мс, 2с) дахин оролдоно; бүгд унавал `DeliveryRecordError` шидэж (лог-д delivery ID + providerMessageId, хаяг/текстгүй) мөр QUEUED (lease-тэй) үлдэнэ, lease дууссаны дараа ТЭР ПРОЦЕСС дотор дахин илгээлгүйгээр `SENT` болгоно. Процесс унавал (санах ой алдагдана) lease-ээр дахин илгээгдэж болно — `reference = delivery.id`-г gateway идемпотент түлхүүр болгон ашиглах нь провайдерын баримт ирэхэд шийдэгдэнэ.
- **Зэрэг боловсруулалт**: `process()` нь `updateMany(where status=QUEUED, nextAttemptAt<=now)`-ээр lease (2 мин) авна; нэг delivery-г нэг worker л илгээнэ. Worker унавал lease дуусахад `sweep()` дахин авна.
- **Сануулга**: `ACTIVE`/`MIGRATED` зээлийн одоогийн (stale биш, хамгийн сүүлийн) ЭТХ-ийн үлдэгдэлтэй мөр → `@los/calc remindersFor(asOf, …)` (setting `notification.reminder_before_due_days`, `notification.reminder_overdue_days`). OVERDUE-д ЗЭЗ-д хонх (зөвхөн хүргэлт шинээр үүссэн үед).
- **Загвар**: `{{borrowerName}} {{amount}} {{currency}} {{dueDate}} {{contractNo}} {{applicationNo}} {{daysOverdue}} {{comment}}`. Үл мэдэгдэх placeholder → хоосон; хадгалахад 400 `INVALID_PLACEHOLDER`. Имэйл html бүхэлдээ escape хийгдэнэ. SMS ≤ 2 сегмент (≤ 134 тэмдэгт) — `template.builtin.test.ts` хамгийн урт утгаар шалгана.

## API

| Method path | Эрх |
| --- | --- |
| `GET notifications` · `GET notifications/unread-count` · `POST notifications/:id/read` · `POST notifications/read-all` | нэвтэрсэн ажилтан (зөвхөн өөрийн; бусдынх 404) |
| `GET notifications/templates` · `PUT notifications/templates` · `POST notifications/templates/preview` | ADMIN |
| `GET notifications/deliveries` | ADMIN (бүгд) · BRANCH_MANAGER (өөрийн салбарын хүсэлт) |
| `POST notifications/test-send` · `POST notifications/reminders/run` | ADMIN |
| `POST notifications/push-devices` · `DELETE notifications/push-devices/:token` | нэвтэрсэн (ажилтан→өөрийн userId, CUSTOMER дүр→өөрийн customerId) |
| `GET/PUT notifications/preferences/:recipientType/:recipientId` | ADMIN · OFFICER (өөрийн хүсэлтийн зээлдэгчийн өмнөөс) · CUSTOMER (өөрийн) · ажилтан (өөрийн IN_APP) |

## Тохиргоо (env)

| Env | Утга |
| --- | --- |
| `INTEGRATION_MODE` / `INTEGRATION_MODE_SMS` / `_EMAIL` / `_PUSH` | `mock` (анхдагч) \| `real` |
| `SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM` (+ нэмэлт `SMTP_SECURE`) | Email Real (nodemailer) |
| `SMS_API_URL SMS_API_KEY SMS_SENDER_ID` | SMS Real — **NotImplemented** (провайдерын баримт хүлээнэ) |
| `FCM_PROJECT_ID FCM_SERVICE_ACCOUNT_JSON` | Push Real — **NotImplemented** |
| `REDIS_URL` | байвал BullMQ (`notification-delivery`, prefix `los`); үгүй бол inline |
| `NOTIFICATION_QUEUE=inline` | BullMQ-ийг албадан унтраах (тест) |
| `NOTIFICATION_QUEUE_PREFIX`, `NOTIFICATION_WORKER_CONCURRENCY` (5) | BullMQ |
| `NOTIFICATION_REMINDER_CRON` (`0 9 * * *`, tz Asia/Ulaanbaatar) | BullMQ горимд өдөр бүрийн сануулга |
| `NOTIFICATION_SWEEP=off`, `NOTIFICATION_SWEEP_INTERVAL_SEC` (60) | алдагдсан QUEUED мөрийг сугалах timer |

## Тест

```
cd apps/origination && TEST_DATABASE_URL=postgresql://los@127.0.0.1:5432/los_test_notification REDIS_URL=redis://127.0.0.1:6379/3 \
  pnpm exec vitest run src/modules/notification src/integrations/sms src/integrations/email src/integrations/push
```

`bootNotification()` (`notification.test-helpers.ts`) — inline queue (шууд илгээнэ) эсвэл `manual: true` (QUEUED төлөвийг ажиглана). BullMQ тест бодит Redis дээр (`REDIS_URL`), давхцахгүй prefix-тэй.
