# haircut

Барьцааны haircut дүрэм (FR-14.2): `(productId | бүх бүтээгдэхүүн, assetType) → haircutRate`. `GET/PUT/DELETE /api/haircuts` (унших `application:read`, өөрчлөх `settings:manage`).
`HaircutLookupService.findRates` нь `PRODUCT_RULE` / `ORG_RULE`-ийг санал бодоход өгнө; `PRODUCT_JSON` ба `DEMO_DEFAULT`-тэй хамт шийдвэрийн дараалал нь
`@los/calc` `resolveHaircut`. Дэлгэрэнгүй: `apps/valuation/README.md` "Haircut ба шийдвэрийн дүрэм".
