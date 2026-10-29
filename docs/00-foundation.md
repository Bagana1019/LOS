# Модуль 0 — суурь: хөгжүүлэгчийн гарын авлага

Энэ баримт нь Модуль 1–14-ийг бичих хүнд зориулсан. Шаардлага `docs/01…04`, архитектурын дүрэм `CLAUDE.md`. Энд зөвхөн **суурь юу өгдөг, хэрхэн ашиглахыг** тайлбарлав.

## 1. Ажиллуулах

```bash
cp .env.example .env
docker compose up -d                 # postgres, dwh, redis, minio (+bucket)
pnpm install
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev                             # бүх сервис (turbo)
```

| Сервис | Порт | Health |
| --- | --- | --- |
| gateway | 4000 | `GET /api/health` |
| origination / kyc / scoring / valuation / dms | 4001–4005 | `GET /api/health` (liveness), `/api/health/ready` (DB, dms-д MinIO) |
| dwh-sync | 4006 | `GET /api/health` |

**Seed хэрэглэгчид** (нууц үг `SEED_PASSWORD`, анхдагч `Los@2026!dev`):

| Нэвтрэх нэр | Дүр | Салбар | Өгөгдлийн хүрээ |
| --- | --- | --- | --- |
| `officer.a` | OFFICER | Төв (100) | зөвхөн өөрийн хүсэлт |
| `officer.b` | OFFICER | Баянзүрх (200) | зөвхөн өөрийн хүсэлт |
| `manager` | BRANCH_MANAGER | Төв (100) | салбарын бүх хүсэлт |
| `approver` | APPROVER | Төв (100) | бүгд |
| `admin` | ADMIN | — | бүгд, тохиргоо |

```bash
curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"Los@2026!dev"}'      # → { accessToken, user, permissions, menu }
curl -s localhost:4000/api/origination/settings -H "authorization: Bearer $TOKEN"
```

## 2. Хүсэлтийн зам

```
web ──► gateway (JWT шалгана, эрх, rate limit, аудит) ──► сервис
         /api/<service>/<зам>   →   <service>/api/<зам>
         + X-User-Id X-Roles X-Branch-Id X-Org-Id X-Correlation-Id [X-Internal-Token]
```

Gateway клиентээс ирсэн бүх `X-*` identity толгой, `Authorization`, `Cookie`-г устгаж, өөрийн баталгаажуулсныг тавина. Сервис зөвхөн эдгээрт итгэнэ (`CommonModule`).

| Endpoint | Тайлбар |
| --- | --- |
| `POST /api/auth/login` | `{username, password}` → access token + `los_rt` cookie |
| `POST /api/auth/refresh` | cookie-ээр шинэ access token (refresh эргэлдэнэ) |
| `POST /api/auth/logout` | сесс хүчингүй (access token нэн даруй ажиллахаа болино) |
| `GET /api/auth/me` | хэрэглэгч, `permissions`, дүрийн `menu` (UI sidebar үүгээр зурна) |

Эрх/цэс: `packages/contracts/src/auth.ts` (`ROLE_PERMISSIONS`, `MENU`). Gateway-н товч эрхийн хүснэгт: `apps/gateway/src/modules/proxy/route-policy.ts` — шинэ "зөвхөн админ" endpoint нэмбэл тэнд мөр нэм.

## 3. Шинэ feature модуль нэмэх (сервис дотор)

`apps/<svc>/src/app.module.ts`-д модуль бүрийн `// import …` ба `// XxxModule,` мөр бэлэн — **өөрийнхөө мөрийг л задал** (зэрэгцээ салбарууд зөрчилгүй мерж хийгдэнэ). Жишээ нь `apps/origination/src/modules/settings/`.

```ts
@Controller('things')
export class ThingController {
  @Get() list(@Ctx() ctx: RequestContext) {
    return this.db.thing.findMany({ where: { orgId: ctx.orgId, ...scopeWhere(ctx) } });   // NFR-3: ҮРГЭЛЖ scope
  }
  @Permissions('settings:manage') @Put(':id') update(...) {}                              // эрх
  @Post() create(@Body(new ZodValidationPipe(CreateThing)) body: CreateThing) {}          // zod → 400
}
```

* Алдаа: `throw new DomainError('LTV_EXCEEDED', 'LTV хэтэрсэн', 422, details)` — тогтвортой `code` + монгол `message`. Үл мэдэгдэх алдаа 500, дотоод мэдээлэл задрахгүй.
* Нэг бичлэг авсны дараа: `assertInScope(ctx, record)` (хүрээнээс гадуур бол 403).
* Тохиргоо hardcode хийхгүй: `SettingsClient.get('br1.dti_max')` (origination өөрөө `SettingsService`). Шинэ түлхүүр → `packages/contracts/src/settings.ts` `SETTING_REGISTRY` + seed.
* Хувийн мэдээлэл: `@los/database` `encryptedField`; лог/аудитад бичихгүй (`recordAudit` нууц түлхүүрүүдийг автоматаар `[redacted]` болгоно).

