# maker-checker

Maker-Checker ("4 нүдний зарчим"): нэг хэрэглэгчийн санал болгосон өөрчлөлт/шийдвэр өөр (ахлах) хэрэглэгч батлах хүртэл хүчин төгөлдөр болохгүй; аудитын түүхтэй.

Шаардлага: `docs/05-maker-checker.md` (MC-FR-*, MC-BR-*). Бусад модуль handler бүртгэж `MakerCheckerService.submit()` дууддаг — §8.

- `maker-checker.service.ts` — цөм (submit / approve / reject / cancel / expire / list)
- `maker-checker.domain.ts` — цэвэр дүрэм (self-approval, дүр, салбар, policy)
- `change-handler.ts` — домэйн модулийн гэрээ + registry
- `change-request.store.ts` — persistence port; `infra/` Prisma хэрэгжүүлэлт; `testing/` санах ойн хэрэгжүүлэлт
- `handlers/policy-change.handler.ts` — policy өөрчлөх (өөрөө 4 нүдтэй)
- DB хамгаалалт: `prisma/migrations/20261029000000_maker_checker/migration.sql`
