# income — орлого (wizard-ийн 3-р алхам, FR-4, Модуль 4, BSA-гүй хувилбар)

Цалин (НДШ-ээс эсвэл гараар), гар орлого (түрээс/тэтгэвэр/бусад), өрхийн/бизнесийн зардал, хугацаа сонгож сарын дундаж. Шийдвэрүүд: `docs/DECISIONS.md` (2026-11-03 Модуль 4).

| Method path | Эрх | Үүрэг |
| --- | --- | --- |
| `GET applications/:id/income` | OFFICER (өөрийн) / BRANCH_MANAGER / APPROVER / ADMIN | Оролцогч (PRIMARY, CO_BORROWER) бүрийн цалин, гар орлого, дүн, `blockers`, `step` |
| `POST …/income/ndsh/fetch` `{customerId}` | OFFICER (өөрийн) / ADMIN | kyc НДШ → `income_salary` (`NDSH` мөрийг солино) |
| `POST …/income/salaries`, `DELETE …/salaries/:id` | ижил | Гар цалин (`MANUAL`); НДШ мөрийг устгахгүй |
| `POST …/income/calculate` `{customerId, periodFrom, periodTo}` (`YYYY-MM`) | ижил | Тооцоолох → `income_summary.avg_salary_monthly` |
| `POST …/income/manual`, `DELETE …/manual/:id` | ижил | Гар орлого (FR-4.3) |
| `PUT …/income/expenses/:customerId` | ижил | Өрхийн/бизнесийн зардал (FR-4.4) |
| `POST …/income/refresh` | ижил | `income` алхмыг дахин тооцно (оролцогч өөрчлөгдөж STALE болсон үед) |

- Дундаж = нийлбэр ÷ хугацааны сарын тоо (цалингүй сар 0); `@los/calc` `averageMonthlySalary`.
- `income` алхам COMPLETED ⇔ нэгтгэгдэх оролцогч бүрд орлого (цалингийн дундаж > 0 | гар орлого | BSA ЦМУ). Үгүй бол PENDING + `INCOME_MISSING` / `NO_PRIMARY_BORROWER` (FR-8.6). Өөрчлөлт бүр COMPLETED `score`-ийг STALE (`INCOME_CHANGED`).
- Бизнесийн орлого (FR-4.2): BSA (Модуль 12) ирэх хүртэл `business.available=false` placeholder.
- Тест: `pnpm exec vitest run src/modules/income`.
