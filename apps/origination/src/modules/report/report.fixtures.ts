// Тайлангийн тестийн өгөгдөл. Тоонууд нь гараар тооцоход хялбар (тэгш) байхаар сонгосон; хүлээгдэх утгууд нь тестүүдэд тайлбартай.
// `test-utils/factories` дээр тулгуурлана. asOf = 2026-10-28 (FixedClock-ийн анхдагч).
import type { Customer, LoanApplication } from '.prisma/client-origination';
import { StepKey } from '@los/contracts';
import { ORG, createApplication, createBorrower, createCustomer } from '../../test-utils/factories';
import { encryptedField } from '@los/database';
import { Prisma } from '.prisma/client-origination';
import type { PrismaService } from '../../prisma.service';

export const ASOF = '2026-10-28';
export const OTHER_ORG = 'org-other';
const at = (iso: string) => new Date(iso);

export interface RowSpec { due: string; principal: number; interest: number }
/** Сар бүрийн огноотой ЭТХ: үндсэн/хүү тогтмол. */
export const rowsOf = (dues: string[], principal: number, interest: number): RowSpec[] => dues.map((due) => ({ due, principal, interest }));

export async function createExactSchedule(prisma: PrismaService, applicationId: string, rows: RowSpec[], o: { stale?: boolean; generatedAt?: Date; orgId?: string } = {}) {
  let balance = rows.reduce((s, r) => s + r.principal, 0);
  return prisma.repaymentSchedule.create({
    data: {
      orgId: o.orgId ?? ORG, applicationId, paramsJson: { fixture: true }, isStale: o.stale ?? false, ...(o.generatedAt ? { generatedAt: o.generatedAt } : {}),
      rows: { create: rows.map((r, i) => { balance -= r.principal; return { seq: i + 1, dueDate: at(`${r.due}T00:00:00Z`), days: 30, disbursement: 0, principal: r.principal, interest: r.interest, total: r.principal + r.interest, balance }; }) },
    },
    include: { rows: { orderBy: { seq: 'asc' } } },
  });
}

export interface PaymentSpec { id: string; paidAt: string; amount: number; provider?: 'QPAY' | 'SOCIALPAY' | 'BANK_TRANSFER'; unallocated?: number; currency?: string; allocations?: Array<{ rowId: string; interest: number; principal: number }> }

export async function createPayment(prisma: PrismaService, applicationId: string, p: PaymentSpec) {
  return prisma.payment.create({
    data: {
      orgId: ORG, applicationId, provider: p.provider ?? 'BANK_TRANSFER', providerPaymentId: p.id, amount: p.amount, currency: p.currency ?? 'MNT', paidAt: at(p.paidAt),
      unallocatedAmount: p.unallocated ?? 0,
      allocations: { create: (p.allocations ?? []).map((a) => ({ scheduleRowId: a.rowId, interestPaid: a.interest, principalPaid: a.principal, totalPaid: a.interest + a.principal })) },
    },
  });
}

/** Хүсэлтийн 12 алхам (StepKey дарааллаар). */
export async function createSteps(prisma: PrismaService, applicationId: string, statuses: Partial<Record<(typeof StepKey)[number], 'LOCKED' | 'PENDING' | 'COMPLETED' | 'STALE'>> | 'ALL_COMPLETED') {
  await prisma.loanApplicationStep.createMany({
    data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId, stepKey, status: statuses === 'ALL_COMPLETED' ? 'COMPLETED' : statuses[stepKey] ?? 'LOCKED' })),
  });
}

export interface LoanSeed {
  key: string;
  last: string; first: string; register: string; phone: string;
  app: Partial<Prisma.LoanApplicationUncheckedCreateInput>;
  productId?: string | null;
}

export interface SeededLoan { app: LoanApplication; customer: Customer; rows: Array<{ id: string; seq: number }> }
export type World = Record<'LA' | 'LB' | 'LC' | 'LD' | 'LE' | 'LF' | 'LCL2' | 'LG' | 'LH' | 'LI' | 'LJ' | 'LK' | 'LN', SeededLoan> & {
  products: { consumer: { id: string }; business: { id: string } };
  coOwner: Customer;
  collateral: Record<'c1' | 'c2' | 'c3' | 'c4', { id: string }>;
};

