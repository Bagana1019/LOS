# LOS Radix — локал суулгалт ба туршилтын гарын авлага

Өөрийн компьютер дээр LOS Radix-г суулгаж, ажиллуулж, шалгах алхам алхмаар заавар. Бүх утга **DEMO** (docs/DECISIONS.md Q-101); ХУР, ЗМС, банк, QPay, ERP, SMS зэрэг гадаад систем бүгд **mock** — жинхэнэ систем рүү юу ч явахгүй.

> **Шалгасан орчин:** Linux (Ubuntu 24.04), Node 22.23, pnpm 9.12, Docker 29 / Compose v5. Цэвэр clone + хоосон Docker volume дээр `main` = `47dc78f` (PR #15, #16) үед `node scripts/local-setup.mjs` → `start` → `check` бүтэн гүйлт, `demo` горим, `stop`/`reset`, бүх тест (§7) ажилласан. Дараа нь Модуль 2 (PR #18, `main` = `3bfe0d9`) орсны дараа шинэ migration-тайгаар `setup` → `start` → `check` дахин ажиллаж, хүсэлтийн жагсаалт/үүсгэх дэлгэцийг шалгасан (бүх тестийг дахин ажиллуулаагүй). **Windows / macOS дээр энд шалгаагүй** — тэнд Docker Desktop + (Windows бол) WSL2 терминал ашиглахыг зөвлөнө (§1).

## 0. Хоёр арга — аль нь вэ?

| | **А. Мерчант POS демо** | **Б. Бүтэн stack** |
| --- | --- | --- |
| Docker хэрэгтэй юу | **Үгүй** | Тийм (Postgres, Redis) |
| Нэг командаар | `node scripts/local-setup.mjs demo` | `node scripts/local-setup.mjs` (нэг удаа), дараа нь `… start` |
| Юу харагдах | Мерчант POS лизингийн портал, 25 жишээ лизинг, 5 дүр (кассир, мерчантын админ, шинжээч, админ) | Нэвтрэлт, эрхийн цэс, **зээлийн хүсэлтийн жагсаалт + шинэ хүсэлт үүсгэх**, удирдлагын самбар, тайлан, баталгаажуулалт (maker-checker), мерчантын/мэдэгдлийн тохиргоо, POS лизингийн хяналт, 8 сервис + вэб |
| Өгөгдөл | Санах ойд (дахин асаахад шинэчлэгдэнэ) | PostgreSQL-д (seed: 5 хэрэглэгч, тохиргоо, 3 бүтээгдэхүүн, үнийн суурь, 1 туршилтын хүсэлт) |
| Хугацаа | Анхны суулгалт хэдэн минут | Анхны суулгалт хэдэн минут (миний шалгалтад кэштэй орчинд ~30 сек), дараа нь асаахад ~1 минут |

**Зөвлөмж:** эхлээд **А**-г (5 минут, Docker-гүй) үзээд, дараа нь **Б**-г суулга.

## 1. Урьдчилан суулгах зүйлс

| Юу | Шалгах | Хаанаас |
| --- | --- | --- |
| Git | `git --version` | https://git-scm.com |
| Node.js **22** (LTS) | `node -v` → `v22.x` | https://nodejs.org |
| pnpm **9** | `pnpm -v` → `9.x` | `corepack enable` дараа нь `corepack prepare pnpm@9.12.0 --activate` (эсвэл `npm i -g pnpm@9`) |
| Docker Desktop (зөвхөн **Б**) | `docker info` алдаагүй | https://www.docker.com/products/docker-desktop — суулгаад нээж, "Engine running" болтол хүлээнэ |

* **Windows:** WSL2 (Ubuntu) нээгээд тэр доторх терминалд Node, pnpm, git-ээ суулгаж, бүх командыг тэндээс ажиллуулахыг зөвлөнө (Docker Desktop-д "Use the WSL 2 based engine" асаалттай). `corepack enable` нь Windows дээр админ эрх шаардаж болно.
* **Нөөц:** нэгэн зэрэг 9 Node процесс (8 сервис + Next.js) ажиллана. Хамгийн багадаа 8 GB RAM, ~3 GB диск зөвлөнө (тооцоолол; нарийн хэмжээгүй).
* Репо хувийн (private) бол `git clone` хийхдээ GitHub-д нэвтэрсэн байх ёстой (GitHub Desktop эсвэл `gh auth login`).

## 2. Код татах

```bash
git clone https://github.com/Bagana1019/LOS.git
cd LOS
```

Бүх командыг репогийн **root** хавтаснаас ажиллуулна.

## 3. Арга А — Мерчант POS демо (Docker, өгөгдлийн сан хэрэггүй)

```bash
node scripts/local-setup.mjs demo
```

Анхны удаа хамаарлыг суулгаж, сангуудыг бэлдэнэ. Дэлгэцэнд `DEMO ONLY — Merchant POS` хайрцаг, `✓ Ready` гарсан хойно браузераар **http://localhost:4000/demo** нээнэ (анхны хуудас compile хийхэд ~20 сек). Нууц үг шаардахгүй — дүр сонгоно:

| Дүр | Хаана буух | Юуг үзэх |
| --- | --- | --- |
| Кассир — Төв дэлгүүр / Салбар дэлгүүр | `/merchant` | Хийх ажил (код хүлээж буй, хүлээлгэн өгөх…), үзүүлэлт, Шинэ лизинг, Лизингүүд |
| Мерчантын админ | `/merchant` | Бүх дэлгүүрийн нэгтгэл |
| Лизингийн байгууллага — шинжээч | `/los/pos-leases` | REFER хүсэлт хянах, төлбөр шилжүүлэх |
| Лизингийн байгууллага — админ | `/settings/merchants` | Мерчант, дэлгүүр, лизингийн хөтөлбөр |

OTP (худалдан авагчийн баталгаажуулах) код **тогтмол `123456`**. Зогсоох: терминалд **Ctrl+C**. (Энэ горим gateway-ийн оронд demo сервер ашигладаг тул `:4000` порт эзлэгддэг — **Б** аргатай зэрэг ажиллуулж болохгүй.)

## 4. Арга Б — бүтэн stack

### 4.1 Нэг командаар

```bash
node scripts/local-setup.mjs          # суулгалт — нэг удаа (давтаж ажиллуулахад аюулгүй)
node scripts/local-setup.mjs start    # асаах — бүх удаа
node scripts/local-setup.mjs check    # өөр терминалд: бүх сервисийн health + нэвтрэлтийн шалгалт
```

`setup` нь дараахыг дарааллаар хийнэ:

| # | Алхам | Яг юу |
| --- | --- | --- |
| 1 | Шалгалт | Node ≥ 22, pnpm ≥ 9, Docker ажиллаж байгаа эсэх |
| 2 | `.env` | `.env.example`-ээс `.env` үүсгэнэ (байвал **дарахгүй**). Хоёр засвартай — §4.3 |
| 3 | Дэд бүтэц | `docker compose up -d postgres dwh redis`, бэлэн болтол хүлээнэ. Өмнө нь манай контейнер асаалттай эсэх, :5432/:5433/:6379 портыг **манай биш** програм эсвэл өөр контейнер эзэлсэн эсэх, контейнер асаалттай ч порт нь гадагш нээгдсэн эсэхийг шалгаж, алдаа байвал засах алхмыг хэвлээд зогсоно (§8) |
| 4 | Суулгалт | `pnpm install --frozen-lockfile` |
| 5 | Бэлтгэл | `pnpm turbo run db:generate --concurrency=1` (Prisma client-уудыг **нэг нэгээр нь** — Windows-д зэрэг үүсгэхэд `EPERM` гардаг, §8) + нийтлэг сангуудыг build (`@los/database` гэх мэт — seed-д хэрэгтэй) |
| 6 | Өгөгдлийн сан | `pnpm db:migrate` (6 сервис, schema тус бүр), `pnpm db:seed`, дараа нь `SEED_DEMO=1`-ээр **туршилтын нэг хүсэлт** `DEMO-COL-0001` (`--no-demo-data` өгвөл алгасна). Үүний дараа `iam.user` хүснэгтэд seed хэрэглэгч байгаа эсэхийг **өөрөө шалгаж**, байхгүй бол юу дутууг нэрлээд зогсоно |

`start` нь Docker-ийн дэд бүтцийг шаардлагатай бол асааж, `pnpm dev`-ээр 8 сервис + вэбийг нэг дор асаана. Анхны ачаалал ~1 минут; вэбийн хуудас бүр анхны удаа compile хийхдээ 2–20 сек удна. **Зогсоох: Ctrl+C** (бүх процесс цэвэр зогсоно).

Тугнууд: `--skip-infra` — Docker ашиглахгүй, өөрийн Postgres/Redis-ээ (`.env` дахь `DATABASE_URL`, `REDIS_URL`) ашиглана; `--no-demo-data` — туршилтын хүсэлт нэмэхгүй. Бусад командууд: `test` (§7), `stop` (Docker зогсооно, өгөгдөл хэвээр), `reset` (Docker-ийн **бүх локал өгөгдлийг устгана**, `yes` гэж баталгаажуулна).

### 4.2 Гараар (скриптгүйгээр)

```bash
cp .env.example .env            # дараа нь §4.3-ын засваруудыг .env-д хий
docker compose up -d postgres dwh redis
pnpm install --frozen-lockfile
pnpm turbo run db:generate --concurrency=1      # Windows-д `pnpm db:generate` (зэрэг) EPERM өгч болно (§8)
pnpm turbo run build --filter='./packages/*'   # ← README-д байхгүй, гэвч seed үүнгүйгээр унана (§8)
pnpm db:migrate && pnpm db:seed
SEED_DEMO=1 pnpm --filter @los/origination db:seed   # заавал биш: туршилтын 1 хүсэлт
pnpm dev
```

### 4.3 `.env` — DEMO утгууд ба хоёр засвар

`.env.example` дахь утгууд (JWT_SECRET, DATA_ENCRYPTION_KEY, SEED_PASSWORD…) бүгд хөгжүүлэлтийн DEMO утга — **production-д бүгдийг солино**. Скрипт хоёр зүйлийг автоматаар засна (гараар хийвэл ижил):

1. `ERP_API_URL=`, `ERP_WEBHOOK_SECRET=`, `ERP_API_TOKEN=` гурвыг **`# `-ээр тайлбар болгох**. Хоосон мөр үлдвэл origination `invalid ERP integration config: ERP_API_URL, ERP_API_TOKEN, ERP_WEBHOOK_SECRET` алдаагаар эхлэхгүй.
2. `STORAGE_DRIVER=minio` → **`memory`**. Docker Hub дээрх `minio/minio`, `minio/mc` image **устсан** тул `docker-compose.yml`-ийн minio ажиллахгүй (§9). `memory` үед dms-ийн файл санах ойд хадгалагдаж, dms дахин асахад арилна.

### 4.4 Портууд

| Үйлчилгээ | Порт | Шалгах |
| --- | --- | --- |
| web (Next.js) | 3000 | http://localhost:3000/login |
| gateway | 4000 | `GET /api/health` |
| origination / kyc / scoring / valuation / dms | 4001–4005 | `GET /api/health` (мөн `/api/health/ready`) |
| dwh-sync | 4006 | `GET /api/health` (одоогоор зөвхөн health) |
| portal-bff | 4007 | `GET /api/health` |
| Postgres (LOS) / Postgres (DWH) / Redis | 5432 / 5433 / 6379 | `docker compose ps` |

### 4.5 Нэвтрэх хэрэглэгчид (seed)

Нууц үг бүгдэд `.env` дахь `SEED_PASSWORD` — анхдагч **`Los@2026!dev`** (яг 12 тэмдэгт: `L` `o` `s` `@` `2` `0` `2` `6` `!` `d` `e` `v`; том/жижиг үсэг чухал, гараар бичихээсээ **copy-paste** хий). Нэвтрэх нэр том/жижиг үсгийг ялгахгүй (`Admin` = `admin`). Seed нь **зөвхөн анх удаа** хэрэглэгч үүсгэдэг — `.env`-д `SEED_PASSWORD`-ийг дараа нь солиход байгаа хэрэглэгчийн нууц үг **солигдохгүй**; нууц үгээ солих бол `node scripts/local-setup.mjs reset` хийж дахин суулга.

| Нэвтрэх нэр | Дүр | Харах хүрээ | Цэс |
| --- | --- | --- | --- |
| `admin` | ADMIN | бүх хүсэлт | Харилцагч, Хүсэлт (Хар жагсаалт), Зээл, Баталгаажуулалт, Тайлан, **Тохиргоо** |
| `approver` | APPROVER | бүгд | Тохиргооноос бусад |
| `manager` | BRANCH_MANAGER | Төв салбар (100) | Тохиргооноос бусад |
| `officer.a` | OFFICER | зөвхөн өөрийн (Төв, 100) | Тохиргооноос бусад |
| `officer.b` | OFFICER | зөвхөн өөрийн (Баянзүрх, 200) | Тохиргооноос бусад |

Нэвтрэх endpoint IP тутамд **минутад 10** удаагаар хязгаарлагдсан — буруу нууц үгээр олон удаа оролдвол түр хаагдана; 5 удаа алдвал акаунт 15 минут түгжигдэнэ.

## 5. Smoke checklist — Б арга (вэбээр)

`start` ажиллаж байхад http://localhost:3000 нээж дараахыг дарааллаар шалга. (✔ = миний шалгалтад яг ингэж харагдсан. Алхмуудын агуулгыг (харилцагч, барьцаа, тооцоолол, баримт) `node scripts/local-setup.mjs`-ийн нэмсэн **туршилтын нэг хүсэлт** дээр шалгасан; шинээр үүсгэсэн хүсэлтийн хуудсыг (үе шат, алхмын жагсаалт) шалгасан боловч түүн дээрх алхмуудыг бүтнээр нь дамжаагүй, §9.)

| # | Хийх | Хүлээх үр дүн |
| --- | --- | --- |
| 1 | `/` нээх | `/login` руу шилжинэ ✔ |
| 2 | `admin` / `Los@2026!dev`-ээр нэвтрэх | «Сайн байна уу, Админ», дүр = Админ, харах хүрээ = Бүх хүсэлт, зүүн цэсэнд Харилцагч · Хүсэлт › Хар жагсаалт · Зээл · Баталгаажуулалт · Тайлан · Тохиргоо ✔ |
| 3 | Тайлан → **Удирдлагын самбар** | Шүүлтүүр (огноо, валют, салбар), «Зээлийн багц» картууд — **бүгд 0 / «Мэдээлэл алга»** (зээл бүртгэгдээгүй тул хэвийн) ✔ |
| 4 | Тайлан (жагсаалт) | Тайлангийн төрлүүдийн жагсаалт нээгдэнэ ✔ |
| 5 | **Баталгаажуулалт** (maker-checker) | «Баталгаажуулах хүсэлтүүд» хуудас, хоосон жагсаалт ✔ |
| 6 | Дээд баруун буланд хонх → Мэдэгдэл | «Мэдэгдэл алга байна» ✔ |
| 7 | Хаягийн мөрөнд `/settings/merchants` | «Мерчант» хуудас, «Мерчант бүртгэх» товч, «Мерчант бүртгэгдээгүй» ✔ |
| 8 | `/settings/notifications` | Табууд: Загвар · Хүргэлтийн бүртгэл · Туршилт ба сануулга · Зээлдэгчийн сувгийн тохиргоо ✔ |
| 9 | `/los/pos-leases` | «POS лизинг», «Хянах хүсэлт алга» ✔ |
| 10 | `/merchant` (admin-аар) | «Хандах эрхгүй» — мерчантын эрхгүй тул зөв ✔ |
| 11 | Хэрэглэгчийн цэс → Гарах → `officer.a`-аар нэвтрэх | Цэсэнд **Тохиргоо алга**; хуудас сэргээхэд (F5) нэвтэрсэн хэвээр, гарсны дараа F5 хийвэл `/login` ✔ |
| 12 | `officer.a`-аар нэвтэрсэн хэвээр, зүүн цэс **Хүсэлт** (`/los/loan-application`) | «Зээлийн хүсэлт» — төлвийн табууд (Шинэ · Илгээсэн · Батлах явцад · Батлагдсан · Буцаасан · Олгох · Идэвхтэй · Хаасан), «Шинэ хүсэлт», «Excel татах» товч; жагсаалтад setup-ийн нэмсэн `DEMO-COL-0001` ✔ |
| 13 | «Шинэ хүсэлт» → «Үүсгэх» | Цонх «Шинэ зээлийн хүсэлт»; үүсгэмэгц `LA-2026-000001` (дараагийнх `…000002`) хүсэлтийн хуудас нээгдэнэ: «1-р үе шат · Хүсэлт Бүрдсэн: 0/9» (9 алхам: Харилцагч, Лавлагаа, Орлого, Зээлийн мэдээлэл, Барьцаа, Эргэн төлөлтийн хуваарь, Тооцоолол, Баримт бичиг, Шийдвэр), «2-р үе шат» (Гэрээ, Албан бичиг, Зээл олгох хүсэлт) 🔒 цоожтой, «Илгээх» товч ✔ |
| 14 | `/los/loan-application/00000000-0000-4000-8000-000000000402/client` (туршилтын `DEMO-COL-0001`, 20 сая ₮ / 36 сар) | Дээд талд «Бүрдсэн: 4/9», доор «Харилцагч ба оролцогчид» — Үндсэн зээлдэгч 1 (Жишээ Бат-Эрдэнэ, УЕ****0001) ✔ |
| 15 | Ижил хүсэлтийн `/collateral` | «Барьцаа» — LTV/G0 карт, «G0 хаалтыг хангаагүй шалтгаан: 1 — Барьцаа бүртгээгүй байна», «Барьцаа нэмэх». Товчийг дарвал «Өмчлөгч (барьцаалагч): Жишээ Бат-Эрдэнэ · УЕ****0001», «ХУР-аас сонгох» бүхий цонх нээгдэнэ ✔. (Цааш: ХУР-аас автомашин `УЕН5246` → нэмэх → өмчлөл → ачаалал → үнэлгээ → баримт — `apps/origination/src/modules/collateral/README.md`-д бичсэн, UI-аар бүтнээр нь энд давж шалгаагүй) |
| 16 | Ижил хүсэлтийн `/score`, `/document`, `/installment` | «Тооцоолол» (A/B/C арга, «Тооцоолол хараахан хадгалагдаагүй») ✔; «Баримт бичиг» (0 / 3 заавал баримт: иргэний үнэмлэх, цалингийн тодорхойлолт, зээлийн хүсэлтийн маягт) ✔; бусад алхам (`/installment` гэх мэт) «Энэ алхам хараахан бэлэн болоогүй байна» ✔. Агуулгатай алхмууд: `client`, `collateral`, `score`, `document` |
| 17 | Терминалд `node scripts/local-setup.mjs check` | Бүх сервис ✓, «admin нэвтэрлээ» ✔ |

Хүссэн бол автомат хувилбар: `E2E_LIVE=1 pnpm --filter @los/web test:e2e` (нэвтрэлт, цэс, refresh cookie, гарах — 2 тест; ажиллаж буй stack дээр. Playwright-ийн хөтөч суугаагүй бол `pnpm --filter @los/web exec playwright install chromium` — энэ командыг энд ажиллуулаагүй, би урьдчилан суусан хромийг `PW_CHROMIUM_PATH`-аар зааж ашигласан).

## 6. Backend-ийг curl-ээр шалгах (UI-д хараахан гараагүй хэсэг)

Дараах нь gateway-ээр дамжиж, жинхэнэ эрх/аудит/DB-тэй ажиллана. (Windows PowerShell-д `curl.exe` гэж бич, эсвэл WSL/Git Bash ашигла.)

```bash
# 1) Нэвтэрч token авах
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"officer.a","password":"Los@2026!dev"}' | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).accessToken")

# 2) Тохиргооны жагсаалт (seed: 45 түлхүүр)
curl -s localhost:4000/api/origination/settings -H "authorization: Bearer $TOKEN"

# 3) ХУР (mock)-оос иргэний мэдээлэл — хадгалахгүй, зөвхөн маягт бөглөх өгөгдөл
curl -s localhost:4000/api/origination/customers/xyp-fetch -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"registerNo":"УБ90010112"}'
```

Хүлээгдэх хариу (✔ шалгасан): (2) нь `br1.dti_max` (0.55), `br2.dscr_min` (1.25), `br3.ltv_max` (0.7) … түлхүүртэй JSON массив; (3) нь `Мөнхзул Батсайхан`, `prefilledFields`, `missing` талбартай JSON (mock fixture — регистрээс тогтвортой хариу; `…00000000` → олдохгүй, `…99999999` → ХУР унасан). Админаар `GET /api/origination/reports/dashboard/summary` → 200.

## 6.1. Админ тохиргоо (M13) — вэбээр тестлэх

Нэвтрэх: `admin` / `Los@2026!dev` → зүүн цэсэнд **Тохиргоо** → `/settings` дээр 7 карт гарна. (Админ биш хэрэглэгчээр `/settings` руу ороход «Эрх хүрэхгүй».)

1. **Батлах түвшин** (`/settings/approval-levels`): seed-ийн 3 түвшин харагдана. Дээд дүн өөрчилбөл дараагийн түвшний доод дүн дагаж өөрчлөгдөнө. Батлагч сонгоод **Хадгалах** → «Батлах түвшин хадгалагдлаа». Завсартай/давхцсан босго бол улаан алдаа гарч товч идэвхгүй болно. Шийдвэр хүлээж буй хүсэлт байвал сервер 409 өгнө.
2. **Салбар ба хэрэглэгч** (`/settings/branches`):
   * *Салбарын код*: салбар бүрийн кодыг бич (жишээ `100`, `200`) → **Хадгалах**. Давхардсан код хадгалагдахгүй. Код гэрээний дугаарын `{BRANCH}` хэсэгт орно.
   * *Хэрэглэгчийн салбар*: хэрэглэгч бүрийн **Салбар** сонголтыг солино. ЗЭЗ, салбарын захирлыг «Төв (салбаргүй)» болгож болохгүй. Салбар солигдсон хэрэглэгч дахин нэвтэрнэ (сесс хүчингүй болно) — шинэ хүрээ (өөрийн салбарын хүсэлт) дараагийн нэвтрэлтээс үйлчилнэ.
3. **Гэрээний дугаарын загвар** (`/settings/contract-number`): загвар `{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}`, угтвар `B`, хүрээ «Өдөр бүр» → доор жишээ `B10026110301` хэлбэрээр харагдана. `{SEQ}` байхгүй бол хадгалагдахгүй.
4. **Бизнес дүрмийн параметр** (`/settings/parameters`): жишээ нь `br1.dti_max` (ӨОХ)-ийг **Засах** → `0.5` → Хадгалах. Утга буруу (жишээ `5`) бол сервер 400 өгнө. Өөрчилсний дараа тооцоолол шинэ утгаар бодно (hardcode байхгүй).
5. **Аудит лог** (`/settings/audit`): дээрх өөрчлөлт бүр мөр болж гарна (`SETTING_UPDATED`, `APPROVAL_LEVELS_REPLACED`, `CONTRACT_TEMPLATE_UPDATED`); мөрийг дэлгэвэл өмнө/дараах утга. «Нэвтрэлт, хэрэглэгч» таб дээр `USER_BRANCH_ASSIGNED`, нэвтрэлтүүд харагдана.
6. **Тайлан** (`/los/report`): 9 тайлан (Эргэн төлөлт, Хугацаа хэтэрсэн, Үлдэгдлийн дэлгэрэнгүй, Хаагдсан, Олгосон, Хүү төлөлт, Барьцаа, Явцын хяналт, Депозит) — тус бүр дээр **Excel** татах товч.

curl-ээр (§6-ийн `TOKEN`-ийг `admin`-аар аваад):

```bash
curl -s localhost:4000/api/origination/approval-levels -H "authorization: Bearer $TOKEN"
curl -s localhost:4000/api/admin/users -H "authorization: Bearer $TOKEN"
curl -s "localhost:4000/api/origination/audit-logs?pageSize=5" -H "authorization: Bearer $TOKEN"
```

Автомат тест: `pnpm --filter @los/origination exec vitest run src/modules/admin`, `pnpm --filter @los/gateway exec vitest run test/admin.e2e.test.ts` (PostgreSQL шаардана, §7).

## 7. Автомат тест ажиллуулах (заавал биш)

Тестүүд бодит Postgres + Redis ашиглана. Нэр нь `test`-ээр төгссөн DB л цэвэрлэгддэг (тест schema-г устгаад шинээр үүсгэнэ) тул **`los` DB-д хөндөхгүй**.

```bash
docker compose exec -T postgres psql -U los -d postgres -c "create database los_test"   # нэг удаа
# macOS / Linux / WSL:
TEST_DATABASE_URL=postgresql://los:los@localhost:5432/los_test REDIS_URL=redis://localhost:6379/2 pnpm test
# Windows PowerShell:
$env:TEST_DATABASE_URL="postgresql://los:los@localhost:5432/los_test"; $env:REDIS_URL="redis://localhost:6379/2"; pnpm test
```

Хамгийн хялбар нь скриптээр — `los_test` DB-г өөрөө үүсгэж, шаардлагатай env-г тавина:

```bash
node scripts/local-setup.mjs test
```

**Яагаад скрипт зөвлөдөг вэ:** root `.env`-ийн `INTERNAL_AUTH_SECRET` нь сервисүүдийн тестэд `401 INVALID_INTERNAL_TOKEN` үүсгэж, жишээ нь `valuation` 150 тест унадаг (шалгасан). CI-д `.env` байдаггүй. Скрипт тест дууртал `.env`-г түр `node_modules/.env.stashed-for-tests` болгож хажуулаад дараа нь буцаадаг (хүчээр таславал дараагийн `node scripts/local-setup.mjs …` ажиллуулалт буцаана). Гараар хийвэл `.env`-г нэрийг нь түр өөрчилж, тест дараа буцаа.

**Шалгасан үр дүн** (2026-11-02, `main` = `47dc78f`, 4 vCPU / 16 GB Linux, Docker Postgres 16 + Redis 7): `pnpm test` → **26/26 task ногоон, 0 унасан, ~12 500 тест давсан (37 алгассан), 7 мин 30 сек**. Багц тус бүр: origination 3895 · scoring 2286 (+20 алгассан) · web 1306 · dms 1060 · kyc 1048 · ocr 858 (+9) · calc 687 · contracts 452 · valuation 401 · gateway 226 · portal-bff 183 (+8) · database 101 · nest-common 34. Бүх тест mock + хоосон DB дээр ажиллана — жинхэнэ гадаад систем хэрэггүй.

## 8. Асуудал гарвал

| Шинж тэмдэг | Шалтгаан / шийдэл |
| --- | --- |
| `origination`: `invalid ERP integration config: ERP_API_URL, ERP_API_TOKEN, ERP_WEBHOOK_SECRET` | `.env`-д ERP_* гурав хоосон (`ERP_API_URL=`). Мөр бүрийн өмнө `# ` тавь (§4.3). `node scripts/local-setup.mjs` үүнийг өөрөө засдаг |
| `pnpm db:seed`: `Cannot find module '…/@los/database/dist/index.js'` | Нийтлэг сангууд build хийгдээгүй. `pnpm turbo run build --filter='./packages/*'` хийж дахин seed (скрипт үүнийг хийдэг) |
| `docker compose up -d`: `pull access denied for minio/mc` (эсвэл `minio/minio`) | Image Docker Hub-аас устсан (§9). `docker compose up -d postgres dwh redis` (minio-гүй) гэж ажиллуул |
| `dms`: `connect ECONNREFUSED 127.0.0.1:9000` | `.env`-д `STORAGE_DRIVER=minio` боловч MinIO алга. `STORAGE_DRIVER=memory` болго, dms-ийг дахин асаа |
| `port is already allocated` / `EADDRINUSE` | Порт өөр програмд эзлэгдсэн (өөрийн PostgreSQL/Redis, өмнөх `pnpm dev`). Түүнийг зогсоо; скрипт эзлэгдсэн портыг нэрлэж зогсдог |
| `:5432 порт өөр програмд эзлэгдсэн байна` (эсвэл `:5433`, `:6379`) | Тухайн порт дээр **манай биш** програм (ихэвчлэн таны суулгасан PostgreSQL/Redis) хариулж байна. Зогсоо: **Windows** — Win+R → `services.msc` → «postgresql-x64-…» (Redis бол «Redis») → баруун товч → **Stop** (байнга бол Properties → Startup type: **Manual**); эсвэл Administrator PowerShell: `Get-Service *postgres*` → `Stop-Service <нэр>`. **macOS/Linux**: `brew services stop postgresql` / `sudo systemctl stop postgresql`. Дараа нь `node scripts/local-setup.mjs`. Эсвэл Docker-гүй `--skip-infra` |
| `:5432 портыг өөр Docker контейнер эзэлж байна: <нэр>` | Өөр (эсвэл өмнөх хавтасны) Docker контейнер тэр портыг авсан. `docker stop <нэр>` (өмнөх LOS-ийнх бол `docker compose down`), дараа нь `node scripts/local-setup.mjs` |
| `postgres контейнер асаалттай боловч :5432 порт гадагш нээгдээгүй байна` (`docker compose ps` дээр `5432/tcp` гэж л харагдана, `0.0.0.0:5432->5432/tcp` биш), эсвэл `pnpm db:migrate` → `P1000: Authentication failed against database server at localhost` | Docker «Started» гэсэн ч **портыг нь гадагш нээж чадаагүй** — яагаад гэвэл :5432-ыг таны өөрийн PostgreSQL эзэлсэн. Тэгээд migration манай контейнер биш, **таны өөрийн PostgreSQL** руу холбогдож нууц үг таарахгүй `P1000` өгдөг. Засах: ① өөрийн PostgreSQL үйлчилгээг зогсоо (`services.msc` → Stop, дээрх мөрийг үз) ② `docker compose down` ③ `node scripts/local-setup.mjs`. Дараа нь `docker compose ps`-д `0.0.0.0:5432->5432/tcp` гарсан эсэхийг шалга. Скрипт одоо үүнийг өөрөө илрүүлж дээрх алхмуудыг хэвлэнэ |
| Манай контейнер аль хэдийн асаалттай үед «порт эзлэгдсэн» гэсэн (худал) мэдэгдэл | Засагдсан: скрипт эхлээд **манай** compose-ийн контейнер асаалттай эсэхийг шалгаж, тийм бол порт «эзлэгдсэн» гэж гомдоллохгүй, зөвхөн порт нь гадагш нээлттэй эсэхийг шалгана |
| `pnpm: command not found` / pnpm хувилбар буруу | `corepack enable && corepack prepare pnpm@9.12.0 --activate` |
| Docker «not running» | Docker Desktop-ийг нээж «Engine running» болтол хүлээ; эсвэл Docker-гүй **А** арга / `--skip-infra` |
| Вэб нэвтрэхэд **«Нэвтэрч чадсангүй. Дахин оролдоно уу.»** | Нууц үг буруу гэсэн мессеж **биш** — gateway **алдаа (HTTP 500)** буцаасан гэсэн утга. Бараг үргэлж `iam` хүснэгт үүсээгүй (migration дуусаагүй/унасан), эсвэл Prisma client буруу. `node scripts/local-setup.mjs check` ажиллуулбал «`iam.user` хүснэгт алга — migration хийгдээгүй» гэж нэрлэнэ. Зас: `node scripts/local-setup.mjs` (давтаж болно) — эсвэл гараар `pnpm turbo run db:generate --concurrency=1` → `pnpm db:migrate` → `pnpm db:seed`, дараа нь `check`. Алдааны шалтгаан gateway-ийн лог (`@los/gateway:dev: …`) дээр байна |
| Вэб нэвтрэхэд **«Нэвтрэх нэр эсвэл нууц үг буруу»** | gateway ажиллаж, хариу өгсөн (HTTP 401). Нэр/нууц үг таарсангүй: (а) нууц үгийг copy-paste хий (§4.5, 12 тэмдэгт); (б) seed хийгдээгүй — `check` «`iam.user` хоосон» гэж хэлнэ → `pnpm db:seed`; (в) seed өөр `SEED_PASSWORD`-оор хийгдсэн → `reset` хийж дахин суулга |
| Вэб нэвтрэхэд «Серверт холбогдож чадсангүй. Сүлжээгээ шалгаад дахин оролдоно уу.» | gateway (`:4000`) асаагүй. `start` ажиллаж байгаа эсэх, `check` дээр `gateway :4000` ✓ эсэхийг шалга |
| Нэвтрэхэд `429` / «хэт олон оролдлого» | Нэвтрэлт IP тутамд минутад 10 — 1 минут хүлээ. 5 удаа буруу бол акаунт 15 минут түгжигдэнэ |
| **Windows:** `db:generate` үед `EPERM: operation not permitted, rename … query_engine-windows.dll.node` | Prisma client-уудыг зэрэг үүсгэхэд нэг engine файл дээр зөрчилддөг (антивирус/зэрэгцээ процесс). `pnpm turbo run db:generate --concurrency=1` (нэг нэгээр) — скрипт үүнийг өөрөө ингэж ажиллуулдаг. Дахин гарвал `pnpm dev`/өөр терминал, VS Code-ийн TS server, антивирусыг түр хаагаад давт. **Анхаар:** generate унасан бол migration/seed хийгдээгүй байж болно — дээрх «Нэвтэрч чадсангүй» мөрийг үз |
| Вэбийн хуудас анх нээхэд 10–20 сек хоосон/удаан | `next dev` хуудас бүрийг анхны хандалтад compile хийдэг — хэвийн |
| `/customer` (404), `/los/loan-application/blacklist`, `/los/loan/list` (хоосон), `/settings` (админ биш бол «Эрх хүрэхгүй») | Эдгээр дэлгэц хараахан хийгдээгүй (§9) — алдаа биш. `/settings` нь M13-аар бэлэн (§6.1) |
| Дахин эхнээс нь эхлэх | `node scripts/local-setup.mjs reset` (өгөгдөл устна) → `node scripts/local-setup.mjs` |

Лог: `pnpm dev` ажиллаж буй терминалд бүх сервисийн JSON лог (`@los/origination:dev: …`) гарна. Docker: `docker compose logs postgres`.

## 9. Мэдэгдэж буй хязгаарлалт (үнэнээр нь)

* **Дэлгэц бүрэн биш.** Цэсэнд байгаа **Харилцагч** (`/customer` — 404; зөвхөн `/customer/<id>` маршрут байгаа ч хуудас нь хоосон), **Хар жагсаалт**, **Зээл** (`/los/loan/list`) нь одоогоор **хоосон placeholder** (`return null`); **Тохиргоо** (`/settings`) M13-аар бэлэн (§6.1). **Хүсэлт** (Модуль 2, PR #18) бодит: жагсаалт, «Шинэ хүсэлт» үүсгэх, 12 алхамтай хуудас, «Илгээх». Алхмуудаас зөвхөн `client`, `collateral`, `score`, `document` агуулгатай — бусад нь «Энэ алхам хараахан бэлэн болоогүй байна». Тиймээс хүсэлтийг үүсгэж болох ч зээл олгох хүртэл бүтэн дамжуулж болохгүй. Setup нэмэлтээр нэг туршилтын хүсэлт (`DEMO-COL-0001`, id `00000000-0000-4000-8000-000000000402`; харилцагч, барьцааны алхмууд бөглөгдсөн) нэмдэг.
* **Backend нь UI-аас түрүүлсэн.** Харилцагч + ХУР/KYC, барьцаа/үнэлгээ, баримт, Sosco/тооцоолол, e-sign, maker-checker, мерчант POS, ERP синк зэрэг нь API болон тестээр бэлэн (§6, §7), харин үүнийг холбосон дэлгэц (харилцагчийн хуудас, зээлдэгч/орлого/зээлийн нөхцөл, батлах урсгал, гэрээ, олголт) дутуу. Хүсэлт үүссэн ч зээл олгогдохгүй тул тайлан/самбар хоосон хэвээр.
* **`minio/minio` image Docker Hub-аас устсан** (`hub.docker.com/v2/repositories/minio/` жагсаалтад `minio`, `mc` байхгүй; `docker pull` → `repository does not exist`, 2026-11-02). Иймээс `docker-compose.yml`-ийн `minio`, `minio-init` үйлчилгээ одоо ажиллахгүй; локал горимд `STORAGE_DRIVER=memory`. Байнгын файл хадгалалт хэрэгтэй бол өөр S3-тохирох image (жишээ нь `quay.io/minio/minio` — энд татаж шалгаагүй) сонгож compose-ийг засах ёстой — энэ нь тусдаа шийдвэр.
* **`.env.example`-ийн ERP_* хоосон мөр** origination-ийг эхлүүлэхгүй (§4.3). Скрипт тойрдог; үндсэн засвар = тэр гурван мөрийг `.env.example`-д тайлбар болгох.
* **README-ийн нэг мөрт заавар** (`pnpm db:generate && db:migrate && db:seed`) нийтлэг сангуудыг build хийхгүй тул цэвэр clone дээр seed унана — `node scripts/local-setup.mjs` үүнийг зөв дарааллаар хийдэг. (README одоо зөв дарааллаар засагдсан.)
* **Mock-ууд:** ХУР, ЗМС, FICO, НДШ, банк, QPay, SMS, e-sign (Tridum/Monpass), Core, ERP — бүгд deterministic mock; `INTEGRATION_MODE=mock`. OCR (`dms` `/api/ocr`) нь `tesseract`, `pdftoppm`-ийг PATH-д шаардана (суулгаагүй бол зөвхөн OCR ажиллахгүй).
* `dwh-sync` одоогоор зөвхөн health өгдөг (event → DWH хэрэгжээгүй). DWH Postgres (5433) асаж, схем нь үүснэ.
* **Windows native (PowerShell, WSL-гүй)** болон **macOS** дээр скриптийг би (Linux-д) бүтнээр нь шалгаагүй. Windows-ийн тухай мэдэгдэж буй зүйл: `pnpm` нь `pnpm.cmd` тул скрипт `pnpm`-ийг shell-ээр дууддаг (`docker`-ийг шууд); Prisma generate зэрэг ажиллахад `EPERM` гардаг (§8) тул нэг нэгээр нь ажиллуулдаг. Эзний Windows (Node 24, pnpm 9.15) дээр үүнийг дараа нь баталгаажуулна.
