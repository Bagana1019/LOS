// Модуль 0 seed (docs/04): тохиргоо (BR-1…BR-13), 3 бүтээгдэхүүн (BR-6), батлах 3 түвшин, гэрээний дугаарын загвар.
// Idempotent: давтан ажиллуулахад админы өөрчилсөн утгыг дарахгүй (create-only). Бүх утга DEMO таамаг — docs/DECISIONS.md.
import { PrismaClient } from '.prisma/client-origination';
import { SEED } from '@los/database';
import { SETTING_REGISTRY, type SettingKey } from '@los/contracts';
import { seedPricingTiers } from './seeds/pricing-tiers';

const prisma = new PrismaClient();
const orgId = SEED.org.id;
const U = SEED.users;

const consumerChecklist = [
  { key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', required: true },
  { key: 'salary_statement', name: 'Цалингийн тодорхойлолт', required: true },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', required: true },
];
const businessChecklist = [
  { key: 'id_card', name: 'Иргэний үнэмлэхний хуулбар', required: true },
  { key: 'business_license', name: 'Бизнесийн гэрчилгээ', required: true },
  { key: 'application_form', name: 'Зээлийн хүсэлтийн маягт', required: true },
];
// FR-6.7: хөрөнгийн төрлөөр заавал баримт
const collateralChecklist = {
  APARTMENT: ['ownership_certificate', 'cadastral_plan', 'registry_extract'],
  HOUSE: ['ownership_certificate', 'cadastral_plan', 'registry_extract'],
  LAND: ['ownership_certificate', 'cadastral_plan', 'registry_extract'],
  VEHICLE: ['vehicle_certificate', 'traffic_registry_extract', 'insurance'],
  LIVESTOCK: ['head_count_extract'],
  INVENTORY: ['stocktake_act'],
  EQUIPMENT: ['purchase_invoice'],
  OTHER: ['ownership_proof'],
};
// FR-14.2: haircut (барьцааны үнэлгээ = зах зээлийн үнэ × haircut). docs/04 M6 AC: VEHICLE 0.7
const haircut = { VEHICLE: 0.7, APARTMENT: 0.8, HOUSE: 0.75, LAND: 0.6, LIVESTOCK: 0.5, INVENTORY: 0.5, EQUIPMENT: 0.6, OTHER: 0.4 };

const products = [
  { id: SEED.products.consumer, code: 'CONSUMER', name: 'Хэрэглээний зээл – Иргэд', productType: 'CONSUMER',
    minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42, defaultFeeRate: 0.01,
    requiresCollateral: false, documentChecklistJson: consumerChecklist, collateralChecklistJson: collateralChecklist, haircutJson: haircut, externalValuationThreshold: null, costOfGoodsRate: null },
  { id: SEED.products.business, code: 'BUSINESS', name: 'Бизнесийн зээл', productType: 'BUSINESS',
    minAmount: 1_000_000, maxAmount: 300_000_000, minTerm: 6, maxTerm: 60, minRate: 16, maxRate: 36, defaultFeeRate: 0.015,
    requiresCollateral: true, documentChecklistJson: businessChecklist, collateralChecklistJson: collateralChecklist, haircutJson: haircut, externalValuationThreshold: 100_000_000, costOfGoodsRate: 0.1 },
  { id: SEED.products.vehicle, code: 'VEHICLE', name: 'Автомашины зээл (барьцаат)', productType: 'SECURED',
    minAmount: 5_000_000, maxAmount: 150_000_000, minTerm: 6, maxTerm: 48, minRate: 20, maxRate: 36, defaultFeeRate: 0.01,
    requiresCollateral: true, documentChecklistJson: consumerChecklist, collateralChecklistJson: collateralChecklist, haircutJson: haircut, externalValuationThreshold: 100_000_000, costOfGoodsRate: null },
];

// BR-13: ≤5 сая → 1 түвшин (салбар); ≤30 сая → +төв; >30 сая → +зээлийн хороо. Хүсэлт 1.2 сая → 1 түвшин, 50 сая → 3 түвшин (docs/04 M10 AC).
const levels = [
  { levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: 5_000_000, members: [U.manager.id] },
  { levelNo: 2, name: 'Төв', amountFrom: 5_000_000, amountTo: 30_000_000, members: [U.approver.id] },
  { levelNo: 3, name: 'Зээлийн хороо', amountFrom: 30_000_000, amountTo: null, members: [U.approver.id, U.manager.id] },
];

async function main() {
  for (const key of Object.keys(SETTING_REGISTRY) as SettingKey[]) {
    await prisma.setting.upsert({
      where: { orgId_key: { orgId, key } },
      create: { orgId, key, valueJson: SETTING_REGISTRY[key].default as never },
      update: {},
    });
  }
  const sla = SETTING_REGISTRY['approval.default_sla_hours'].default as number;

  for (const p of products) {
    const { id, ...data } = p;
    await prisma.product.upsert({
      where: { orgId_code: { orgId, code: p.code } },
      create: { id, orgId, ...data, currency: 'MNT', maxLtv: 0.7, maxDti: 0.55, minDscr: 1.25, calcWeightThreshold: 0.7 } as never,
      update: {},
    });
  }

  for (const l of levels) {
    const existing = await prisma.approvalLevel.findFirst({ where: { orgId, productId: null, levelNo: l.levelNo } });
    if (existing) continue;
    await prisma.approvalLevel.create({
      data: {
        orgId, productId: null, levelNo: l.levelNo, name: l.name, amountFrom: l.amountFrom, amountTo: l.amountTo, quorumType: 'MAJORITY', slaHours: sla,
        members: { create: l.members.map((userId) => ({ orgId, userId })) },
      },
    });
  }

  if ((await prisma.contractNumberTemplate.count({ where: { orgId } })) === 0) {
    await prisma.contractNumberTemplate.create({ data: { orgId, pattern: '{PREFIX}{BRANCH}{YYMMDD}{SEQ:2}', prefix: 'B', seqScope: 'DAY', nextSeq: 1 } });
  }
  const pricing = await seedPricingTiers(prisma, orgId); // FR-5.5
  console.log(`origination seed: ${Object.keys(SETTING_REGISTRY).length} settings, ${products.length} products, ${levels.length} approval levels, pricing tiers ${pricing ? 'created' : 'kept'}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