### Өөр сервис дуудах (sync) — зөвхөн origination → {kyc, scoring, valuation, dms}
`InternalHttpClient` (`@los/nest-common`): `X-*` толгой, correlationId-г автоматаар дамжуулна; дотоод timeout 3с.

### Event (async)
Бизнес бичлэгтэй **нэг транзакцид**:
```ts
await this.db.$transaction(async (tx) => {
  const row = await tx.thing.update(...);
  await recordAudit(tx, { orgId, entity: 'THING', entityId: row.id, action: 'THING_UPDATED', actorId, beforeJson, afterJson, correlationId });
  await enqueueOutbox(tx, buildEvent(ctx, 'ScoringCompleted', { applicationId, ... }));   // схемээр шалгагдана
});
```
`EventsModule` (аль хэдийн app.module-д) `<svc>.outbox`-г Redis Stream `los:events` руу гаргана. Сонсох (consumer):
```ts
constructor(@Inject(EVENT_BUS) private bus: EventBus | null, private db: PrismaService) {}
async onModuleInit() {
  await this.bus?.subscribe('origination', ['ScoringCompleted'], idempotentHandler(this.db, 'origination', async (tx, e) => { … }));
}
```
`idempotentHandler` нь `processed_events(consumer, event_id)`-ээр давхар хүргэлтийг хаана. Шинэ event → `packages/contracts/src/events.ts` (zod + `version`).

## 4. Тест

* Сервис бүрт `vitest.config.mts` (`nestPreset` — Nest DI-д SWC шаардлагатай; config нь заавал `.mts`), `test/global-setup.ts` (schema-г шинээр үүсгэж migrate + seed), `test/setup-env.ts`.
* DB-тэй тестүүд `TEST_DATABASE_URL`-гүй бол **алгасагдана** (`describe.skipIf`). Нэр нь `test`-ээр төгссөн DB л цэвэрлэгдэнэ.
  ```bash
  createdb los_test
  TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test REDIS_URL=redis://localhost:6379/2 pnpm test
  ```
* Сервисийн e2e: `Test.createTestingModule({ imports: [AppModule] })` + supertest, gateway-н толгойг `as('officerA')` маягаар дуурайна (`apps/origination/test/app.ts`).
* Redis шаардсан тестүүд `REDIS_URL` байхгүй бол алгасагдана. Outbox relay-г унтраах: `OUTBOX_RELAY=off`.
* `@los/calc` — цэвэр функц, 100% coverage. Хэрэгжээгүй stub файлууд `packages/calc/vitest.config.ts`-д хасагдсан; өөрийнхөө файлыг тэндээс **хас**.

## 5. Prisma

* Сервис бүрийн модель `apps/<svc>/prisma/schema.prisma` (gateway → schema `iam`). Cross-schema FK хориотой.
* `pnpm db:generate | db:migrate | db:seed` (turbo) эсвэл нэг сервис: `pnpm --filter @los/origination db:migrate:dev`.
* **Migration нэмэх:** `db:migrate:dev --name <нэр>` — шинэ файл үүснэ. Baseline `20261028000000_init`-ийг БҮҮ засаарай (өөр салбарууд дээр суурилна).
* Seed нь create-only (давтан ажиллуулахад аюулгүй, админы засварыг дарахгүй).

## 6. Мерж хийх үед зөрчил гарах газрууд

`pnpm-lock.yaml` (merge-ийн дараа `pnpm install`-ээр дахин үүсгэ), `apps/<svc>/prisma/schema.prisma` + migration (өөр өөр feature-ийн хүснэгт бол нэг файлд зэрэгцэх тул шинэ migration файлаар нэм), `packages/contracts/src/{events,settings,auth}.ts` (нэмэх л), `packages/ui/src/i18n/mn.ts` (модуль бүр НЭГ import + `mnSources`-д НЭГ мөр нэмнэ — §7).

## 7. Web (apps/web) — shell, нэвтрэлт, i18n

```
app/layout.tsx → <Providers> (antd, TanStack Query, AuthProvider) → <AppShell> → хуудас
```

| Юу | Хаана |
| --- | --- |
| Нэвтрэх хуудас | `app/login/page.tsx`, `components/auth/LoginForm.tsx` |
| Сесс (access token санах ойд, refresh cookie-ээр сэргээнэ, 401 → нэг удаа refresh) | `lib/auth/session.ts`, `lib/auth/auth-context.tsx`, `lib/api.ts` (`apiFetch`, `authFetch`) |
| Хаалт, sidebar, дээд хайлт, хэрэглэгчийн цэс | `components/shell/*` |
| Хонх (FR-13.2) | `features/notifications/NotificationBellContainer.tsx` (shell-д залгасан) |
| Брэнд: өнгө, нэр, лого (брэндбүүк ирэхэд ЗӨВХӨН энэ файл) | `theme/brand.tsx` |
| Эрх/зам/хайлтын цэвэр функцүүд (тесттэй) | `lib/access.ts` |

