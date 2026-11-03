# schedule

FR-7 ЭТХ (эргэн төлөлтийн хуваарь). Тооцоо: `@los/calc` `schedule.ts` (`buildSchedule`, 100% coverage). Нөхцөл (дүн, хүү, хугацаа) нь Модуль 5-ын хадгалсан утгаас.

| Endpoint (`/api/applications/:id/schedule`) | Эрх | Үүрэг |
| --- | --- | --- |
| `GET` | `application:read` | Одоогийн ЭТХ (`schedule=null` бол үүсгээгүй), `isStale` |
| `POST /preview` | `application:read` | Хадгалахгүй урьдчилж харах |
| `POST` | `application:write` | "ЭТХ үүсгэх" `{startDate, firstPaymentDate, type, graceMonths}` — өмнөхийг хуучирсан болгож, `installment` алхмыг COMPLETED, `score`-г STALE болгоно |
| `GET /export` | `application:read` | Excel (төлбөр бүр нэг мөр); хуучирсан бол 409 `SCHEDULE_STALE` |

Төрөл: ANNUITY, EQUAL_PRINCIPAL, QUARTERLY, BULLET; хоногийн суурь `setting schedule.day_count`. Шийдвэр: `docs/DECISIONS.md` (2026-11-03). `seq 0` = олголтын мөр.
