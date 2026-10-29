# blacklist

Хар жагсаалт — **FR-13.1**, **BR-9** (бүх шалтгаанд зөвхөн анхааруулга; хориг байхгүй, батлагч шийднэ).

Модуль 1-д орсон (хайлт/шалгалт):
* `BlacklistLookupService` — `blacklist.register_no_hash` (blind index)-ээр идэвхтэй бичлэгийг `BlacklistWarning[]` болгоно. `CustomerModule` ашиглана.
* `GET /api/blacklist/check?registerNo=` (`blacklist:read`) — маягтад регистр бичих үед автомат шалгалт.

Модуль 13-д нэмэх: CRUD, CSV импорт (`blacklist:manage`; gateway `route-policy.ts` аль хэдийн хаасан). Бичлэг үүсгэхдээ
`registerNoHash = blindIndex(normalizeRegisterNo(registerNo))`, `registerNoEncrypted = encryptedField(normalizeRegisterNo(registerNo))` (AAD-гүй).
