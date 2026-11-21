import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DecisionView } from '@los/contracts';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { ApprovalModule } from './approval.module';

// F3-1: батлагч шийдвэрийн хуудаснаас эрсдэлийн үзүүлэлтийг (ӨОХ/ӨТЧХ, LTV, Sosco, барьцаа, орлого, анхааруулга) харах ёстой.
// Хуудас зөвхөн ХАДГАЛАГДСАН үр дүнг уншина: `calc_snapshot_json` (тооцоолол), барьцааны модуль, `income_summary`.
describe.skipIf(!hasTestDb)('decision page risk summary (DB)', () => {
  let t: TestApp;
  let productId: string;
  const http = () => request(t.app.getHttpServer());
  const officer = actors.officer('officer-1');
  const bm = actors.branchManager('bm-1');
  const AT = '2026-11-20T03:00:00.000Z';

  const SNAPSHOT = {
    calculationId: 'calc-1', selectedMethod: 'A_SALARY', selection: 'AUTO', ratioKind: 'DTI', ratio: 0.4321, limit: 0.55, pass: true, eligible: true, ltv: 0.0625,
    soscoScore: 712, soscoGrade: 'B', computedAt: AT, syncedAt: AT,
  };

  beforeAll(async () => {
    process.env.NOTIFICATION_QUEUE = 'inline';
    process.env.NOTIFICATION_SWEEP = 'off';
    t = await createTestApp([ApprovalModule]);
  });
  afterAll(async () => {
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await resetDb(t.prisma);
    await t.prisma.product.deleteMany({ where: { orgId: ORG } });
    await t.close();
  });
  beforeEach(async () => {
    await t.prisma.approvalLevel.deleteMany({ where: { orgId: ORG } });
    await resetDb(t.prisma);
    productId = (await t.prisma.product.create({ data: { orgId: ORG, code: 'F31', name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 500_000_000, minTerm: 1, maxTerm: 36, minRate: 10, maxRate: 40 } })).id;
    await t.prisma.approvalLevel.create({ data: { orgId: ORG, productId, levelNo: 1, name: 'Салбар', amountFrom: 0, amountTo: null, slaHours: 24, members: { create: [{ orgId: ORG, userId: 'bm-1' }] } } });
    t.clock.set(new Date('2026-11-21T02:00:00Z'));
  });

  const view = async (appId: string, actor: Record<string, string> = bm) => DecisionView.parse((await http().get(`/api/applications/${appId}/decision`).set(actor).expect(200)).body);

  /** Батлах шатанд буй хүсэлт (approval.start-ийн үр дүнтэй ижил): 1 түвшин, идэвхтэй. `snapshot: null` → тооцоолол хадгалагдаагүй. */
  async function inApproval(o: { snapshot?: Record<string, unknown> | null; scoreStep?: { status: string; staleReason?: string } } = {}) {
    const customer = await createCustomer(t.prisma);
    const app = await createApplication(t.prisma, {
      productId, amount: 5_000_000, status: 'IN_APPROVAL', officerId: 'officer-1', createdBy: 'officer-1',
      calcSnapshotJson: (o.snapshot === undefined ? SNAPSHOT : o.snapshot) as never, selectedCalcMethod: o.snapshot === null ? null : 'A_SALARY',
    });
    await createBorrower(t.prisma, app.id, customer.id, 'PRIMARY');
    const keys = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score', 'document'];
    await t.prisma.loanApplicationStep.createMany({
      data: keys.map((stepKey) => (stepKey === 'score' && o.scoreStep
        ? { orgId: ORG, applicationId: app.id, stepKey, status: o.scoreStep.status, staleReason: o.scoreStep.staleReason ?? null }
        : { orgId: ORG, applicationId: app.id, stepKey, status: 'COMPLETED' })),
    });
    await t.prisma.approvalRequest.create({ data: { orgId: ORG, applicationId: app.id, version: app.version, levelNo: 1, startedAt: t.clock.now(), dueAt: new Date(t.clock.now().getTime() + 86_400_000) } });
    return { app, customer };
  }
  const addIncome = (appId: string, customerId: string, o: { salary?: number; ncf?: number; expense?: number } = {}) =>
    t.prisma.incomeSummary.create({ data: { orgId: ORG, applicationId: appId, customerId, avgSalaryMonthly: o.salary ?? 2_500_000, businessNcfMonthly: o.ncf ?? 300_000, householdExpenseMonthly: o.expense ?? 400_000 } });
  const addCollateral = (appId: string, o: { valued?: boolean; marketValue?: number; collateralValue?: number } = {}) =>
    t.prisma.collateral.create({
      data: {
        orgId: ORG, applicationId: appId, kind: 'IMMOVABLE', assetType: 'APARTMENT', marketValue: o.marketValue ?? 100_000_000, haircutRate: 0.8, collateralValue: o.collateralValue ?? 80_000_000,
        ...(o.valued === false ? {} : { valuationId: 'val-1', valuationSource: 'INTERNAL', valuedAt: new Date('2026-11-10T00:00:00Z'), valuationValidUntil: new Date('2027-05-10T00:00:00Z') }),
      },
    });

  it('батлагч хадгалагдсан үзүүлэлтүүдийг харна: арга, ӨОХ, LTV, Sosco, барьцаа, орлого', async () => {
    const { app, customer } = await inApproval();
    await addIncome(app.id, customer.id);
    await addCollateral(app.id);
    const v = await view(app.id);
    expect(v.canVote).toBe(true);
    expect(v.summary.risk).toMatchObject({
      method: 'A_SALARY', selection: 'AUTO', computedAt: AT, stale: false,
      ratio: { kind: 'DTI', value: 0.4321, limit: 0.55, pass: true },
      ltv: { value: 0.0625, limit: 0.7, pass: true }, // 5,000,000 ÷ 80,000,000 — барьцааны модулийн LTV
      sosco: { score: 712, grade: 'B' },
      collateral: { count: 1, totalValue: 80_000_000, required: true },
      income: { salaryMonthly: 2_500_000, businessNcfMonthly: 300_000, householdExpenseMonthly: 400_000 },
    });
    expect(v.summary).toMatchObject({ amount: 5_000_000, collateralCount: 1, selectedMethod: 'A_SALARY' }); // одоо байгаа талбарууд хэвээр
  });

  it('зээлдэгчийн орлого нь орлогод оруулсан хамтран зээлдэгчийнхтэй нийлнэ; оруулаагүй/батлан даагчийнх орохгүй', async () => {
    const { app, customer } = await inApproval();
    await addIncome(app.id, customer.id, { salary: 2_000_000, ncf: 0, expense: 300_000 });
    const co = await createCustomer(t.prisma);
    await createBorrower(t.prisma, app.id, co.id, 'CO_BORROWER', { incomeIncluded: true });
    await addIncome(app.id, co.id, { salary: 1_000_000, ncf: 100_000, expense: 999 });
    const guarantor = await createCustomer(t.prisma);
    await createBorrower(t.prisma, app.id, guarantor.id, 'GUARANTOR');
    await addIncome(app.id, guarantor.id, { salary: 7_000_000, ncf: 0, expense: 0 });
    const income = (await view(app.id)).summary.risk?.income;
    expect(income).toEqual({ salaryMonthly: 3_000_000, businessNcfMonthly: 100_000, householdExpenseMonthly: 300_000 });
  });

  it('тооцоолол хадгалагдаагүй бол risk = null (бусад хураангуй талбар хэвээр)', async () => {
    const { app } = await inApproval({ snapshot: null });
    const v = await view(app.id);
    expect(v.summary.risk).toBeNull();
    expect(v.summary).toMatchObject({ amount: 5_000_000, selectedMethod: null, collateralCount: 0 });
  });

  it('ӨОХ хязгаараас хэтэрсэн тооцоолол: ratio.pass=false ба DTI_ABOVE_LIMIT error анхааруулга', async () => {
    const { app } = await inApproval({ snapshot: { ...SNAPSHOT, ratio: 0.61, pass: false, eligible: false } });
    const risk = (await view(app.id)).summary.risk;
    expect(risk?.ratio).toEqual({ kind: 'DTI', value: 0.61, limit: 0.55, pass: false });
    expect(risk?.flags).toContainEqual({ code: 'DTI_ABOVE_LIMIT', level: 'error', message: expect.any(String) });
  });

  it('score алхам хуучирсан бол stale=true ба CALCULATION_STALE анхааруулга', async () => {
    const { app } = await inApproval({ scoreStep: { status: 'STALE', staleReason: 'Дүн өөрчлөгдсөн' } });
    const risk = (await view(app.id)).summary.risk;
    expect(risk?.stale).toBe(true);
    expect(risk?.flags).toContainEqual({ code: 'CALCULATION_STALE', level: 'warning', message: expect.stringContaining('Дүн өөрчлөгдсөн') });
  });

  it('үнэлээгүй барьцаа: барьцааны модулийн G0 issue (NOT_VALUED) анхааруулга болж харагдана; LTV тооцогдохгүй', async () => {
    const { app } = await inApproval();
    await addCollateral(app.id, { valued: false });
    const risk = (await view(app.id)).summary.risk;
    expect(risk?.collateral.count).toBe(1);
    expect(risk?.ltv.value).toBeNull();
    expect(risk?.flags.map((f) => f.code)).toContain('NOT_VALUED');
  });

  it('ЗЭЗ (хүсэлтийг үүсгэсэн) ч мөн адил харна; өөр салбарын ажилтан хандаж чадахгүй (эрх хэвээр)', async () => {
    const { app } = await inApproval();
    expect((await view(app.id, officer)).summary.risk?.method).toBe('A_SALARY');
    // The error body echoes the correlation id. A random UUID contains "712" by chance (~0.7%), which made this test flaky in CI:
    // send an id that DOES contain it so the check below only passes if the risk score itself is absent from the payload.
    const outsider = await http().get(`/api/applications/${app.id}/decision`).set(actors.officer('officer-9', 'branch-2')).set('X-Correlation-Id', 'corr-7120-outsider');
    expect([403, 404]).toContain(outsider.status);
    expect(JSON.stringify({ ...outsider.body, correlationId: undefined })).not.toContain('712');
  });
});