const BASE_TS = { createdAt: at('2026-07-01T04:00:00Z'), updatedAt: at('2026-10-20T04:00:00Z') };

export async function seedLoan(prisma: PrismaService, s: LoanSeed, schedule?: { rows: RowSpec[]; stale?: boolean }): Promise<SeededLoan> {
  const customer = await createCustomer(prisma, { lastName: s.last, firstName: s.first, phone: s.phone, registerNo: s.register });
  const app = await createApplication(prisma, { ...BASE_TS, appNo: `APP-${s.key}`, ...s.app, ...(s.productId ? { productId: s.productId } : {}) });
  await createBorrower(prisma, app.id, customer.id, 'PRIMARY');
  const sched = schedule ? await createExactSchedule(prisma, app.id, schedule.rows, { stale: schedule.stale }) : null;
  return { app, customer, rows: sched ? sched.rows.map((r) => ({ id: r.id, seq: r.seq })) : [] };
}

/**
 * Дэлгэрэнгүй (хүлээгдэх утгууд тест бүрт):
 *  LA ACTIVE MNT b1/o1  600k, 6 мөр (100k+10k) 08-10…2027-01-10; төлөлт: мөр1 бүтэн, мөр2 50k (хүү 10k + үндсэн 40k) → хугацаа хэтэрсэн (DPD 48)
 *  LB ACTIVE MNT b1/o1  300k, 3 мөр (100k+5k) 10-28(өнөөдөр),11-28,12-28; мөр1-д хүү 5k төлсөн
 *  LC ACTIVE MNT b2/o2  1,000k, 5 мөр (200k+20k) 07-01…11-01; төлөлтгүй → DPD 119
 *  LD MIGRATED USD b1/o1 3,000, 3 мөр (1000+100) 09-15,10-15,11-15; мөр1 төлсөн → DPD 13
 *  LE ACTIVE MNT b1/o1  500k, зөвхөн stale ЭТХ (одоогийн ЭТХ байхгүй)
 *  LF CLOSED MNT b1/o1  400k, 4 мөр 06-20…09-20 бүгд төлсөн (2 төлбөр)
 *  LCL2 CLOSED MNT b2/o2 100k, төлбөргүй, updatedAt 08-15
 *  LG DRAFT / LH SUBMITTED / LI RETURNED / LJ APPROVED / LK DISBURSING — явцын хяналт
 *  LN ACTIVE MNT b2/o2  250k, 1 мөр (250k+5k) 11-12; хуваарилагдаагүй 1k төлөлт
 */
