# LOS Radix — Maker-Checker ("4 нүдний зарчим") буюу дотоод хяналтын урсгал

Огноо: 2026-10-28 · Эзэмшигч: Altanabagana · Код: `apps/origination/src/modules/maker-checker` · Contracts: `packages/contracts/src/maker-checker.ts`

## 1. Зорилго, хамрах хүрээ

Нэг ажилтан (maker — жишээ нь ЗЭЗ/Underwriter) шийдвэр гаргах эсвэл мэдээлэл засахад тэр өөрчлөлт **өөр хэрэглэгч (checker — ахлах ажилтан)** баталгаажуулах хүртэл хүчин төгөлдөр болохгүй. Хэн, хэзээ, юуг санал болгож, хэн батлав/татгалзсан нь өөрчлөх боломжгүй аудитын түүхэд үлдэнэ (NFR-3, NFR-4).

Хамрах хүрээ: ерөнхий (generic) механизм — хүсэлт, батлах/татгалзах/цуцлах, хугацаа, policy, аудит, event, REST, UI. Домэйн модуль бүр (хар жагсаалт, тохиргоо, бүтээгдэхүүн, гар аргаар тооцооллын арга солих, харилцагчийн KYC засвар…) өөрийн "батлуулах өөрчлөлт"-өө **handler** болгон бүртгэнэ (§8). Энэ PR-д зөвхөн policy-г өөрчлөх handler (§4, MC-BR-8) суулгагдсан; бусад handler нь тухайн модуль хийгдэхэд бүртгэгдэнэ.

FR-10 (зээлийн хүсэлтийн түвшинт батлах урсгал, олонхийн санал)-тай харьцаа: FR-10 нь **зээл олгох шийдвэр**-ийг дүнгээр шатлан олон батлагчийн олонхиор шийддэг. Maker-Checker нь түүнтэй зэрэгцэн **бусад өөрчлөлт/шийдвэр**-ийг (нэг батлагч, 4 нүд) хянана. Хоорондоо хамаарахгүй, давхардахгүй.

## 2. Ойлголт, дүр

| Нэр | Утга |
| --- | --- |
| Change request (хүсэлт) | Maker-ийн санал болгосон өөрчлөлт: `targetType` + `action` + `targetId` + `payload` + шалтгаан |
| Maker | Хүсэлт үүсгэгч. `handler.makerRoles`-д байх ёстой (жишээ OFFICER, BRANCH_MANAGER) |
| Checker | Өөр хэрэглэгч; policy-н `checkerRoles`-ийн нэг дүртэй (жишээ BRANCH_MANAGER, APPROVER). BRANCH_MANAGER зөвхөн өөрийн салбарын хүсэлтийг (салбаргүй хүсэлтийг салбарын дүр шийдэхгүй — APPROVER/ADMIN) |
| Handler | Домэйн модулийн бүртгэсэн `ChangeHandler`: payload schema, `snapshot`, `apply` |
| Policy | `(targetType, action)` бүрийн тохиргоо: идэвхтэй эсэх, `checkerRoles`, хүчинтэй хугацаа (цаг). Admin-д; мөр байхгүй бол handler-ийн анхдагч |
| DIRECT горим | Policy идэвхгүй үед өөрчлөлт шууд хэрэгжиж, гэхдээ ижил аудит бичигдэнэ |

## 3. Төлөв

```mermaid
stateDiagram-v2
  [*] --> PENDING: submit (FOUR_EYES)
  [*] --> APPLIED: submit (DIRECT, policy идэвхгүй)
  PENDING --> APPLIED: checker батлав → apply (нэг tx)
  PENDING --> REJECTED: checker татгалзав (тайлбартай)
  PENDING --> CANCELLED: maker цуцалсан
  PENDING --> EXPIRED: хугацаа дууссан
  PENDING --> FAILED: батлах үед зорилтот өгөгдөл өөрчлөгдсөн (хуучирсан)
```
Терминал төлвөөс буцахгүй (MC-BR-10) — maker шинэ хүсэлт илгээнэ.

## 4. Бизнес дүрэм

