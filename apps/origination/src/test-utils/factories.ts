import { randomUUID } from 'node:crypto';
import { addDays, annuityPayment } from '@los/calc';
import { blindIndex, encryptedField } from '@los/database';
import type { Customer, LoanApplication, Prisma } from '.prisma/client-origination';
import { PrismaService } from '../prisma.service';

export const hasTestDb = !!process.env.TEST_DATABASE_URL;

export const ORG = 'org-test';
export const BRANCH = 'branch-1';

/**
 * Тестийн өгөгдлийг цэвэрлэнэ. Module 0-ийн seed-ийн лавлах хүснэгтүүд (setting, product, approval_level*, contract_number_template)
 * болон migration-ийн хүснэгтийг хөндөхгүй — seed-д тулгуурладаг тест (`test/settings.e2e.test.ts`) эвдрэхгүй. Эдгээр тестүүд зөвхөн `ORG`-ийн `setting`, `product` мөрийг ашиглах тул тэдгээрийг л устгана.
 * Өөр модулийн хүснэгтийг (Maker-Checker-ийн append-only `change_request*` — TRUNCATE-г trigger хориглоно, `pricing_tier`) хөндөхгүй.
 */
const KEEP_TABLES = new Set([
  '_prisma_migrations', 'setting', 'product', 'approval_level', 'approval_level_member', 'contract_number_template',
  'change_request', 'change_request_history', 'maker_checker_policy', 'pricing_tier',
]);

export async function resetDb(prisma: PrismaService): Promise<void> {
  const tables = (await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'origination'`).filter((t) => !KEEP_TABLES.has(t.tablename));
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"origination"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.setting.deleteMany({ where: { orgId: ORG } });
  await prisma.product.deleteMany({ where: { orgId: ORG } });
}

let seq = 0;
export const nextSeq = () => ++seq;

export async function createCustomer(prisma: PrismaService, o: Partial<Prisma.CustomerUncheckedCreateInput> & { registerNo?: string } = {}): Promise<Customer> {
  const n = nextSeq();
  const registerNo = o.registerNo ?? `УБ${String(90000000 + n)}`;
  const { registerNo: _ignored, ...rest } = o;
  return prisma.customer.create({
    data: {
      orgId: ORG, customerType: 'INDIVIDUAL', firstName: `Нэр${n}`, lastName: `Овог${n}`, phone: `9911${String(1000 + n).slice(-4)}`, email: `c${n}@example.mn`,
      ...rest, registerNoHash: blindIndex(registerNo), registerNoEncrypted: encryptedField(registerNo),
    },
  });
}

export async function createApplication(prisma: PrismaService, o: Partial<Prisma.LoanApplicationUncheckedCreateInput> = {}): Promise<LoanApplication> {
  const n = nextSeq();
  return prisma.loanApplication.create({
    data: { appNo: `APP-${String(n).padStart(5, '0')}`, orgId: ORG, branchId: BRANCH, officerId: 'officer-1', status: 'DRAFT', currency: 'MNT', amount: 10_000_000, interestRate: 24, termMonths: 12, ...o },
  });
}

export async function createBorrower(prisma: PrismaService, applicationId: string, customerId: string, role: 'PRIMARY' | 'CO_BORROWER' | 'GUARANTOR' | 'PLEDGOR' = 'PRIMARY', o: Partial<Prisma.LoanApplicationBorrowerUncheckedCreateInput> = {}) {
  return prisma.loanApplicationBorrower.create({ data: { orgId: ORG, applicationId, customerId, role, isPrimary: role === 'PRIMARY', incomeIncluded: role === 'PRIMARY' || role === 'CO_BORROWER', ...o } });
}

/** Жишээ ЭТХ: тэнцүү төлбөр (annuity), эхний төлөх өдөр firstDue (YYYY-MM-DD), сар бүр 30 хоног. */
export async function createSchedule(prisma: PrismaService, applicationId: string, o: { principal?: number; rate?: number; months?: number; firstDue: string; stale?: boolean }) {
  const principal = o.principal ?? 1_200_000;
  const rate = o.rate ?? 24;
  const months = o.months ?? 12;
  const payment = annuityPayment(principal, rate, months);
  let balance = principal;
  const rows: Prisma.RepaymentScheduleRowCreateWithoutScheduleInput[] = [];
  for (let seq = 1; seq <= months; seq++) {
    const interest = Math.round(balance * (rate / 100 / 12) * 100) / 100;
    const princ = seq === months ? balance : Math.round((payment - interest) * 100) / 100;
    balance = Math.round((balance - princ) * 100) / 100;
    rows.push({ seq, dueDate: new Date(addDays(o.firstDue, (seq - 1) * 30) + 'T00:00:00Z'), days: 30, disbursement: 0, principal: princ, interest, total: Math.round((princ + interest) * 100) / 100, balance });
  }
  return prisma.repaymentSchedule.create({
    data: { orgId: ORG, applicationId, paramsJson: { principal, rate, months }, isStale: o.stale ?? false, rows: { create: rows } },
    include: { rows: { orderBy: { seq: 'asc' } } },
  });
}

/** X-* толгойнууд (gateway-ийн оронд). */
export const actors = {
  officer: (userId = 'officer-1', branchId = BRANCH) => ({ 'x-user-id': userId, 'x-roles': 'OFFICER', 'x-branch-id': branchId, 'x-org-id': ORG }),
  branchManager: (userId = 'bm-1', branchId = BRANCH) => ({ 'x-user-id': userId, 'x-roles': 'BRANCH_MANAGER', 'x-branch-id': branchId, 'x-org-id': ORG }),
  approver: (userId = 'approver-1') => ({ 'x-user-id': userId, 'x-roles': 'APPROVER', 'x-org-id': ORG }),
  admin: (userId = 'admin-1') => ({ 'x-user-id': userId, 'x-roles': 'ADMIN', 'x-org-id': ORG }),
  customer: (customerId: string) => ({ 'x-customer-id': customerId, 'x-roles': 'CUSTOMER', 'x-org-id': ORG }),
  anonymous: () => ({ 'x-org-id': ORG }),
};

export const uuid = randomUUID;
