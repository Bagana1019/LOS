// Модуль 0 + Модуль 6 seed өгөгдөл (docs/04, docs/05 §9): haircut_rule (FR-14.2) ба суурь үнийн сан base_price (FR-14.1, FR-14.5).
// DEMO: доорх бүх үнэ БОДИТ ЗАХ ЗЭЭЛИЙН ӨГӨГДӨЛ БИШ — бизнес баталгаажуулах хүртэл дүрслэх зориулалттай тоо (docs/DECISIONS.md M6).
// Бодит үнийг админ `POST /base-prices` эсвэл `POST /base-prices/import`-оор оруулна (шинэ хувилбар болж, эдгээр хэвээр түүхэнд үлдэнэ).
import type { PrismaClient } from '.prisma/client-valuation';

/** DEMO: суурь үнийн хүчинтэй эхлэх огноо. Нэг жилээс хуучирвал санал `BASE_PRICE_STALE` анхааруулгатай гарна. */
export const DEMO_VALID_FROM = '2026-01-01';

// origination.product.haircut_json-тай ижил DEMO утга (docs/04 M6 AC: 30,000,000 × 0.7 = 21,000,000)
export const DEMO_HAIRCUTS: Readonly<Record<string, number>> = { VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 };

export interface DemoBasePrice {
  assetType: 'VEHICLE' | 'APARTMENT' | 'HOUSE' | 'LAND' | 'LIVESTOCK';
  key: Record<string, string | number>;
  unitPrice: number;
}

// DEMO: Улаанбаатарын 9 дүүргийн ₮/м². Орон сууц 3–6 сая, байшин (барилга) бага, газар хамгийн бага; төвөөс алслагдах тусам буурна.
const DISTRICT_PRICES: ReadonlyArray<readonly [district: string, apartment: number, house: number, land: number]> = [
  ['Сүхбаатар', 5_800_000, 2_500_000, 3_500_000],
  ['Чингэлтэй', 5_200_000, 2_200_000, 2_600_000],
  ['Баянгол', 4_800_000, 2_100_000, 2_000_000],
  ['Хан-Уул', 5_500_000, 2_400_000, 1_800_000],
  ['Баянзүрх', 4_200_000, 1_900_000, 1_100_000],
  ['Сонгинохайрхан', 3_600_000, 1_600_000, 800_000],
  ['Налайх', 3_000_000, 1_300_000, 400_000],
  ['Багануур', 3_000_000, 1_100_000, 250_000],
  ['Багахангай', 3_000_000, 1_000_000, 200_000],
];

// DEMO: хорооны түвшний үнэ (дүүргийнхээс давуу). Mock ХУР-ын хөрөнгийн хаягтай (apps/kyc xyp.fixture) таарна — хороо → дүүрэг fallback-ийг үзүүлнэ.
const KHOROO_APARTMENT_PRICES: ReadonlyArray<readonly [district: string, khoroo: string, price: number]> = [
  ['Баянзүрх', '5-р хороо', 4_600_000],
  ['Сүхбаатар', '1-р хороо', 6_000_000],
  ['Хан-Уул', '11-р хороо', 5_800_000],
];

// DEMO: ₮/толгой (төрөл × нас).
const LIVESTOCK_PRICES: ReadonlyArray<readonly [type: string, adult: number, young: number]> = [
  ['HORSE', 1_800_000, 900_000],
  ['CATTLE', 2_000_000, 1_000_000],
  ['SHEEP', 280_000, 140_000],
  ['GOAT', 200_000, 100_000],
  ['CAMEL', 3_500_000, 1_800_000],
];

