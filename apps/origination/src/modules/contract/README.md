# contract

Гэрээний мета (`origination.contract`) ба **FR-11.4 цахим гарын үсэг (цаасгүй гэрээ)**-ний origination тал.
Гэрээ үүсгэх (generated_file_id) ба цаасан гарын үсгийн скан (signed_file_id) нь Module 9/11-ийн ажил — энэ модуль тэдгээрийг уншина.

## Урсгал
```
Ажилтан ─► gateway ─► POST /api/origination/contracts/:applicationId/esign
                         │ ContractSigningService.start: өгөгдлийн хүрээ (NFR-3) → урьдчилсан нөхцөл → dms
                         ▼  POST {DMS_URL}/api/esign/requests (InternalHttpClient: X-User-Id, X-Roles, X-Org-Id, X-Correlation-Id)
           contract.sign_channel=ESIGN, signing_request_id, signing_status=PENDING
                         │ SigningLinkNotifier.sendLink → зээлдэгчийн утсанд SMS (signingUrl ажилтанд БУЦАХГҮЙ)
dms ── ContractSigned / ContractSigningFailed ──► Redis stream ──► ContractEventsSubscriber (idempotentHandler) ──► ContractSigningEventHandler
           contract.signed_file_id, signed_at, signing_status   ← **G4 олголтын хаалга signed_file_id-аар шалгана**
```

## Route-ууд (gateway: `/api/origination/…`; сервис дээр `/api/…`)
| Route | Эрх | Үүрэг |
| --- | --- | --- |
| `POST /contracts/:applicationId/esign` | `application:write` | Хүсэлт үүсгэж SMS илгээнэ. Body (заавал биш): `{preferredProvider?, ttlHours?}`. Идэвхтэй хүсэлт байвал 409 (dms хэрэгжүүлнэ) |
| `POST …/esign/resend` | `application:write` | Токен шинэчилж (хуучин линк үхнэ) дахин SMS |
| `POST …/esign/cancel` | `application:write` | Идэвхтэй хүсэлтийг цуцална |
| `GET  …/esign` | `application:read` | Төлөв (dms-ээс) |

Хариу = `SigningRequestView` − `signingUrl` (`StaffSigningRequestView`, schema-аар strip хийнэ).

## Эрх ба хүрээ (NFR-3)
Эрхийг `@Permissions` (`@los/contracts` `ROLE_PERMISSIONS`): бичих үйлдэл зөвхөн ЗЭЗ (`application:write`); төлөв харах ЗЭЗ/Салбарын захирал/Батлагч/Админ.
Хүрээг service `assertInScope`-оор шалгана: ЗЭЗ = `officer_id` өөрийнх, Салбарын захирал = өөрийн салбар, Батлагч/Админ = бүгд; **өөр байгууллагын** хүсэлт 404.
(Өмнөх ноорогт Салбарын захирал/Админ мөн start хийж болдог байсан — Модуль 0-ийн RBAC-д `application:write` зөвхөн ЗЭЗ тул нийцүүлсэн.)

## Урьдчилсан нөхцөл (start)
Хүсэлтийн төлөв `APPROVED | DISBURSING` · `contract` мөр + `generated_file_id` байх (409 "Гэрээ үүсээгүй байна") · аль хэдийн SIGNED биш · гэрээний дугаар, байгууллага хүсэлттэй таарах · үндсэн зээлдэгч (`is_primary`) + зөв утас.

## Port-ууд (explicit DI token)
| Token | Үндсэн adapter | Тэмдэглэл |
| --- | --- | --- |
| `APPLICATION_SIGNING_LOOKUP` | `PrismaApplicationSigningLookup` | `loan_application` + үндсэн зээлдэгчийн `customer`. Регистрийг `customer.register_no` AAD-ээр (болохгүй бол AAD-гүй) тайлна, утас шифрлэгдсэн бол тайлна. Тест: `InMemoryApplicationSigningLookup` |
| `SIGNING_LINK_NOTIFIER` | `MockSigningLinkNotifier` (dev) / `UnconfiguredSigningLinkNotifier` (production, `INTEGRATION_MODE=real`) | Бодит SMS adapter notification модулийнх (**TODO(M13)**). Mock нь зөвхөн `{applicationId, phoneMasked}` логлоно |
| `ESIGN_GATEWAY` | `HttpDmsEsignGateway` (`InternalHttpClient`, `DMS_URL`, timeout 3с, redirect дагахгүй) | 404→404, 409→409, бусад 4xx→502 (dms-ийн мессеж дамжихгүй), 5xx/timeout→502/504. Тест: `FakeEsignGateway` |
| `CONTRACT_REPOSITORY` | `PrismaContractRepository` | Тест: `MemoryContractRepository`. `updateSigning` нь атомар CAS (SIGNED мөрийг хэзээ ч өөрчлөхгүй) + өөрчлөлт бүр `audit_log` (`CONTRACT_SIGNING_UPDATED`) нэг транзакцид |
| `EVENT_BUS` | `EventsModule` (`@los/nest-common`); Redis-гүй/`OUTBOX_RELAY=off` үед `null` | `null` бол subscriber чимээгүй алгасна (анхааруулга) |
| `Clock` | `@los/nest-common` `Clock` | |

## Event (consumer group `origination`)
`ContractSigned` → `signed_file_id`, `signed_at`, `SIGNED`, `ESIGN`. `ContractSigningFailed` → `DECLINED | EXPIRED | CANCELLED` (шууд) эсвэл `FAILED`
(`IDENTITY_MISMATCH | INTEGRITY_ERROR | PROVIDER_ERROR`) + `signing_failure_reason`. `ContractSigningRequested` үл тоомсорлоно.
`processed_events(origination, eventId)` (`idempotentHandler`) + handler-ийн CAS: өөр `signingRequestId`-тай (stale) event хаяна · SIGNED-ийг бууруулахгүй · давтан хүргэлт no-op.

## DB
`20261028110000_contract_esign` (incremental): `sign_channel` (PAPER|ESIGN), `signing_request_id`, `signing_status`, `signing_failure_reason`, `signing_sent_at` + CHECK constraint-ууд
(enum утгууд, `SIGNED ⇒ signed_file_id IS NOT NULL`). Baseline `20261028000000_init`-д хүрээгүй.

## Тест
`pnpm --filter @los/origination test` — нэгж (service, handler, subscriber, gateway клиент, controller). DB-тэй (`prisma-contract.repository`, `prisma-application-signing-lookup`, `test/contract-esign.e2e.test.ts`)
нь `TEST_DATABASE_URL` (нэр нь `test`-ээр төгссөн) байхгүй бол алгасагдана.
