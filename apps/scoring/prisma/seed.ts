// Модуль 0 seed (docs/04): BSA ангилал + анхдагч дүрмүүд (docs/02 §4), Sosco Score загвар v1. Idempotent (create-only).
// Бүх жин/босго DEMO таамаг — docs/DECISIONS.md. Admin (M13) UI-аас засна.
import { PrismaClient } from '.prisma/client-scoring';
import { SEED } from '@los/database';

const prisma = new PrismaClient();
const orgId = SEED.org.id;

type Cat = [code: string, direction: 'INCOME' | 'EXPENSE', group: string, name: string, weight: number, dtiRole: string];
// docs/02 §4. Дайчлах хувь орлогод; зарлагад 1 (DTI-д хэрхэн нөлөөлөхийг dti_role тодорхойлно).
const categories: Cat[] = [
  ['INC_SALARY', 'INCOME', 'A', 'Хөдөлмөрийн орлого (цалин)', 1, 'INCOME'],
  ['INC_CASH', 'INCOME', 'B', 'Бэлэн орлого', 0.5, 'INCOME'],
  ['INC_BUSINESS', 'INCOME', 'B', 'Бизнесийн орлого (бэлэнгээс бусад)', 0.85, 'INCOME'],
  ['INC_PASSIVE', 'INCOME', 'C', 'Идэвхгүй орлого (түрээс, хүү, ногдол ашиг)', 1, 'INCOME'],
  ['INC_CONTRACT', 'INCOME', 'D', 'Гэрээт ажлын орлого', 0.7, 'INCOME'],
  ['INC_OTHER', 'INCOME', '?', 'Бусад орлого', 0.1, 'INCOME'],
  ['INC_IRREGULAR', 'INCOME', '-', 'Тогтмол бус орлого', 0, 'EXCLUDE'],
  ['INC_LOAN', 'INCOME', '-', 'Зээл (авсан зээлийн олголт)', 0, 'EXCLUDE'],
  ['INC_NON_INCOME', 'INCOME', '-', 'Орлого бус (буцаалт, залруулга)', 0, 'EXCLUDE'],
  ['INC_ABNORMAL', 'INCOME', '-', 'Хэвийн бус', 0, 'EXCLUDE'],
  ['INC_SUSPICIOUS', 'INCOME', '-', 'Сэжигтэй орлого', 0, 'EXCLUDE'],
  ['EXP_LOAN', 'EXPENSE', 'A', 'Зээл (зээлийн төлбөр)', 1, 'DEBT_SERVICE'],
  ['EXP_DEBT', 'EXPENSE', 'A', 'Өрийн үүрэг', 1, 'DEBT_SERVICE'],
  ['EXP_FIXED', 'EXPENSE', 'B', 'Тогтмол зардал', 1, 'HOUSEHOLD'],
  ['EXP_ESSENTIAL', 'EXPENSE', 'C', 'Зайлшгүй зардал', 1, 'HOUSEHOLD'],
  ['EXP_OPTIONAL', 'EXPENSE', 'D', 'Сонгон зардал', 1, 'INFO'],
  ['EXP_BUSINESS', 'EXPENSE', 'E', 'Бизнесийн зардал', 1, 'BUSINESS_EXPENSE'],
  ['EXP_BANK_FEE', 'EXPENSE', 'F', 'Банкны шимтгэл', 1, 'INFO'],
  ['EXP_NON_EXPENSE', 'EXPENSE', 'F', 'Зардал бус (өөрийн данс, хадгаламж)', 1, 'EXCLUDE'],
  ['EXP_SUSPICIOUS', 'EXPENSE', 'G', 'Сэжигтэй зардал', 1, 'INFO'],
  ['EXP_CHANNEL', 'EXPENSE', 'CH', 'Сувгийн зарлага (QPay, POS, ATM)', 1, 'INFO'],
  ['EXP_OTHER', 'EXPENSE', '?', 'Бусад зардал', 1, 'INFO'],
];