* **Бүх дуудлага `apiFetch('/<service>/<зам>', { schema })`-ээр** (gateway `/api/...`, bearer + `X-Correlation-Id` автоматаар, хариуг `@los/contracts`-ийн zod-оор шалгана; `json`/`body` аль нэгээр). Хариуг (`Response`) өөрөө задлах, өөрийн алдааны схемтэй модуль `authFetch(url, init)`-ээр дууд — bearer нэмж, 401 дээр token шинэчилнэ. Нэвтрэлт шаардсан дуудлагад шууд `fetch` бүү хий (нийтийн `/sign`, `/verify` л үл хамаарна). Gateway зөвхөн `/api/<service>/*`-ийг дамжуулдаг тул origination-ий модуль `originationFetch('/<зам>')` / `originationDownload` (`${API}/origination/...`) ашиглана — хоосон угтвартай `/api/<зам>` бичихгүй (`features/gateway-paths.test.ts` барина). Сүлжээний алдаа (`fetch`-ийн `TypeError`) `apiFetch`-ээс анхны `TypeError`-оороо гарна.
* **Шинэ хуудас** = `app/<зам>/page.tsx`. Shell-ийн `Layout.Content` (`<main id="main">`) нь хуудасны цорын ганц `main` landmark бөгөөд 24px (гар утсанд 12px) padding өгдөг — хуудас өөрөө `<main>` болон давхар `padding` бүү нэм (`<div>`/`<section>`); `metadata.title`-д брэндийн дагавар (` · LOS Radix`) бүү бич — root layout-ийн `title.template` нэмнэ. Цэсэнд харагдах эсэх нь `packages/contracts/src/auth.ts` `MENU` + `ROLE_PERMISSIONS` (web дээр цэс бичихгүй). Цэсний дүрс: `components/shell/menu-icons.tsx`. Цэсэнд байхгүй ч эрх шаардах зам бол `lib/access.ts` `EXTRA_ROUTES`. Хуудас дотор эрхээр товч нууцлахдаа `useAuth().me.permissions`.
* **i18n:** текст бүр `t('<модуль>.<түлхүүр>')`. Түлхүүр модулийн нэрээр угтвартай (`auth.*`, `shell.*`, `customer.*`, `notification.*`) — өөр модулийн угтвыг бүү ашигла. Модуль бүр `packages/ui/src/i18n/mn.<модуль>.json` үүсгээд `mn.ts`-д НЭГ import + `mnSources`-д НЭГ мөр нэмнэ. Түлхүүр давхардвал `pnpm test` (`apps/web/src/i18n.test.ts`) унана.
* **Нэвтрэлтгүй хуудас:** `/login` ба түүнтэй адил нээлттэй хуудас `PUBLIC_PATHS`; shell-гүй, өөрийн token-той хуудас (`/sign/<token>`, `/verify/<code>` гэх мэт) `lib/access.ts` `STANDALONE_PREFIXES`-д prefix-ээ нэмнэ — тэнд сесс сэргээх дуудлага, redirect хийгдэхгүй. Нэвтрэлт шаардах ч staff sidebar/header-гүй, өөрийн shell-тэй хэсэг (мерчант портал `/merchant`) `OWN_SHELL_PREFIXES`-д. Бусад бүх зам нэвтрэлт шаардаж staff shell-д зурагдана. Нарийн дэлгэцэд (lg-ээс доош) sidebar давхарлан гарч, цэс сонгоход хаагдана; мерчант shell-д «Гарах» товч байна.
* **UI-д тооцоолол хийхгүй** (`@los/calc` л).
* **Тест:** эхлээд `pnpm --filter @los/contracts build` (web нь contracts-ийн `dist`-ийг ашигладаг; эсвэл `pnpm turbo test --filter @los/web`). `pnpm --filter @los/web test` (vitest, хурдан). E2E: `pnpm --filter @los/web test:e2e` — gateway-г mock хийсэн, backend хэрэггүй; `E2E_LIVE=1 pnpm --filter @los/web test:e2e` — ажиллаж буй бодит stack (§1) дээр (`live.spec.ts`). Модуль бүр `apps/web/e2e/<нэр>.spec.ts` нэмнэ; бүх хуудас нэвтрэлт шаарддаг тул spec бүр `mockGateway(page, { signedIn: true, role })` (`e2e/mock-gateway.ts`) эсвэл `new MockApi(role).install(page)` (`e2e/mock-api.ts` — `/auth/*`-ийг өөрөө нэмнэ)-оор эхэлнэ. Урьдчилан суулгасан Chromium ашиглах бол `PW_CHROMIUM_PATH`.
* Дээд хайлтын гэрээний дугаар `/los/loan-application?q=` руу очно — жагсаалтыг хэрэгжүүлэгч `q`-г унших ёстой (FR-1.4).
