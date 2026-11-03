# LOS Radix

Зээлийн хүсэлтийн систем (Loan Origination System) — Монголын ББСБ-д зориулав.
Шаардлага: `docs/`. Claude Code-ийн заавар: `CLAUDE.md`. Бүтээх дараалал: `docs/04-build-plan.md`. Суурийг ашиглах гарын авлага: `docs/00-foundation.md`.

**Локал дээр суулгаж туршихад: [`docs/LOCAL-SETUP.md`](docs/LOCAL-SETUP.md)** (Монгол гарын авлага) — нэг командаар `node scripts/local-setup.mjs` (Docker хэрэгтэй), эсвэл Docker-гүй мерчант POS демо `node scripts/local-setup.mjs demo`.

Гараар ажиллуулах (дэлгэрэнгүй, мэдэгдэж буй 2 засвартай нь `docs/LOCAL-SETUP.md` §4.2–4.3):
```
cp .env.example .env     # + ERP_API_URL/ERP_WEBHOOK_SECRET/ERP_API_TOKEN хоосон мөрийг `# `-ээр тайлбар болго
docker compose up -d postgres dwh redis && pnpm install
pnpm turbo run db:generate --concurrency=1 && pnpm turbo run build --filter='./packages/*'   # seed-д @los/database-ийн dist хэрэгтэй
pnpm db:migrate && pnpm db:seed && pnpm dev
```
Тест: `TEST_DATABASE_URL=… REDIS_URL=… pnpm test` (дэлгэрэнгүй `docs/00-foundation.md` §4).

Claude Code-оор эхлэх:
```
claude
> docs/-ыг бүхэлд нь уншаад CLAUDE.md-ийн дүрмээр docs/04-build-plan.md-ийн Модуль 0-ийг хий. Дуусаад тест ажиллуулж AC-г шалгаад тайлагна; Модуль 1 рүү орох хэрэггүй.
```
