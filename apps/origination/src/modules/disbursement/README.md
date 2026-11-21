# disbursement

Модуль 11 · FR-12 олголтын хүсэлт, BR-10, **G4** (илгээх), **G5** (зөвшөөрөх). Хүсэлтийн төлөв солих бүгд `ApplicationStateMachine.apply()`-аар.

```
APPROVED ──PUT (данс, дүн, огноо; банкны нэр-дугаар тулгалт)──► disbursement_request DRAFT
   │ POST submit (ЗЭЗ, G4)                      checks: гарын үсэгтэй гэрээ, шийдвэр, албан бичиг, данс+тулгалт ✔, шийдвэр=олголт, ЭБ-д барьцаа
   ▼ (хүсэлт → DISBURSING, олголт SUBMITTED)
 POST approve (батлагч, G5; өөрийн илгээснийг өөрөө батлахгүй)
   │ 1) олголт APPROVED (CAS)  2) CoreLoanPort.openLoan (tx-ээс гадуур, idempotencyKey=`<id>:<илгээсэн дугаар>`, H1 lease)
   │    ├ тодорхой алдаа → FAILED; тодорхойгүй (timeout) → APPROVED + lease, reconcile/sweeper (settle дүрэм)
   │    └ амжилт → олголт SENT_TO_CORE + core_loan_id, хүсэлт ACTIVE, DisbursementApproved event, ERP DISBURSEMENT (нэг tx)
 POST reject (тайлбар заавал) ► олголт DRAFT, хүсэлт APPROVED
```
| Route (`/api/applications/:id/disbursement`) | Эрх |
| --- | --- |
| `GET` (карт: нөхцөл, тулгалт, `checks[]`, `canSubmit`, түүх) | `application:read` |
| `PUT`, `POST submit` | `disbursement:request` (ЗЭЗ, өөрийн хүсэлт) |
| `POST approve`, `POST reject` | `disbursement:approve` (Батлагч) |

- BR-10: олгох дүн > батлагдсан → 400 `DISBURSE_EXCEEDS_APPROVED`. Шийдвэр vs олголтын нөхцөл (дүн, хугацаа, хүү, арга, эхний төлбөр) зөрвөл `RECONCILIATION` шалгалт унана.
- Дансны дугаар `@los/database` encryptedField (AAD `disbursement.account_no`); хариунд зөвхөн нуугдмал, аудитад бүтэн дугаар орохгүй.
- Банк: `BANK_GATEWAY` (`nameCheck`, INTEGRATION_MODE_BANK_TRANSFER). Core: `integrations/core-loan` (`MockCoreLoanPort` deterministic `CL-…`; данс `0000`-оор төгссөн бол татгалзана; `RealCoreLoanPort` fail-closed — Core API баримт хүлээгдэж байна).
- H1: Core үр дүн тодорхойгүй (timeout/5xx, унасан lease) бол lease хадгалагдаж `core_unknown_at` тэмдэглэгдэнэ; "Core-д олдсонгүй" нь settle цонх (`DISBURSEMENT_CORE_SETTLE_SECONDS`, 900с) + 2 зайтай лавлагааны дараа л баталгаатай (`isNotFoundDefinitive`). Өмнө нь reconcile/reject → 409 `DISBURSEMENT_CORE_SETTLING`.
- F5-12 мэдэгдэл (хонх, `NotificationService.notifyUsers(…, tx)` — төлвийн өөрчлөлттэй НЭГ транзакцид; алдвал бүгд буцна): `submit` → `DISBURSEMENT_SUBMITTED` батлагчдад (илгээгчээс бусад); `reject` → `DISBURSEMENT_REJECTED` олголтыг сүүлд илгээсэн хүнд (түүхийн сүүлийн `SUBMITTED`, хүсэлтийн ЗЭЗ биш) батлагчийн тайлбартай, өөрөө буцаавал өөрт нь үгүй. **Хязгаар:** origination-д iam дүрийн лавлах байхгүй (DECISIONS 2026-11-03, `approval.notifyLevel`-тэй ижил) тул "батлагч" = хүсэлтэд хамаарах түвшний (BR-13) `userId` гишүүд + энэ хүсэлтэд санал өгсөн хүмүүс; дүрээр (`APPROVER`) томилогдсон, санал өгөөгүй хүнд мэдэгдэл очихгүй — тэд олголтыг хүсэлтийн "Олгох" табаас олно. Бүрэн шийдэл: iam хэрэглэгчийн projection.
- Тест: `disbursement.rules.test.ts` (нэгж), `disbursement.e2e.test.ts` (DB; F5-12 мэдэгдлийн 9 тест).