| Код | Дүрэм | Хамгаалалт |
| --- | --- | --- |
| MC-BR-1 | Хүсэлт үүсгэсэн хэрэглэгч (userId) өөрийн хүсэлтийг батлах/татгалзах боломжгүй. Дүр (ADMIN ч) тойрохгүй | service + DB `CHECK checker_id <> maker_id` |
| MC-BR-2 | Checker нь policy-н `checkerRoles`-ийн нэгтэй; BRANCH_MANAGER зөвхөн өөрийн салбарын (`X-Branch-Id`) хүсэлтийг; maker-т салбар байхгүй (`branchId = null`) бол салбарын дүр үзэх/батлах боломжгүй (fail-closed), APPROVER/ADMIN-ы үүрэг. Хүсэлт үүсэх үеийн `checkerRoles` хүсэлтэд хадгалагдана (дараа policy өөрчлөгдсөн ч хүчинтэй) | service + `required_checker_roles` |
| MC-BR-3 | Батлахаас өмнө зорилтот өгөгдөл өөрчлөгдөхгүй; батлахад `apply` + төлөв + түүх + event **нэг транзакцид** | `FOR UPDATE` түгжээ, tx |
| MC-BR-4 | Maker-д шалтгаан (≥3 тэмдэгт), татгалзахад тайлбар (≥3) заавал. Тэмдэгтийг code point-оор тоолно (emoji = 1); NUL (`\u0000`) байж болохгүй. HTTP-гүйгээр `submit()/approve()/reject()` дуудсан ч адил шалгана | zod (`@los/contracts`) service-д давхар + DB CHECK |
| MC-BR-5 | Нэг зорилтод (`org, targetType, targetId`) нэг л PENDING хүсэлт → 409; DIRECT өөрчлөлт ч хүлээгдэж буй хүсэлтийг гүйцэж давахгүй. Зорилт тус бүрийн илгээлтүүд цуваа (advisory lock + хүлээгдэж буй мөрийн `FOR UPDATE`), snapshot/`baseVersion` түгжээ авсны дараа уншигдана. CREATE-д `targetId` = ил биш байгалийн түлхүүр (customerId эсвэл регистрийн hash — §8 "PII") | advisory lock, partial unique index |
| MC-BR-6 | Хүсэлт `expiresInHours` дараа дуусна; дууссан хүсэлтийг батлах/татгалзах боломжгүй (409 `EXPIRED` — sweeper өмнө нь хаасан ч адил код); sweeper хараахан хаагаагүй дууссан хүсэлт шинэ илгээлтийг хаахгүй (шинэ илгээлт түүнийг EXPIRED болгоод үргэлжилнэ). Хугацааг мөрийн түгжээ авсны дараа уншина | `ExpirySweeper`, lazy expiry |
| MC-BR-7 | Батлах үед зорилтот өгөгдөл maker харснаас (`baseVersion`) өөр бол handler `ChangeConflictError` шидэж, өөрчлөлт хэрэгжихгүй, хүсэлт `FAILED` (шалтгаантай), maker дахин илгээнэ | handler + service |
| MC-BR-8 | Policy-г өөрчлөх нь өөрөө үргэлж 4 нүдтэй (`MAKER_CHECKER_POLICY/UPDATE`, `alwaysFourEyes`), үүнийг идэвхгүй болгох боломжгүй; maker зөвхөн ADMIN, checker анхдагчаар ADMIN/APPROVER (өөр хүн) | handler `validate` |
| MC-BR-9 | Үйлдэл бүр (илгээх, батлах, татгалзах, цуцлах, хугацаа дуусах, алдаа, DIRECT) append-only түүхэнд: хэн, дүр, хэзээ, тайлбар, өмнөх/шинэ төлөв | DB trigger: UPDATE/DELETE/TRUNCATE хориотой |
| MC-BR-10 | Терминал төлвөөс буцахгүй; илгээсэн агуулга (payload, maker, шалтгаан, зорилт, хугацаа) өөрчлөгдөхгүй; хүсэлт устахгүй | DB trigger `change_request_guard` |

## 5. Функциональ шаардлага

