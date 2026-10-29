// scoring сервисийн seed (pnpm --filter @los/scoring db:seed). Идемпотент: хоёр дахь ажиллуулалт юу ч өөрчлөхгүй.
// BSA ангилал + дүрмийн анхдагч сан (docs/02 §4, NFR-6, BSA-FR-3.5): src/modules/bsa/classify/default-catalog.ts-ээс, байгууллага (SEED_ORG_ID) тутамд.
//  - Анхдагч: ДУТУУГ нэмнэ, байгааг ӨӨРЧИЛӨХГҮЙ — admin засварласан дайчлах хувь/босгыг дахин seed дарахгүй.
//  - SEED_BSA_REFRESH=1: ангилал/дүрмийг анхдагч утга руу буцаана (зөвхөн ялгаатай мөрийг шинэчилнэ).
//  - Sosco Score загвар v1 (Модуль 0): жин/босго DEMO таамаг — docs/DECISIONS.md. Admin (M13) UI-аас засна.
import { Prisma, PrismaClient } from '../node_modules/.prisma/client-scoring';
import { SEED } from '@los/database';
import { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from '../src/modules/bsa/classify/default-catalog';

const SEEDED_BY = 'seed';

export interface CatalogSeedResult {
  categories: { created: number; updated: number; unchanged: number };
  rules: { created: number; updated: number; unchanged: number };
}

const ruleKey = (r: { direction: string; matchType: string; pattern: string; categoryCode: string; source: string }): string =>
  [r.direction, r.matchType, r.pattern, r.categoryCode, r.source].join('\u0000');

/** Анхдагч ангилал, дүрмийг org-д нэг транзакцид суулгана */
export async function seedBsaCatalog(db: PrismaClient, orgId: string, refresh = false): Promise<CatalogSeedResult> {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const result: CatalogSeedResult = { categories: { created: 0, updated: 0, unchanged: 0 }, rules: { created: 0, updated: 0, unchanged: 0 } };

    // ── Ангилал: (org_id, code) ──
    const existingCats = new Map((await tx.bsaCategory.findMany({ where: { orgId } })).map((c) => [c.code, c]));
    const newCats = DEFAULT_BSA_CATEGORIES.filter((c) => !existingCats.has(c.code));
    if (newCats.length > 0) {
      await tx.bsaCategory.createMany({
        data: newCats.map((c) => ({ orgId, code: c.code, direction: c.direction, groupCode: c.groupCode, name: c.name, weight: c.weight, dtiRole: c.dtiRole, isActive: c.isActive, createdBy: SEEDED_BY, updatedBy: SEEDED_BY })),
        skipDuplicates: true,
      });
    }
    result.categories.created = newCats.length;
    for (const c of DEFAULT_BSA_CATEGORIES) {
      const cur = existingCats.get(c.code);
      if (!cur) continue;
      const differs =
        cur.direction !== c.direction || cur.groupCode !== c.groupCode || cur.name !== c.name || cur.dtiRole !== c.dtiRole || cur.isActive !== c.isActive || cur.weight.toNumber() !== c.weight;
      if (refresh && differs) {
        await tx.bsaCategory.update({
          where: { id: cur.id },
          data: { direction: c.direction, groupCode: c.groupCode, name: c.name, weight: c.weight, dtiRole: c.dtiRole, isActive: c.isActive, updatedBy: SEEDED_BY },
        });
        result.categories.updated += 1;
      } else {
        result.categories.unchanged += 1;
      }
    }

    // ── Дүрэм: байгалийн түлхүүр (org, direction, match_type, pattern, category_code, source) ──
    const existingRules = new Map((await tx.bsaRule.findMany({ where: { orgId } })).map((r) => [ruleKey(r), r]));
    const newRules = DEFAULT_BSA_RULES.filter((r) => !existingRules.has(ruleKey(r)));
    if (newRules.length > 0) {
      await tx.bsaRule.createMany({
        data: newRules.map((r) => ({
          orgId, direction: r.direction, matchType: r.matchType, pattern: r.pattern, categoryCode: r.categoryCode, priority: r.priority, source: r.source,
          createdBy: SEEDED_BY, updatedBy: SEEDED_BY,
        })),
        skipDuplicates: true,
      });
    }
    result.rules.created = newRules.length;
    for (const r of DEFAULT_BSA_RULES) {
      const cur = existingRules.get(ruleKey(r));
      if (!cur) continue;
      if (refresh && (cur.priority !== r.priority || !cur.isActive)) {
        await tx.bsaRule.update({ where: { id: cur.id }, data: { priority: r.priority, isActive: true, updatedBy: SEEDED_BY } });
        result.rules.updated += 1;
      } else {
        result.rules.unchanged += 1;
      }
    }
    return result;
  });
}

// SoscoWeights (@los/calc): нийлбэр 1.0. Босго — оноо 0–1000 → A–E.
const SOSCO_WEIGHTS = { fico: 0.3, dti: 0.25, reliability: 0.15, suspicious: 0.1, history: 0.15, ltv: 0.05 };
const SOSCO_GRADE_THRESHOLDS = { A: 800, B: 700, C: 600, D: 500, E: 0 };

/** Sosco Score загвар v1 — байвал өөрчлөхгүй */
export async function seedSoscoModel(db: PrismaClient, orgId: string): Promise<void> {
  await db.soscoModel.upsert({
    where: { orgId_version: { orgId, version: 1 } },
    create: { orgId, version: 1, weightsJson: SOSCO_WEIGHTS, gradeThresholdsJson: SOSCO_GRADE_THRESHOLDS, isActive: true },
    update: {},
  });
}

async function main(): Promise<void> {
  const orgId = process.env.SEED_ORG_ID ?? SEED.org.id;
  const refresh = process.env.SEED_BSA_REFRESH === '1';
  const prisma = new PrismaClient({ errorFormat: 'minimal' });
  try {
    const r = await seedBsaCatalog(prisma, orgId, refresh);
    await seedSoscoModel(prisma, orgId);
    console.log(`seed scoring: org=${orgId} refresh=${refresh} bsa_category ${JSON.stringify(r.categories)} bsa_rule ${JSON.stringify(r.rules)}, sosco_model v1`);
  } finally {
    await prisma.$disconnect();
  }
}

// `tsx prisma/seed.ts` гэж ажиллуулсан үед л; import хийхэд (тест) ажиллахгүй
if (require.main === module) {
  main().catch((e: unknown) => {
    console.error('seed scoring failed:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