// DEMO: mock АТҮТ-ийн машинууд (src/integrations/vehicle-registry/mock-vehicles.ts) + ойролцоох он. Суурь үнэ = тухайн оны загварын ШИНЭ үеийн лавлах үнэ;
// DemoCollateralPricing-ийн элэгдэл (жилд 3%, дээд 50%) үүнийг хуучирсан үнэ болгоно. 2026 онд: Prius 2012 ≈ 25.5 сая, Prado 2015 ≈ 87 сая, Sonata 2017 ≈ 31.4 сая,
// LX 570 2018 ≈ 285 сая, Damas 2005 = 5 сая — mock зарын жишигтэй ойролцоо.
const VEHICLE_PRICES: ReadonlyArray<readonly [make: string, model: string, prices: Readonly<Record<number, number>>]> = [
  ['Toyota', 'Prius', { 2010: 41_000_000, 2011: 42_500_000, 2012: 44_000_000, 2013: 45_500_000, 2014: 47_000_000 }],
  ['Toyota', 'Land Cruiser Prado', { 2013: 124_000_000, 2014: 127_000_000, 2015: 130_000_000, 2016: 133_000_000, 2017: 136_000_000 }],
  ['Hyundai', 'Sonata', { 2015: 39_500_000, 2016: 41_250_000, 2017: 43_000_000, 2018: 44_750_000, 2019: 46_500_000 }],
  ['Lexus', 'LX 570', { 2016: 355_000_000, 2017: 365_000_000, 2018: 375_000_000, 2019: 385_000_000, 2020: 395_000_000 }],
  ['Daewoo', 'Damas', { 2003: 9_000_000, 2004: 9_500_000, 2005: 10_000_000, 2006: 10_500_000, 2007: 11_000_000 }],
];

export const DEMO_BASE_PRICES: readonly DemoBasePrice[] = [
  ...DISTRICT_PRICES.flatMap(([district, apartment, house, land]): DemoBasePrice[] => [
    { assetType: 'APARTMENT', key: { district }, unitPrice: apartment },
    { assetType: 'HOUSE', key: { district }, unitPrice: house },
    { assetType: 'LAND', key: { district }, unitPrice: land },
  ]),
  ...KHOROO_APARTMENT_PRICES.map(([district, khoroo, unitPrice]): DemoBasePrice => ({ assetType: 'APARTMENT', key: { district, khoroo }, unitPrice })),
  ...LIVESTOCK_PRICES.flatMap(([livestockType, adult, young]): DemoBasePrice[] => [
    { assetType: 'LIVESTOCK', key: { livestockType, ageGroup: 'ADULT' }, unitPrice: adult },
    { assetType: 'LIVESTOCK', key: { livestockType, ageGroup: 'YOUNG' }, unitPrice: young },
  ]),
  ...VEHICLE_PRICES.flatMap(([make, model, prices]): DemoBasePrice[] =>
    Object.entries(prices).map(([year, unitPrice]) => ({ assetType: 'VEHICLE', key: { make, model, year: Number(year) }, unitPrice })),
  ),
];

/** Create-only and idempotent: an existing rule or key is never overwritten, so an admin's edits survive a re-seed. */
export async function seedValuation(prisma: PrismaClient, orgId: string): Promise<{ haircuts: number; basePrices: number }> {
  let haircuts = 0;
  for (const [assetType, haircutRate] of Object.entries(DEMO_HAIRCUTS)) {
    // productId = null → бүх бүтээгдэхүүн. Prisma compound unique нь NULL-ийг ялгадаг тул findFirst-ээр шалгана.
    const exists = await prisma.haircutRule.findFirst({ where: { orgId, productId: null, assetType } });
    if (!exists) {
      await prisma.haircutRule.create({ data: { orgId, productId: null, assetType, haircutRate } });
      haircuts++;
    }
  }
  let basePrices = 0;
  for (const p of DEMO_BASE_PRICES) {
    const exists = await prisma.basePrice.findFirst({ where: { orgId, assetType: p.assetType, keyJson: { equals: p.key } }, select: { id: true } });
    if (!exists) {
      await prisma.basePrice.create({ data: { orgId, assetType: p.assetType, keyJson: p.key, unitPrice: p.unitPrice, validFrom: new Date(`${DEMO_VALID_FROM}T00:00:00.000Z`), version: 1 } });
      basePrices++;
    }
  }
  return { haircuts, basePrices };
}