| ID | Шаардлага | Эрэмбэ |
| --- | --- | --- |
| MC-FR-1 | Maker `targetType/action/targetId/payload/reason` илгээнэ; policy идэвхтэй бол PENDING (HTTP 202), өгөгдөл хөдлөхгүй. Handler schema + `validate`-аар шалгана; зорилтын `before` snapshot + `baseVersion` хадгална | M |
| MC-FR-2 | Policy идэвхгүй бол DIRECT (HTTP 201): шууд хэрэгжиж, `mode=DIRECT`, түүхэнд `DIRECT_APPLIED` | M |
| MC-FR-3 | Checker батлах (тайлбар сонголттой) / татгалзах (тайлбар заавал). Давхар/зэрэг шийдвэр: нэг нь л хүчинтэй, бусад 409 | M |
| MC-FR-4 | Жагсаалт `scope`: `inbox` (миний батлах боломжтой), `mine` (миний илгээсэн), `decided` (миний шийдсэн), `all` (ADMIN); шүүлт (төлөв, targetType, applicationId), хуудаслалт 10/20/50/100; `summary` тоолуур | M |
| MC-FR-5 | Харах эрх: maker, шийдсэн checker, дүр/салбараар checker болох хүн, ADMIN. Бусдад 404 (байгаа эсэхийг ил болгохгүй) | M |
| MC-FR-6 | Maker өөрийн PENDING хүсэлтийг цуцлах | M |
| MC-FR-7 | Event (transactional outbox): `ChangeRequestSubmitted`, `ChangeRequestDecided` (APPLIED / APPLIED_DIRECT / REJECTED / CANCELLED / EXPIRED / FAILED) → DWH, мэдэгдэл | M |
| MC-FR-8 | Алдаа нэг хэлбэртэй `{statusCode, code, message, details?}`; `code` тогтмол, `message` монгол | M |
| MC-FR-9 | Admin: policy-н жагсаалт (`GET /policies`), өөрчлөлт (`PUT`, 4 нүдтэй) | M |
| MC-FR-10 | UI `/los/maker-checker`: Миний батлах / Миний илгээсэн / Шийдвэрлэсэн / Бүгд / Бодлого табууд, өмнө→дараа diff, аудитын timeline | M |
| MC-FR-11 | Мэдэгдэл (хонх, имэйл/SMS): `ChangeRequestSubmitted`/`Decided`-ийг мэдэгдлийн модуль сонсож `NotificationType`-д холбоно | S |
| MC-FR-12 | N-of-M (олон checker), delegation/эзгүйд орлох, SLA-ийн сануулга | C |

## 6. REST (gateway → origination `/api/maker-checker`)

Хэрэглэгчийг gateway толгойгоор дамжуулна (CLAUDE.md §3.2.9): `X-User-Id` (заавал), `X-Roles`, `X-Branch-Id`, `X-Org-Id`, `X-Correlation-Id`. Gateway-д `/api/maker-checker/*`-ийг нэвтэрсэн бүх хэрэглэгчид нээлттэй (эрхийг service шалгана), `PUT /policies/*`-ийг ADMIN-д хязгаарлахыг зөвлөнө (service давхар шалгана).

| Method | Зам | Үр дүн |
| --- | --- | --- |
| POST | `/requests` | 202 `{outcome:'PENDING', request}` / 201 `{outcome:'APPLIED_DIRECT', request}` |
| GET | `/requests?scope=&status=&targetType=&applicationId=&page=&pageSize=` | `{items,total,page,pageSize}` |
| GET | `/requests/summary` | `{inbox, mine}` |
| GET | `/requests/:id` | хүсэлт + `history[]`, `canDecide`, `canCancel` |
| POST | `/requests/:id/approve` `{comment?}` | 200 хүсэлт (APPLIED) |
| POST | `/requests/:id/reject` `{comment}` | 200 хүсэлт (REJECTED) |
| POST | `/requests/:id/cancel` `{comment?}` | 200 хүсэлт (CANCELLED) |
| GET | `/policies` | ADMIN/APPROVER; бүртгэлтэй handler бүрийн хүчинтэй policy |
| PUT | `/policies/:targetType/:action` `{enabled,checkerRoles,expiresInHours,reason}` | 202 (өөр админ батлах хүртэл PENDING) |

