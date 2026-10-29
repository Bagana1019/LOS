# LOS Radix

Зээлийн хүсэлтийн систем (Loan Origination System) — Монголын ББСБ-д зориулав.
Шаардлага: `docs/`. Claude Code-ийн заавар: `CLAUDE.md`. Бүтээх дараалал: `docs/04-build-plan.md`. Суурийг ашиглах гарын авлага: `docs/00-foundation.md`.

Ажиллуулах (Модуль 0 бэлэн):
```
cp .env.example .env && docker compose up -d && pnpm install
pnpm db:generate && pnpm db:migrate && pnpm db:seed && pnpm dev
```
Тест: `TEST_DATABASE_URL=… REDIS_URL=… pnpm test` (дэлгэрэнгүй `docs/00-foundation.md` §4).

Claude Code-оор эхлэх:
```
claude
> docs/-ыг бүхэлд нь уншаад CLAUDE.md-ийн дүрмээр docs/04-build-plan.md-ийн Модуль 0-ийг хий. Дуусаад тест ажиллуулж AC-г шалгаад тайлагна; Модуль 1 рүү орох хэрэггүй.
```
