// Модуль 0 + Модуль 6 seed (docs/04): haircut_rule (FR-14.2), DEMO суурь үнийн сан base_price (FR-14.1). Idempotent, create-only. Өгөгдөл: seed-data.ts.
import { PrismaClient } from '.prisma/client-valuation';
import { SEED } from '@los/database';
import { seedValuation } from './seed-data';

const prisma = new PrismaClient();

seedValuation(prisma, SEED.org.id)
  .then((created) => console.log(`valuation seed: ${created.haircuts} haircut rules, ${created.basePrices} DEMO base prices created`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
