# disbursement

Модуль 11 · FR-12 олголтын хүсэлт, BR-10, **G4** (илгээх), **G5** (зөвшөөрөх). Хүсэлтийн төлөв солих бүгд `ApplicationStateMachine.apply()`-аар.

```
APPROVED ──PUT (данс, дүн, огноо; банкны нэр-дугаар тулгалт)──► disbursement_request DRAFT
   │ POST submit (ЗЭЗ, G4)                      checks: гарын үсэгтэй гэрээ, шийдвэр, албан бичиг, данс+тулгалт ✔, шийдвэр=олголт, ЭБ-д барьцаа
   ▼ (хүсэлт → DISBURSING, олголт SUBMITTED)
 POST approve (батлагч, G5; өөрийн илгээснийг өөрөө батлахгүй)
   │ 1) олголт APPROVED (CAS)  2) CoreLoanPort.openLoan (tx-ээс гадуур, idempotencyKey=disbursement_request.id)
   │    ├ алдаа → олголт FAILED, хүсэлт DISBURSING хэвээр, дахин approve эсвэл reject
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
- Тест: `disbursement.rules.test.ts` (нэгж), `disbursement.e2e.test.ts` (DB).
