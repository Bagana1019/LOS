# inquiry — лавлагаа (wizard-ийн 2-р алхам, FR-3, Модуль 3)

Өгөгдөл kyc-д (`kyc.inquiry`, `kyc.unregistered_loan`); энд: эрх, оролцогч, хар жагсаалтын тулгалт, хуучралт, `inquiry` алхмын төлөв, `score` алхмыг STALE болгох. Шийдвэрүүд: `docs/DECISIONS.md` (2026-11-03 Модуль 3).

| Method path | Эрх | Үүрэг |
| --- | --- | --- |
| `GET applications/:id/inquiries` | OFFICER (өөрийн) / BRANCH_MANAGER (салбар) / APPROVER / ADMIN | Оролцогч бүрт 11 эх сурвалж: `MISSING`/`FRESH`/`STALE`, анхааруулга (`NONE`/`WARNING`/`RED`), summary, detail, сарын өрийн төлбөр |
| `POST …/inquiries/fetch` `{customerId?, sources?}` | OFFICER (өөрийн) / ADMIN | kyc-ээс татна; эх сурвалж тус бүрийн алдаа `failures`-д; бүх оролцогч бүрэн бол `KycCompleted` |
| `POST …/inquiries/recheck` | ижил | Хуучралтаар алхмыг дахин тооцно |
| `POST …/inquiries/unregistered-loans`, `DELETE …/:loanId` | ижил | FR-3.2 |

- Зөвхөн `DRAFT`/`RETURNED` хүсэлтэд бичнэ (`APPLICATION_NOT_EDITABLE` 409); унших нь бүх төлөвт.
- Лавлагаа авах оролцогч: PRIMARY, CO_BORROWER, GUARANTOR. Алхам COMPLETED ⇔ бүгдэд 11 лавлагаа байх ба хуучраагүй (`inquiry.stale_days`).
- kyc дуудлага DB-ийн транзакцаас ГАДНА; алхам+аудит нэг транзакцид (`FOR UPDATE`). Регистр зөвхөн kyc руу; аудит/логт орохгүй.
- `ports/kyc-inquiry.port.ts` (`KYC_INQUIRY_PORT`) — тестэд `FakeKycInquiryPort`. Score-ийн `KycCreditHistory` (real горим) мөн энэ портоор kyc-ийн хураангуйг уншина.
- Тест: `pnpm exec vitest run src/modules/inquiry` (DB-тэй тестэд `TEST_DATABASE_URL`, `REDIS_URL`).