export async function seedWorld(prisma: PrismaService): Promise<World> {
  const consumer = await prisma.product.create({ data: { orgId: ORG, code: 'CONSUMER', name: 'Хэрэглээний зээл', productType: 'CONSUMER', minAmount: 100000, maxAmount: 50000000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42 } });
  const business = await prisma.product.create({ data: { orgId: ORG, code: 'BUSINESS', name: 'Бизнесийн зээл', productType: 'BUSINESS', minAmount: 100000, maxAmount: 50000000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42 } });

  const LA = await seedLoan(prisma, { key: 'LA', last: 'Бат', first: 'Болд', register: 'УБ90000001', phone: '99000001', productId: consumer.id, app: {
    contractNo: 'B10026LA', status: 'ACTIVE', amount: 600000, termMonths: 6, interestRate: 24, disbursedAt: at('2026-07-05T02:00:00Z'), branchId: 'branch-1', officerId: 'officer-1',
    submittedAt: at('2026-06-20T02:00:00Z'), approvedAt: at('2026-06-22T02:00:00Z'),
  } }, { rows: rowsOf(['2026-08-10', '2026-09-10', '2026-10-10', '2026-11-10', '2026-12-10', '2027-01-10'], 100000, 10000) });
  await createPayment(prisma, LA.app.id, { id: 'LA-1', paidAt: '2026-08-12T04:00:00Z', amount: 110000, provider: 'QPAY', allocations: [{ rowId: LA.rows[0].id, interest: 10000, principal: 100000 }] });
  await createPayment(prisma, LA.app.id, { id: 'LA-2', paidAt: '2026-09-12T04:00:00Z', amount: 50000, provider: 'BANK_TRANSFER', allocations: [{ rowId: LA.rows[1].id, interest: 10000, principal: 40000 }] });

  const LB = await seedLoan(prisma, { key: 'LB', last: 'Дорж', first: 'Сараа', register: 'УБ90000002', phone: '99000002', productId: consumer.id, app: {
    contractNo: 'B10026LB', status: 'ACTIVE', amount: 300000, termMonths: 3, interestRate: 24, disbursedAt: at('2026-09-28T02:00:00Z'), branchId: 'branch-1', officerId: 'officer-1',
    submittedAt: at('2026-09-10T02:00:00Z'), approvedAt: at('2026-09-10T14:00:00Z'),
  } }, { rows: rowsOf(['2026-10-28', '2026-11-28', '2026-12-28'], 100000, 5000) });
  await createPayment(prisma, LB.app.id, { id: 'LB-1', paidAt: '2026-10-27T05:00:00Z', amount: 5000, provider: 'BANK_TRANSFER', allocations: [{ rowId: LB.rows[0].id, interest: 5000, principal: 0 }] });

  const LC = await seedLoan(prisma, { key: 'LC', last: 'Чимэд', first: 'Тэмүүлэн', register: 'УБ90000003', phone: '99000003', productId: business.id, app: {
    contractNo: 'B10026LC', status: 'ACTIVE', amount: 1000000, termMonths: 5, interestRate: 36, disbursedAt: at('2026-06-01T02:00:00Z'), branchId: 'branch-2', officerId: 'officer-2',
  } }, { rows: rowsOf(['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'], 200000, 20000) });

  const LD = await seedLoan(prisma, { key: 'LD', last: 'Нямаа', first: 'Анар', register: 'УБ90000004', phone: '99000004', productId: consumer.id, app: {
    contractNo: 'B10026LD', status: 'MIGRATED', currency: 'USD', amount: 3000, termMonths: 3, interestRate: 12, branchId: 'branch-1', officerId: 'officer-1',
  } }, { rows: rowsOf(['2026-09-15', '2026-10-15', '2026-11-15'], 1000, 100) });
  await createPayment(prisma, LD.app.id, { id: 'LD-1', paidAt: '2026-09-16T04:00:00Z', amount: 1100, currency: 'USD', provider: 'SOCIALPAY', allocations: [{ rowId: LD.rows[0].id, interest: 100, principal: 1000 }] });

  const LE = await seedLoan(prisma, { key: 'LE', last: 'Эрдэнэ', first: 'Ганаа', register: 'УБ90000005', phone: '99000005', productId: business.id, app: {
    contractNo: 'B10026LE', status: 'ACTIVE', amount: 500000, termMonths: 3, interestRate: 30, branchId: 'branch-1', officerId: 'officer-1',
  } }, { rows: rowsOf(['2026-11-05', '2026-12-05', '2027-01-05'], 150000, 8000), stale: true });

  const LF = await seedLoan(prisma, { key: 'LF', last: 'Оюун', first: 'Цэцэг', register: 'УБ90000006', phone: '99000006', productId: consumer.id, app: {
    contractNo: 'B10026LF', status: 'CLOSED', amount: 400000, termMonths: 4, interestRate: 24, disbursedAt: at('2026-05-20T02:00:00Z'), branchId: 'branch-1', officerId: 'officer-1', updatedAt: at('2026-10-01T04:00:00Z'),
  } }, { rows: rowsOf(['2026-06-20', '2026-07-20', '2026-08-20', '2026-09-20'], 100000, 10000) });
  await createPayment(prisma, LF.app.id, { id: 'LF-1', paidAt: '2026-08-25T03:00:00Z', amount: 330000, provider: 'QPAY', allocations: LF.rows.slice(0, 3).map((r) => ({ rowId: r.id, interest: 10000, principal: 100000 })) });
  await createPayment(prisma, LF.app.id, { id: 'LF-2', paidAt: '2026-09-20T05:00:00Z', amount: 110000, provider: 'BANK_TRANSFER', allocations: [{ rowId: LF.rows[3].id, interest: 10000, principal: 100000 }] });

  const LCL2 = await seedLoan(prisma, { key: 'LCL2', last: 'Пүрэв', first: 'Золоо', register: 'УБ90000007', phone: '99000007', productId: business.id, app: {
    contractNo: 'B10026CL2', status: 'CLOSED', amount: 100000, termMonths: 1, interestRate: 30, branchId: 'branch-2', officerId: 'officer-2', updatedAt: at('2026-08-15T05:00:00Z'),
  } });

  const LG = await seedLoan(prisma, { key: 'LG', last: 'Лхагва', first: 'Мөнх', register: 'УБ90000008', phone: '99000008', productId: consumer.id, app: {
    status: 'DRAFT', amount: 2000000, branchId: 'branch-2', officerId: 'officer-2', createdAt: at('2026-10-15T04:00:00Z'), updatedAt: at('2026-10-18T04:00:00Z'),
  } });
  const LH = await seedLoan(prisma, { key: 'LH', last: 'Хүрэл', first: 'Саруул', register: 'УБ90000009', phone: '99000009', productId: business.id, app: {
    status: 'SUBMITTED', amount: 3000000, branchId: 'branch-1', officerId: 'officer-1', updatedAt: at('2026-10-26T04:00:00Z'), submittedAt: at('2026-10-26T02:00:00Z'),
  } });
  const LI = await seedLoan(prisma, { key: 'LI', last: 'Идэр', first: 'Алтан', register: 'УБ90000010', phone: '99000010', productId: consumer.id, app: {
    status: 'RETURNED', amount: 1500000, branchId: 'branch-1', officerId: 'officer-1', updatedAt: at('2026-10-10T04:00:00Z'), submittedAt: at('2026-10-05T02:00:00Z'), returnedAt: at('2026-10-06T14:00:00Z'),
  } });
  const LJ = await seedLoan(prisma, { key: 'LJ', last: 'Жаргал', first: 'Баяр', register: 'УБ90000011', phone: '99000011', productId: business.id, app: {
    status: 'APPROVED', amount: 800000, branchId: 'branch-2', officerId: 'officer-2', updatedAt: at('2026-10-20T04:00:00Z'), submittedAt: at('2026-10-18T02:00:00Z'), approvedAt: at('2026-10-20T02:00:00Z'),
  } });
  const LK = await seedLoan(prisma, { key: 'LK', last: 'Хулан', first: 'Номин', register: 'УБ90000012', phone: '99000012', productId: consumer.id, app: {
    status: 'DISBURSING', amount: 700000, branchId: 'branch-1', officerId: 'officer-1', updatedAt: at('2026-10-27T04:00:00Z'),
  } });

  const LN = await seedLoan(prisma, { key: 'LN', last: 'Номин', first: 'Дулам', register: 'УБ90000013', phone: '99000013', productId: business.id, app: {
    contractNo: 'B10026LN', status: 'ACTIVE', amount: 250000, termMonths: 1, interestRate: 24, disbursedAt: at('2026-10-12T02:00:00Z'), branchId: 'branch-2', officerId: 'officer-2',
    submittedAt: at('2026-10-08T02:00:00Z'), approvedAt: at('2026-10-09T02:00:00Z'),
  } }, { rows: rowsOf(['2026-11-12'], 250000, 5000) });
  await createPayment(prisma, LN.app.id, { id: 'LN-1', paidAt: '2026-09-30T17:30:00Z', amount: 1000, provider: 'BANK_TRANSFER', unallocated: 1000 }); // UB: 2026-10-01 01:30

  // Явцын алхамууд: ACTIVE/CLOSED/MIGRATED бүгд 12/12; бусад нь дор
  for (const l of [LA, LB, LC, LD, LE, LF, LCL2, LN]) await createSteps(prisma, l.app.id, 'ALL_COMPLETED');
  await createSteps(prisma, LG.app.id, { client: 'COMPLETED', inquiry: 'PENDING', income: 'PENDING', loan: 'PENDING', collateral: 'PENDING', installment: 'PENDING', score: 'PENDING', document: 'PENDING', decision: 'PENDING' });
  await createSteps(prisma, LH.app.id, { client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', collateral: 'COMPLETED', installment: 'COMPLETED', score: 'STALE', document: 'PENDING', decision: 'PENDING' });
  await createSteps(prisma, LI.app.id, { client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', collateral: 'COMPLETED', installment: 'COMPLETED', score: 'COMPLETED', document: 'COMPLETED', decision: 'COMPLETED' });
  await createSteps(prisma, LJ.app.id, { client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', collateral: 'COMPLETED', installment: 'COMPLETED', score: 'COMPLETED', document: 'COMPLETED', decision: 'COMPLETED', contract: 'PENDING', official_documents: 'PENDING' });
  await createSteps(prisma, LK.app.id, { client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', collateral: 'COMPLETED', installment: 'COMPLETED', score: 'COMPLETED', document: 'COMPLETED', decision: 'COMPLETED', contract: 'COMPLETED', official_documents: 'COMPLETED', disburse: 'PENDING' });

  // Олголтын хүсэлтүүд (3 нь тооцогдохгүй: DRAFT, SUBMITTED)
  const disb = (applicationId: string, status: string, date: string, approved: number, amount: number, coreLoanId: string | null, o: Partial<Prisma.DisbursementRequestUncheckedCreateInput> = {}) =>
    prisma.disbursementRequest.create({ data: { orgId: ORG, applicationId, status, disburseDate: at(`${date}T00:00:00Z`), approvedAmount: approved, disburseAmount: amount, termMonths: 6, interestRate: 24, repaymentType: 'ANNUITY', coreLoanId, ...o } });
  await disb(LA.app.id, 'SENT_TO_CORE', '2026-07-05', 650000, 600000, 'CORE-LA');
  await disb(LB.app.id, 'SENT_TO_CORE', '2026-09-28', 300000, 300000, 'CORE-LB', { termMonths: 3 });
  await disb(LC.app.id, 'SENT_TO_CORE', '2026-06-01', 1000000, 1000000, 'CORE-LC', { termMonths: 5, interestRate: 36, repaymentType: 'EQUAL_PRINCIPAL' });
  await disb(LF.app.id, 'SENT_TO_CORE', '2026-05-20', 400000, 400000, 'CORE-LF', { termMonths: 4 });
  await disb(LN.app.id, 'APPROVED', '2026-10-12', 250000, 250000, null, { termMonths: 1 });
  await disb(LJ.app.id, 'DRAFT', '2026-10-20', 999999, 999999, null);
  await disb(LK.app.id, 'SUBMITTED', '2026-10-21', 888888, 888888, null);

  // Барьцаа
  const coOwner = await createCustomer(prisma, { lastName: 'Гомбо', firstName: 'Туяа', registerNo: 'УБ90000014' });
  const col = (applicationId: string, d: Partial<Prisma.CollateralUncheckedCreateInput>) => prisma.collateral.create({ data: { orgId: ORG, applicationId, kind: 'MOVABLE', assetType: 'VEHICLE', ...d } });
  const c1 = await col(LA.app.id, { ownerCustomerId: LA.customer.id, descriptionJson: { plate: '1234УБА', make: 'Toyota', model: 'Prius', year: 2018 }, marketValue: 1000000, haircutRate: 0.7, collateralValue: 700000, registryNo: 'ЭБ-001', registryDate: at('2025-01-15T00:00:00Z'), encumbranceStatus: 'CLEAR', insuranceExpiresAt: at('2026-11-10T00:00:00Z'), nextRevaluationAt: at('2027-06-01T00:00:00Z') });
  const c2 = await col(LA.app.id, { kind: 'IMMOVABLE', assetType: 'APARTMENT', ownerCustomerId: coOwner.id, descriptionJson: { address: 'БЗД, 3-р хороо', area_m2: 54, floor: 5 }, marketValue: 500000, haircutRate: 0.6, collateralValue: 300000, encumbranceStatus: 'ENCUMBERED', insuranceExpiresAt: at('2027-03-01T00:00:00Z'), nextRevaluationAt: at('2026-10-01T00:00:00Z') });
  const c3 = await col(LB.app.id, { assetType: 'LIVESTOCK', ownerCustomerId: LB.customer.id, descriptionJson: { livestock_type: 'Үхэр', head_count: 20 }, marketValue: 400000, haircutRate: 0.5, collateralValue: 200000 });
  const c4 = await col(LC.app.id, { kind: 'IMMOVABLE', assetType: 'APARTMENT', ownerCustomerId: LC.customer.id, descriptionJson: { address: 'СБД, 1-р хороо' }, marketValue: 2000000, haircutRate: 0.8, collateralValue: 1600000, insuranceExpiresAt: at('2026-11-05T00:00:00Z'), releasedAt: at('2026-10-01T03:00:00Z') });

  return { LA, LB, LC, LD, LE, LF, LCL2, LG, LH, LI, LJ, LK, LN, products: { consumer, business }, coOwner, collateral: { c1, c2, c3, c4 } };
}

/** Өөр байгууллагын (org-other) зээл — хэзээ ч харагдах ёсгүй. */
export async function seedOtherOrgLoan(prisma: PrismaService): Promise<LoanApplication> {
  const customer = await createCustomer(prisma, { orgId: OTHER_ORG, lastName: 'Гадны', firstName: 'Байгууллага', registerNo: 'УБ99999999' });
  const app = await createApplication(prisma, { ...BASE_TS, orgId: OTHER_ORG, appNo: 'APP-OTHER', contractNo: 'X-OTHER', status: 'ACTIVE', amount: 777777, branchId: 'branch-1', officerId: 'officer-1' });
  await prisma.loanApplicationBorrower.create({ data: { orgId: OTHER_ORG, applicationId: app.id, customerId: customer.id, role: 'PRIMARY', isPrimary: true } });
  await createExactSchedule(prisma, app.id, rowsOf(['2026-09-01', '2026-11-01'], 100000, 10000), { orgId: OTHER_ORG });
  return app;
}

/**
 * SQL-ээр олноор нь өгөгдөл үүсгэнэ (хуудаслалт, гүйцэтгэлийн тест). `n` ACTIVE/MIGRATED зээл (g % 10 = 0 → MIGRATED), салбар 3, ЗЭЗ 5,
 * тус бүр 12 мөртэй ЭТХ (эхний төлөх өдөр 2026-01-10 + g % 120 хоног → ихэнх нь хугацаа хэтэрсэн), g тэгш бол эхний 4 мөр төлөгдсөн,
 * 1 барьцаа, 1 олголт, 12 алхам. ID нь `bulk-*`.
 */
export async function seedBulkLoans(prisma: PrismaService, n: number): Promise<void> {
  const sql = Prisma.sql;
  const enc = encryptedField('УБ90000000');
  const steps = Prisma.join([...StepKey]);
  await prisma.$transaction([
    prisma.$executeRaw(sql`INSERT INTO origination.customer (id, org_id, register_no_hash, register_no_encrypted, customer_type, first_name, last_name, phone, is_related_party, is_pep, created_at, updated_at)
      SELECT 'bulk-cus-' || g, ${ORG}, 'bulk-hash-' || g, ${enc}, 'INDIVIDUAL', 'Нэр' || g, 'Овог' || g, '88' || lpad(g::text, 6, '0'), false, false, now(), now() FROM generate_series(1, ${n}::int) g`),
    prisma.$executeRaw(sql`INSERT INTO origination.loan_application (id, app_no, org_id, branch_id, officer_id, status, currency, amount, interest_rate, term_months, contract_no, disbursed_at, created_at, updated_at)
      SELECT 'bulk-app-' || g, 'BULK-' || lpad(g::text, 6, '0'), ${ORG}, 'branch-' || (1 + g % 3), 'officer-' || (1 + g % 5), CASE WHEN g % 10 = 0 THEN 'MIGRATED' ELSE 'ACTIVE' END, 'MNT', 1200000, 24, 12,
        'BULKC' || lpad(g::text, 6, '0'), timestamp '2026-01-10 02:00:00', timestamp '2026-01-05 02:00:00', timestamp '2026-10-20 04:00:00' FROM generate_series(1, ${n}::int) g`),
    prisma.$executeRaw(sql`INSERT INTO origination.loan_application_borrower (id, org_id, application_id, customer_id, role, is_primary, income_included, created_at, updated_at)
      SELECT 'bulk-b-' || g, ${ORG}, 'bulk-app-' || g, 'bulk-cus-' || g, 'PRIMARY', true, true, now(), now() FROM generate_series(1, ${n}::int) g`),
    prisma.$executeRaw(sql`INSERT INTO origination.repayment_schedule (id, org_id, application_id, params_json, generated_at, is_stale, created_at, updated_at)
      SELECT 'bulk-s-' || g, ${ORG}, 'bulk-app-' || g, '{}'::jsonb, now(), false, now(), now() FROM generate_series(1, ${n}::int) g`),
    prisma.$executeRaw(sql`INSERT INTO origination.repayment_schedule_row (id, schedule_id, seq, due_date, days, disbursement, principal, interest, total, balance)
      SELECT 'bulk-r-' || g || '-' || s, 'bulk-s-' || g, s, (date '2026-01-10' + (g % 120) + ((s - 1) * 30)), 30, 0, 100000, 20000, 120000, 1200000 - 100000 * s
      FROM generate_series(1, ${n}::int) g, generate_series(1, 12) s`),
    prisma.$executeRaw(sql`INSERT INTO origination.payment (id, org_id, application_id, provider, provider_payment_id, amount, currency, paid_at, unallocated_amount, created_at)
      SELECT 'bulk-p-' || g, ${ORG}, 'bulk-app-' || g, 'BANK_TRANSFER', 'BULKPAY-' || g, 480000, 'MNT', timestamp '2026-09-01 04:00:00', 0, now() FROM generate_series(1, ${n}::int) g WHERE g % 2 = 0`),
    prisma.$executeRaw(sql`INSERT INTO origination.payment_allocation (id, payment_id, schedule_row_id, interest_paid, principal_paid, total_paid)
      SELECT 'bulk-a-' || g || '-' || s, 'bulk-p-' || g, 'bulk-r-' || g || '-' || s, 20000, 100000, 120000 FROM generate_series(1, ${n}::int) g, generate_series(1, 4) s WHERE g % 2 = 0`),
    prisma.$executeRaw(sql`INSERT INTO origination.collateral (id, org_id, application_id, kind, asset_type, source, market_value, haircut_rate, collateral_value, insurance_expires_at, created_at, updated_at)
      SELECT 'bulk-c-' || g, ${ORG}, 'bulk-app-' || g, 'MOVABLE', 'VEHICLE', 'MANUAL', 2000000, 0.7, 1400000, date '2026-11-10' + (g % 90), now(), now() FROM generate_series(1, ${n}::int) g`),
    prisma.$executeRaw(sql`INSERT INTO origination.disbursement_request (id, org_id, application_id, approved_amount, disburse_amount, term_months, interest_rate, repayment_type, disburse_date, status, core_loan_id, created_at, updated_at)
      SELECT 'bulk-d-' || g, ${ORG}, 'bulk-app-' || g, 1200000, 1200000, 12, 24, 'ANNUITY', date '2026-01-10' + (g % 280), 'SENT_TO_CORE', 'CORE-' || g, now(), now() FROM generate_series(1, ${n}::int) g`),
    prisma.$executeRaw(sql`INSERT INTO origination.loan_application_step (id, org_id, application_id, step_key, status, created_at, updated_at)
      SELECT 'bulk-st-' || g || '-' || k.key, ${ORG}, 'bulk-app-' || g, k.key, CASE WHEN g % 7 = 0 AND k.key = 'disburse' THEN 'PENDING' ELSE 'COMPLETED' END, now(), now()
      FROM generate_series(1, ${n}::int) g, unnest(ARRAY[${steps}]::text[]) AS k(key)`),
  ]);
  await prisma.$executeRawUnsafe('ANALYZE');
}
