# xyp (kyc)

ХУР-аас иргэн/байгууллагын үндсэн мэдээлэл татах — **FR-2.2** (Модуль 1). Лавлагааны бусад 7 төрөл Модуль 3-т энд нэмэгдэнэ.

| Endpoint | Эрх | Тайлбар |
| --- | --- | --- |
| `POST /api/xyp/citizen` `{registerNo}` | `customer:write` | → `XypCitizen` (`@los/contracts`). 404 `XYP_NOT_FOUND`, 503 `XYP_UNAVAILABLE`, 501 `INTEGRATION_NOT_IMPLEMENTED` (real горим) |

Дуудагч нь origination (`/api/customers/xyp-fetch`, `source=XYP`); `web` шууд дуудахгүй (CLAUDE.md §3.2.1).
`integrations/xyp/`: `XypClient` interface, `MockXypClient` (deterministic fixture — `xyp.fixture.ts`), `RealXypClient` (TODO(human)).
Mock fixture: регистрээс тогтвортой хариу; `…00000000` → олдохгүй, `…99999999` → ХУР унасан.
