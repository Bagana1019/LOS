// Модуль 0 seed (docs/04): haircut_rule (FR-14.2). Суурь үнийн сан (base_price) нь M6-д импортоор орно. Idempotent.
import { PrismaClient } from '.prisma/client-valuation';
import { SEED } from '@los/database';

const prisma = new PrismaClient();
const orgId = SEED.org.id;
// origination.product.haircut_json-тай ижил DEMO утга (docs/04 M6 AC: 30,000,000 × 0.7 = 21,000,000)
const haircut: Record<string, number> = { VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 };

async function main() {
  for (const [assetType, haircutRate] of Object.entries(haircut)) {
    // productId = null → бүх бүтээгдэхүүн. Prisma compound unique нь NULL-ийг ялгадаг тул findFirst-ээр шалгана.
    const exists = await prisma.haircutRule.findFirst({ where: { orgId, productId: null, assetType } });
    if (!exists) await prisma.haircutRule.create({ data: { orgId, productId: null, assetType, haircutRate } });
  }
  console.log(`valuation seed: ${Object.keys(haircut).length} haircut rules`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
