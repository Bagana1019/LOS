# DECISIONS.md — Claude Code-ийн таамаг, шийдвэрүүд

Шаардлагад тодорхойгүй зүйл дээр авсан таамаг бүрийг энд огноотой бич. Хэрэглэгч хянаж зөвшөөрнө эсвэл засна.

| Огноо | Модуль | Таамаг / шийдвэр | Шалтгаан |
| --- | --- | --- | --- |
| | | | |
| 2026-10-28 | portal-bff | Харилцагчийн өөртөө үйлчлэх API-г `gateway`-д биш тусдаа `apps/portal-bff` (4007) болгосон | Ажилтны RBAC/салбарын загвараас өөр итгэлийн хил, өөр токен (iss/aud/нууц тусдаа), тусдаа масштаб. Дэлгэрэнгүй: `docs/05-portal-bff.md` §2 |
| 2026-10-28 | portal-bff | portal-bff өөрийн Postgres schema-гүй; OTP, session, rate-limit, idempotency төлөв зөвхөн Redis (TTL)-д | Бизнесийн өгөгдөл эзэмшихгүй, богино настай нууцлалын төлөв. Бизнесийн өгөгдөл §4-ийн хуваарилалтад өөрчлөлтгүй |
| 2026-10-28 | portal-bff | Downstream зөвхөн `origination` (`/api/internal/portal/*`), `X-Actor-Type: CUSTOMER` + `X-Customer-Id`; харилцагчийн JWT дамжуулахгүй | CLAUDE.md §3.2-2, 3.2-9. dms/kyc-г шууд дуудахгүй — гэрээний PDF-г origination дамжуулна |
| 2026-10-28 | portal-bff | Origination талын `/api/internal/portal/*` endpoint-ууд энэ PR-д ороогүй; portal-bff нь port/adapter + `MockXxx` (stateful ledger) + `RealXxx`; хэрэгжүүлэх гэрээ `docs/05-portal-bff.md` §6 ба `FakeOrigination` | Origination-д одоогоор хүснэгт/модуль байхгүй (Модуль 0, 7, 10–11 хүлээгдэж байна); CLAUDE.md §3.2-7 |
| 2026-10-28 | portal-bff | Нэвтрэлт: регистр + бүртгэлтэй утас → SMS OTP (6 орон, 5 мин, 5 оролдлого); access JWT 10 мин, refresh 30 хоног (rotation + reuse detection, session дээд нас 90 хоног) | ДАН/PIN/биометр дараагийн алхам. Тоонууд env-ээр тохируулагдана (`PORTAL_*`) |
| 2026-10-28 | portal-bff | Төлбөрийн төрөл INSTALLMENT/OVERDUE/PAYOFF/CUSTOM-д дүнг **сервер** тодорхойлно; CUSTOM ≤ бүрэн хаах дүн; `Idempotency-Key` заавал, (харилцагч, түлхүүр)-ээр 24ц | Давхар болон хуурамч дүнтэй төлбөрөөс сэргийлэх. Method-ийн доод/дээд хязгаар origination-оос (`setting`) |
| 2026-10-28 | portal-bff | Төлбөрийн провайдерын webhook portal-bff-д биш origination `integrations/payment/`-д төгсөнө; portal-bff зөвхөн эхлүүлж, төлөв асууна (polling) | Core-д тусгал, event outbox нь origination-ийн үүрэг. Төлбөр тооцооны thread-тэй зөрчилдөхгүй байх |
| 2026-10-28 | portal-bff | Mock горимд торгуулийг загварчлаагүй (`penalty=0`), хэсэгчилсэн төлөлт хугацаа хэтэрсэн хэсгээс хүү→үндсэн дарааллаар | Торгуулийн томьёо docs-д тодорхойгүй (FR-7.x-д зөвхөн ЭТХ). Бодит дүрмийг Core/origination тодорхойлно |
| 2026-10-28 | portal-bff | Аудит одоогоор `audit:true` JSON лог (`AUDIT_SINK` порт); хадгалалтыг origination `audit_log` дотоод API-аар хийхээр орхисон | `audit_log` хүснэгт §4-ийн дагуу origination-д; PII бичихгүй (§6-5) |