Алдааны кодууд: `UNAUTHENTICATED 401` · `SELF_APPROVAL_FORBIDDEN / CHECKER_ROLE_FORBIDDEN / CHECKER_BRANCH_FORBIDDEN / MAKER_ROLE_FORBIDDEN / ONLY_MAKER_CAN_CANCEL / FORBIDDEN 403` · `NOT_FOUND 404` · `ALREADY_DECIDED / EXPIRED / TARGET_HAS_PENDING_CHANGE / STALE_TARGET / DECISION_IN_PROGRESS 409` · `VALIDATION_FAILED 400` · `HANDLER_NOT_FOUND / PAYLOAD_INVALID / TARGET_ID_MISMATCH / POLICY_LOCKED 422`. Жагсаалт нь `@los/contracts`-ийн `MakerCheckerErrorCode` (backend-ийн статусын хүснэгт болон UI-н монгол текстийн тест хоёулаа үүнтэй тулгагдана).

`DECISION_IN_PROGRESS` — мөр/зорилтын түгжээг `MAKER_CHECKER_LOCK_TIMEOUT_MS` (анхдагч 3000 мс) дотор авч чадаагүй (өөр хэрэглэгч шийдэж байна); өөрчлөлт хийгдээгүй, дахин оролдоно. `MAKER_CHECKER_SWEEP_SECONDS` (анхдагч 60; `0` = зориуд унтраана; буруу утга анхдагч руу буцаж анхааруулга бичнэ; 1…3600-д хязгаарлана) — хугацаа дууссан хүсэлтийг хаах давтамж.

`MakerCheckerError` нь Nest-ийн `HttpException` тул домэйн модулийн контроллер `makerChecker.submit()`-ийг шууд дуудахад ч дээрх статус/`{statusCode, code, message, details?}` хэлбэрээр хариулна (filter залгах шаардлагагүй; `maker-checker.module.test.ts`-д шалгагдсан). `validate()`-аас `ChangeValidationError`-оос өөр алдаа (DB, сүлжээ, програмын алдаа) 422 болгон хувиргагдахгүй — 500 болж, дэлгэрэнгүй нь зөвхөн лог-д орно.

## 7. Өгөгдлийн загвар (origination schema; docs/03-д нэмэгдэнэ)

| Хүснэгт | Агуулга |
| --- | --- |
| `change_request` | хүсэлт: org/branch, target_type/target_id/action, application_id, mode, status, payload, before, base_version, reason, maker_id/roles, required_checker_roles, checker_id/roles/comment, failure_reason, expires_at, decided_at, version |
| `change_request_history` | append-only: seq, event, from/to status, actor_id/roles, comment, data, at |
| `maker_checker_policy` | org, target_type, action, enabled, checker_roles[], expires_in_hours |

Migration-ууд: `20261028090000_baseline` (`origination` schema + `outbox`; `prisma migrate diff --from-empty`-ээр үүссэн) → `20261028100000_maker_checker`. Хоосон DB дээр `prisma migrate deploy` ажиллана. Docker initdb (`packages/database/init/00-schemas.sql`) нь `outbox`-ийг өөр төрлөөр (uuid/timestamptz) урьдчилан үүсгэдэг тул тийм DB дээр `pnpm db:migrate` (`prisma migrate dev`) нэг удаа `origination` schema-г дахин үүсгэхийг асууна — зөвшөөрнө (зөвхөн dev DB; interaktiv биш орчинд `prisma migrate reset --force`). Миграци нь Prisma schema-тай ижил (`prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --exit-code`).

`20261028100000_maker_checker/migration.sql`-д Prisma илэрхийлж чадахгүй хамгаалалтууд: CHECK (maker≠checker, шалтгаан/тайлбар, DIRECT, PENDING-д шийдвэр байхгүй), partial unique index (нэг зорилтод нэг PENDING), `change_request_guard` trigger (устгахгүй, терминалаас буцахгүй, илгээсэн агуулга өөрчлөгдөхгүй), history/хүснэгтийн append-only trigger (UPDATE, DELETE, TRUNCATE). Дүрийн `TEXT[]` багана бүр `NOT NULL` (NULL нь CHECK-үүдийг тойрдог тул). Дүрийн жагсаалт (`OFFICER/BRANCH_MANAGER/APPROVER/ADMIN`) SQL CHECK-д давтагдсан — `UserRole`-д дүр нэмбэл шинэ migration-аар `maker_checker_policy_roles`-ийг шинэчилнэ.

