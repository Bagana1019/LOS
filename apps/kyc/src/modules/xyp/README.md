# xyp (kyc)

ХУР-аас иргэн/байгууллагын үндсэн мэдээлэл (**FR-2.2**, Модуль 1), регистрийн хөрөнгө (**FR-6.3**) ба өмчлөх эрхийн дугаараар өмчлөгчид (**FR-6.5**, Модуль 6). Лавлагааны бусад төрөл Модуль 3-т энд нэмэгдэнэ.

| Endpoint | Эрх | Тайлбар |
| --- | --- | --- |
| `POST /api/xyp/citizen/otp` `{registerNo}` | `customer:write` | Иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ (WS100008) → `{sent: true, requestedAt}`. Утасны дугаар хүлээн авахгүй (400). 404 `XYP_NOT_FOUND`, 422 `XYP_OTP_NOT_SENT` (ХУР 1005 / 1006: код илгээж чадсангүй, утас иргэний нэр дээр бүртгэлгүй), 503 `XYP_UNAVAILABLE` |
| `POST /api/xyp/citizen` `{registerNo, otp}` | `customer:write` | 2-р алхам: иргэний утсанд ирсэн кодоор (WS100101 `auth.citizen.otp`) → `XypCitizen` (`@los/contracts`). 404 `XYP_NOT_FOUND`, 422 `XYP_OTP_INVALID` (код буруу / хугацаа дууссан / ХУР татгалзсан), 503 `XYP_UNAVAILABLE`, 501 `INTEGRATION_NOT_IMPLEMENTED` (real горим) |
| `POST /api/xyp/assets` `{registerNo}` | `customer:read` | → `XypAssetsResponse` (үл хөдлөх + тээврийн хэрэгсэл). Нэмэлт алдаа: 400 `INVALID_REGISTER_NO` |
| `POST /api/xyp/property` `{propertyId}` | `customer:read` | → `XypPropertyAsset` бүх өмчлөгчтэй нь. Олдохгүй бол 404 `XYP_NOT_FOUND` |

Дуудагч нь origination (`/api/customers/xyp-fetch`, `source=XYP`; барьцааны модуль); `web` шууд дуудахгүй (CLAUDE.md §3.2.1).
`integrations/xyp/`: `XypClient` interface, `MockXypClient` (deterministic fixture — `xyp.fixture.ts` иргэн/байгууллага, `xyp-assets.fixture.ts` хөрөнгө), `RealXypClient` (SOAP; иргэний үндсэн мэдээлэл + иргэний код). Mock горимд demo код `MOCK_XYP_OTP` = `123456`.
Mock fixture: регистрээс тогтвортой хариу; `…00000000` → олдохгүй, `…99999999` → ХУР унасан. Хөрөнгийн fixture-ийн хүснэгт: `apps/kyc/README.md`.
Регистр, өмчлөгчийн нэр, өмчлөх эрхийн дугаарыг лог-д бичихгүй, хадгалахгүй.
