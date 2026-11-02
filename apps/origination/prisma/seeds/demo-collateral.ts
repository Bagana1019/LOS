import type { PrismaClient } from '.prisma/client-origination';
import { SEED, blindIndex, encryptedField } from '@los/database';
import { StepKey } from '@los/contracts';

// Модуль 6 demo seed (`SEED_DEMO=1`): барьцааны урсгалыг гараар туршихад бэлэн ноорог хүсэлт. Production seed-д ОРОХГҮЙ.
// DEMO: бүх утга таамаг. Регистр `УЕ00000001` нь kyc-ийн mock ХУР болон valuation-ий mock АТҮТ-ийн өмчлөгчтэй таарна (docs/05 §9):
//   ХУР-аас хөрөнгө татахад автомашин `УЕН5246` (Toyota Prius) гарна -> нэмэх -> өмчлөл -> ачаалал -> үнэлгээ -> баримт -> G0.
// Create-only: давтан ажиллуулахад хэрэглэгчийн өөрчилсөн өгөгдлийг дарахгүй (хүсэлт байвал юу ч хийхгүй).

export const DEMO_IDS = {
  customer: '00000000-0000-4000-8000-000000000401',
  application: '00000000-0000-4000-8000-000000000402',
} as const;
export const DEMO_APP_NO = 'DEMO-COL-0001'; // DEMO: Модуль 2-ын хүсэлтийн дугаарын загвар гарахад солино
export const DEMO_REGISTER_NO = 'УЕ00000001'; // DEMO

/** docs/01 §2.2: 1-р үе шатны 1-4 бүрдсэн, барьцаа..шийдвэр хүлээгдэж буй, 2-р үе шат (гэрээ, албан бичиг, олголт) цоожтой. */
const STEP_STATUS: Record<(typeof StepKey)[number], 'COMPLETED' | 'PENDING' | 'LOCKED'> = {
  client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED',
  collateral: 'PENDING', installment: 'PENDING', score: 'PENDING', document: 'PENDING', decision: 'PENDING',
  contract: 'LOCKED', official_documents: 'LOCKED', disburse: 'LOCKED',
};

export interface DemoCollateralResult { created: boolean; applicationId: string; customerId: string }

export async function seedDemoCollateral(db: PrismaClient, orgId: string): Promise<DemoCollateralResult> {
  const existing = await db.loanApplication.findUnique({ where: { id: DEMO_IDS.application }, select: { id: true } });
  const customerHash = blindIndex(DEMO_REGISTER_NO);
  let customer = await db.customer.findFirst({ where: { orgId, registerNoHash: customerHash }, select: { id: true } });
  if (existing) return { created: false, applicationId: existing.id, customerId: customer?.id ?? DEMO_IDS.customer };

  customer ??= await db.customer.create({
    data: {
      id: DEMO_IDS.customer, orgId, branchId: SEED.branches.head.id, customerType: 'INDIVIDUAL', lastName: 'Жишээ', firstName: 'Бат-Эрдэнэ', phone: '99110001',
      registerNoHash: customerHash, registerNoEncrypted: encryptedField(DEMO_REGISTER_NO), createdBy: SEED.users.officerA.id,
    },
    select: { id: true },
  });
  const vehicleProduct = await db.product.findFirst({ where: { orgId, id: SEED.products.vehicle }, select: { id: true } });
  if (!vehicleProduct) throw new Error('demo-collateral: VEHICLE product is missing - run the main origination seed first');

  await db.loanApplication.create({
    data: {
      id: DEMO_IDS.application, appNo: DEMO_APP_NO, orgId, branchId: SEED.branches.head.id, officerId: SEED.users.officerA.id, status: 'DRAFT', productId: vehicleProduct.id,
      currency: 'MNT', amount: 20_000_000, termMonths: 36, interestRate: 24, createdBy: SEED.users.officerA.id,
    },
  });
  await db.loanApplicationBorrower.create({
    data: { orgId, applicationId: DEMO_IDS.application, customerId: customer.id, role: 'PRIMARY', isPrimary: true, incomeIncluded: true, createdBy: SEED.users.officerA.id },
  });
  await db.loanApplicationStep.createMany({
    data: StepKey.map((stepKey) => ({
      orgId, applicationId: DEMO_IDS.application, stepKey, status: STEP_STATUS[stepKey], ...(STEP_STATUS[stepKey] === 'COMPLETED' ? { completedAt: new Date() } : {}), createdBy: SEED.users.officerA.id,
    })),
    skipDuplicates: true,
  });
  return { created: true, applicationId: DEMO_IDS.application, customerId: customer.id };
}