## 8. Домэйн модуль handler бүртгэх

```ts
@Injectable()
export class BlacklistUpdateHandler implements ChangeHandler<BlacklistUpdate> {
  readonly targetType = 'BLACKLIST_ENTRY';
  readonly action = 'UPDATE';
  readonly payloadSchema = BlacklistUpdate;                // zod
  readonly makerRoles = ['OFFICER', 'BRANCH_MANAGER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 24 } as const;

  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry, @Inject(BlacklistRepo) private readonly repo: BlacklistRepo) {
    registry.register(this);
  }
  // maker харж буй төлөв: diff + хуучралт илрүүлэх хувилбар (MC-BR-7)
  async snapshot({ db, targetId }: SnapshotContext) { const e = await this.repo.find(db as Prisma.TransactionClient, targetId); return { before: e, baseVersion: String(e.version) }; }
  // зөвхөн ctx.db (tx)-ээр бич; гадагш HTTP/queue дуудахгүй
  async apply({ db, request, payload }: ApplyContext<BlacklistUpdate>) {
    const e = await this.repo.find(db as Prisma.TransactionClient, request.targetId);
    if (String(e.version) !== request.baseVersion) throw new ChangeConflictError();
    await this.repo.update(db as Prisma.TransactionClient, request.targetId, payload);
  }
}
// Controller/service-д: PATCH /blacklist/:id →
//   const r = await makerChecker.submit(actor, { targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: id, payload, reason });
//   r.outcome === 'PENDING' → 202 (батлагдахыг хүлээж байна), 'APPLIED_DIRECT' → 200
```
`imports: [MakerCheckerModule]` хийж, handler-ээ provider болгоно.

- **Алдаа**: `validate()`-д бизнес шалгалт бүтэлбэл `ChangeValidationError(mongolianMessage)` шидэнэ → maker-т 422 `PAYLOAD_INVALID` + тэр мессеж. `MakerCheckerError`-ийг шууд шидэж болно. Бусад алдаа 500 болно (түүхий мессеж хэрэглэгчид гарахгүй). Зорилт хуучирсан бол `apply()`-аас (эсвэл `validate()`-аас) `ChangeConflictError` → 409 `STALE_TARGET`.
- **`baseVersion`**: `snapshot()` буцаасан утгыг (эсвэл maker-ийн заасан хоосон биш утгыг) `apply()` дээр `request.baseVersion !== null && request.baseVersion !== одоогийн` хэлбэрээр харьцуулна (хоосон string-ийг contract хориглоно).
- **PII (CLAUDE.md §6.5)**: `change_request.target_id/payload/before/reason` болон history/event нь **ил текст, өөрчлөх боломжгүй (immutable)**. Иймд handler **регистр, дансны дугаар, ИҮ зураг зэрэг хувийн мэдээллийг эдгээрт хийж болохгүй** — ил биш ID (`customerId`, `blacklistEntryId`, регистрийн hash) заагаад бодит утгыг `snapshot`/`apply` дотор tx-ээр уншина. `encryptedField` (M00) хэрэгжсэний дараа шифрлэх/далдлах hook-ийг эхний PII handler-тай хамт нэмнэ.
- Handler-ийн `makerRoles` нь REST-ийн ерөнхий `POST /requests`-ийг ч хамгаална — domain controller-ийн шалгалтыг тойруулахгүйн тулд handler-д мөн адил шалгалтыг `validate`-д тавина.

