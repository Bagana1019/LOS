# borrower — хамтран зээлдэгч ба батлан даагч

Хүсэлтийн оролцогчид: үндсэн зээлдэгч (`PRIMARY`), хамтран зээлдэгч (`CO_BORROWER`), батлан даагч (`GUARANTOR`), барьцаалагч (`PLEDGOR`).
Шаардлага: FR-2.1, FR-2.3, FR-6.5, FR-10.4, BR-9, NFR-3/4/5, BSA-BR-9 (docs/01, docs/02, docs/03 `loan_application_borrower`).

## Файлууд
| Файл | Үүрэг |
| --- | --- |
| `borrower.controller.ts` | REST (`/api/applications/:applicationId/borrowers…`), эрх, zod оролт |
| `borrower.service.ts` | Мутаци бүр нэг транзакцид: хүсэлтийн мөрийг `FOR UPDATE`-ээр түгжих → дүрэм → бичих → алхам → `BorrowersChanged` outbox |
| `borrower.rules.ts` | **Цэвэр** бизнес дүрэм (role-хослол, лимит, хувь, баталгаа, анхааруулга, алхмын матриц) — unit тест |
| `borrower.mapper.ts` | Prisma → `BorrowerView` / `BorrowerRow` / `BorrowerCandidate` (регистр нуугдмал) |
| `customer-directory.ts` | Харилцагч унших, регистрийг blind index-ээр хайх/задлах/нуух |
| `blacklist-checker.ts` | Хар жагсаалтын тулгалт (BR-9: зөвхөн анхааруулга). Регистрийг том/жижиг үсэг, бүх хоосон зайгаас үл хамааран тулгана (DB: цифрээр урьдчилан шүүх → JS: нормчилж яг тулгах) |

## API
| Method path | Эрх | Хариу |
| --- | --- | --- |
| `GET applications/:id/borrowers` | OFFICER (өөрийн) / BRANCH_MANAGER (салбар) / APPROVER / ADMIN | `BorrowerListResponse` |
| `GET applications/:id/borrowers/candidates?registerNo=` | OFFICER (өөрийн) / ADMIN | `BorrowerCandidate[]` |
| `POST applications/:id/borrowers` | OFFICER (өөрийн) / ADMIN | 201 `BorrowerMutationResponse` |
| `PATCH applications/:id/borrowers/:borrowerId` | ижил | `BorrowerMutationResponse` |
| `DELETE applications/:id/borrowers/:borrowerId` | ижил | 204 |
| `POST applications/:id/borrowers/:borrowerId/make-primary` | ижил | `BorrowerMutationResponse` (шинэ үндсэн) |
| `POST applications/:id/borrowers/:borrowerId/consent` | ижил | `BorrowerMutationResponse` |

Алдааны `code`-ууд `@los/contracts`-ийн `BorrowerErrorCode`-д (409: төлөв/давхардал/хязгаар, 422: талбарын утга, 404: олдсонгүй, 400 `VALIDATION_FAILED`).

## Гол дүрмүүд
- Зөвхөн `DRAFT` / `RETURNED` хүсэлтийг засна (`APPLICATION_NOT_EDITABLE`); унших нь бүх төлөвт.
- Яг 0–1 `PRIMARY`; `isPrimary ⇔ role = PRIMARY`. Солих → `make-primary` (хуучин үндсэн CO_BORROWER болно, хувийн хуваарь хадгалагдана).
- `(applicationId, customerId, role)` давхардахгүй; нэг харилцагч зөвхөн `PLEDGOR`-оор бусад дүртэй хослоно.
- Лимит: `borrower.max_co_borrowers`, `borrower.max_guarantors` (setting); барьцаалагч хязгааргүй.
- `liabilityShare` зөвхөн CO_BORROWER; ΣCO ≤ 100%. Үндсэн зээлдэгчийн хувь = 1 − ΣCO (үлдэгдэл, хадгалагдахгүй).
- Батлан даагч/барьцаалагчийн орлого нэгтгэгдэхгүй (`incomeIncluded=true` → 422).
- Хуулийн этгээд хамтран зээлдэгч байж болохгүй.
- Анхааруулга (хориглохгүй, хадгалахгүй — GET бүрт дахин тооцно): `BLACKLISTED`, `PEP`, `RELATED_PARTY`, `CONSENT_MISSING`, `GUARANTEE_BELOW_LOAN`, `LIABILITY_SHARE_INCOMPLETE`.
- Өөрчлөлт бүр `client` / `inquiry` / `income` / `score` алхмыг шинэчилнэ (LOCKED-ийг хөндөхгүй), `BorrowersChanged` event outbox-д.

## Тест
`pnpm exec vitest run src/modules/borrower` (DB-тэй тестэд `TEST_DATABASE_URL`, `REDIS_URL` хэрэгтэй).
