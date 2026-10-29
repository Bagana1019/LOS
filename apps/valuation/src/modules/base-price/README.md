# base-price

Суурь үнийн сан (FR-14.1, FR-14.5): хөрөнгийн төрөл + түлхүүр бүрт хувилбарт нэгж үнэ. Админ `POST /api/base-prices`, `POST /api/base-prices/import`
(`settings:manage`); унших `GET /api/base-prices` (`application:read`). `BasePriceLookupService` нь санал бодоход ашиглагдана (үүсгэхгүй, зөвхөн уншина).
Түлхүүрийн хэвийн болголт `base-price.keys.ts`. Дэлгэрэнгүй: `apps/valuation/README.md` "Суурь үнэ".