type Rule = [direction: 'INCOME' | 'EXPENSE', pattern: string, category: string, priority: number];
// Түлхүүр үгийн анхдагч дүрэм (BSA-FR-3.5; admin өргөтгөнө). Бага priority = түрүүлж.
const rules: Rule[] = [
  ['INCOME', 'зээл олголт', 'INC_LOAN', 10], ['INCOME', 'зээлийн олголт', 'INC_LOAN', 10], ['INCOME', 'loan disbursement', 'INC_LOAN', 10],
  ['INCOME', 'буцаалт', 'INC_NON_INCOME', 20], ['INCOME', 'refund', 'INC_NON_INCOME', 20], ['INCOME', 'залруулга', 'INC_NON_INCOME', 20],
  ['INCOME', 'цалин', 'INC_SALARY', 30], ['INCOME', 'salary', 'INC_SALARY', 30], ['INCOME', 'хөлс', 'INC_SALARY', 35],
  ['INCOME', 'түрээс', 'INC_PASSIVE', 40], ['INCOME', 'rent', 'INC_PASSIVE', 40], ['INCOME', 'ногдол ашиг', 'INC_PASSIVE', 40], ['INCOME', 'хадгаламжийн хүү', 'INC_PASSIVE', 40],
  ['INCOME', 'гэрээний', 'INC_CONTRACT', 50],
  ['INCOME', 'бэлэн мөнгө', 'INC_CASH', 60], ['INCOME', 'cash deposit', 'INC_CASH', 60],
  ['INCOME', 'qpay', 'INC_BUSINESS', 70], ['INCOME', 'pos', 'INC_BUSINESS', 70], ['INCOME', 'борлуулалт', 'INC_BUSINESS', 70],
  ['EXPENSE', 'зээлийн төлбөр', 'EXP_LOAN', 10], ['EXPENSE', 'loan repayment', 'EXP_LOAN', 10], ['EXPENSE', 'сарын төлбөр', 'EXP_LOAN', 15], ['EXPENSE', 'зээл төлөлт', 'EXP_LOAN', 15],
  ['EXPENSE', 'шимтгэл', 'EXP_BANK_FEE', 20], ['EXPENSE', 'fee', 'EXP_BANK_FEE', 20],
  ['EXPENSE', 'даатгал', 'EXP_FIXED', 30], ['EXPENSE', 'цахилгаан', 'EXP_FIXED', 30], ['EXPENSE', 'дулаан', 'EXP_FIXED', 30], ['EXPENSE', 'интернет', 'EXP_FIXED', 30], ['EXPENSE', 'сургалтын төлбөр', 'EXP_FIXED', 30],
  ['EXPENSE', 'хүнс', 'EXP_ESSENTIAL', 40], ['EXPENSE', 'эмийн сан', 'EXP_ESSENTIAL', 40], ['EXPENSE', 'шатахуун', 'EXP_ESSENTIAL', 40],
  ['EXPENSE', 'ресторан', 'EXP_OPTIONAL', 50], ['EXPENSE', 'кафе', 'EXP_OPTIONAL', 50],
  ['EXPENSE', 'түүхий эд', 'EXP_BUSINESS', 60], ['EXPENSE', 'нийлүүлэгч', 'EXP_BUSINESS', 60], ['EXPENSE', 'ажилчдын цалин', 'EXP_BUSINESS', 55],
];

// SoscoWeights (@los/calc): нийлбэр 1.0. Босго — оноо 0–1000 → A–E.
const soscoWeights = { fico: 0.3, dti: 0.25, reliability: 0.15, suspicious: 0.1, history: 0.15, ltv: 0.05 };
const gradeThresholds = { A: 800, B: 700, C: 600, D: 500, E: 0 };

async function main() {
  for (const [i, [code, direction, groupCode, name, weight, dtiRole]] of categories.entries()) {
    await prisma.bsaCategory.upsert({
      where: { orgId_code: { orgId, code } },
      create: { orgId, code, direction, groupCode, name, weight, dtiRole, sortOrder: i, isActive: true },
      update: {},
    });
  }
  if ((await prisma.bsaRule.count({ where: { orgId } })) === 0) {
    await prisma.bsaRule.createMany({ data: rules.map(([direction, pattern, categoryCode, priority]) => ({ orgId, direction, matchType: 'KEYWORD', pattern, categoryCode, priority, source: 'ADMIN' })) });
  }
  await prisma.soscoModel.upsert({
    where: { orgId_version: { orgId, version: 1 } },
    create: { orgId, version: 1, weightsJson: soscoWeights, gradeThresholdsJson: gradeThresholds, isActive: true },
    update: {},
  });
  console.log(`scoring seed: ${categories.length} BSA categories, ${rules.length} rules, sosco_model v1`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