Санал болгож буй handler-ууд (тухайн модуль хийгдэхэд): `BLACKLIST_ENTRY/{CREATE,UPDATE,DELETE}` (FR-13.1) · `SETTING/UPDATE` ба `PRODUCT/UPDATE` (модуль 12, BR босго) · `APPROVAL_LEVEL/UPDATE` · `CALCULATION/OVERRIDE_METHOD` (FR-8.2 гар сонголт) · `COLLATERAL/OVERRIDE_VALUATION` (FR-14.2 override_reason) · `CUSTOMER/UPDATE_KYC` (регистр, PEP) · `LOAN_APPLICATION/EDIT_AFTER_SUBMIT`.

## 9. Хязгаарлалт, дараагийн алхам

- **PII ил текстээр хадгалагдана** (§8): `target_id`, `payload`, `before`, `reason`, түүхийн `comment/data` болон outbox event-д. Хүсэлт өөрчлөгдөхгүй тул дараа нь далдлах боломжгүй — `encryptedField` хэрэгжтэл handler PII-г ил ID-аар солих ёстой.
- Байгууллагад зөвхөн нэг ADMIN байвал policy өөрчлөх хүсэлтийг APPROVER л батлана (анхдагч `checkerRoles`).
- Сервис нь gateway-ийн толгойд (`X-User-Id`, `X-Roles`, `X-Branch-Id`, `X-Org-Id`) шууд итгэдэг (CLAUDE.md §3.2.9) — origination-ы порт интернэтэд нээлттэй байж болохгүй; gateway толгойг өөрөө тавьж, клиентийнхийг дарж бичих ёстой.
- Хэрэглэгчийн лавлах (IAM) gateway-д тул "батлах боломжтой өөр хүн байгаа эсэх"-ийг шалгахгүй; хүсэлт хугацаа дуусаж EXPIRED болно.
- `enqueueOutbox` (`@los/database`) хэрэгжсэний дараа store-ын шууд outbox бичилтийг солино.
- Мэдэгдэл (MC-FR-11) ба `audit_log` хүснэгт хэрэгжихэд `ChangeRequest*` event-ийг сонсож холбоно.

## 10. Тест

```
pnpm --filter @los/contracts build                                    # origination/web тест contracts-ийн dist-ийг ашиглана
pnpm --filter @los/origination test                                   # unit + HTTP + модулийн wiring (санах ойн store)
# бодит PostgreSQL (хоосон DB дээр migration хэрэглээд):
DATABASE_URL=postgresql://los:los@localhost:5432/los_test pnpm --filter @los/origination exec prisma migrate deploy
TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test pnpm --filter @los/origination test
```
`TEST_DATABASE_URL` байхгүй бол PostgreSQL suite бүхэлдээ **алгасагдана** (turbo-д энэ хувьсагч `test` task-ийн cache түлхүүр тул алгассан үр дүн жинхэнэ ажиллагааг далдлахгүй). MC-BR-3/5 болон DB-ийн invariant-уудын жинхэнэ нотолгоо зөвхөн энэ suite — CI-д заавал `TEST_DATABASE_URL`-тэй ажиллуул. Тест бүр өвөрмөц `org_id`-тай; харин ажиллаж буй origination app-ын `ExpirySweeper` org-оос үл хамааран хугацаа дууссан бүх хүсэлтийг хаадаг тул тухайн DB дээр app-г `MAKER_CHECKER_SWEEP_SECONDS=0`-тэй эсвэл тусдаа DB ашигла.

Unit/HTTP: self-approval, дүр/салбар (салбаргүй хүсэлт), зэрэг батлалт, хугацаа (түгжээний дараах цаг, sweeper-ийн дараах `EXPIRED`), хуучирсан өгөгдөл, rollback, policy 4 нүд, scope-ууд, оролтын гэрээ (NUL/emoji/`baseVersion`), домэйн контроллерын алдааны статус. PostgreSQL: зэрэг батлалт (8 checker → 1), нэг зорилтод зэрэг илгээлт, илгээлт ба батлалтын уралдаан (snapshot түгжээний дараа), DIRECT-ийн цуваалал ба PENDING-ийг гүйцэхгүй байх, хугацаа дууссан хүсэлтийн lazy expiry, `lock_timeout`, tx rollback, SKIP LOCKED sweep, store шүүлт ба домэйн дүрмийн parity, DB trigger/CHECK/NOT NULL.
