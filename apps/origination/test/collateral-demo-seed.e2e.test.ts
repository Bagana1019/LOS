import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED, blindIndex, decryptedField } from '@los/database';
import { StepKey } from '@los/contracts';
import { DEMO_APP_NO, DEMO_IDS, DEMO_REGISTER_NO, seedDemoCollateral } from '../prisma/seeds/demo-collateral';
import { createCustomer, hasTestDb, resetDb } from '../src/test-utils/factories';
import { bootCollateralKit, collateralApi, stepOf, url, vehicleInfo, type CollateralKit } from '../src/modules/collateral/testing/collateral-test-kit';

// Модуль 6 demo seed (`SEED_DEMO=1`): idempotent, docs/01 §2.2-т нийцсэн алхмууд, мөн API-аар G0 хүртэл бүрдүүлж болно.
describe.skipIf(!hasTestDb)('collateral demo seed (DB)', () => {
  let k: CollateralKit;
  const prisma = () => k.t.prisma;
  const { post, get, mutation } = collateralApi(() => k);

  beforeAll(async () => { k = await bootCollateralKit(); });
  afterAll(async () => { await resetDb(prisma()); await k.close(); });
  beforeEach(async () => {
    await resetDb(prisma());
    k.kyc.reset(); k.valuation.reset(); k.files.reset();
  });

  it('ноорог хүсэлт: VEHICLE бүтээгдэхүүн, 20,000,000 / 36 сар, ЗЭЗ А, Төв салбар; PRIMARY зээлдэгчийн регистр шифрлэгдсэн', async () => {
    const result = await seedDemoCollateral(prisma(), SEED.org.id);
    expect(result).toEqual({ created: true, applicationId: DEMO_IDS.application, customerId: DEMO_IDS.customer });

    const app = await prisma().loanApplication.findUniqueOrThrow({ where: { id: DEMO_IDS.application }, include: { borrowers: true } });
    expect(app).toMatchObject({ appNo: DEMO_APP_NO, orgId: SEED.org.id, status: 'DRAFT', productId: SEED.products.vehicle, termMonths: 36, officerId: SEED.users.officerA.id, branchId: SEED.branches.head.id });
    expect(Number(app.amount)).toBe(20_000_000);
    expect(app.borrowers.map((b) => [b.customerId, b.role, b.isPrimary])).toEqual([[DEMO_IDS.customer, 'PRIMARY', true]]);

    const customer = await prisma().customer.findUniqueOrThrow({ where: { id: DEMO_IDS.customer } });
    expect(customer.registerNoHash).toBe(blindIndex(DEMO_REGISTER_NO));
    expect(decryptedField(customer.registerNoEncrypted)).toBe(DEMO_REGISTER_NO);
    expect(customer.registerNoEncrypted).not.toContain(DEMO_REGISTER_NO);
    expect(DEMO_REGISTER_NO).toBe('УЕ00000001');
  });

  it('12 алхам: 1-4 бүрдсэн, барьцаа..шийдвэр хүлээгдэж буй, 2-р үе шат цоожтой', async () => {
    await seedDemoCollateral(prisma(), SEED.org.id);
    const steps = await prisma().loanApplicationStep.findMany({ where: { applicationId: DEMO_IDS.application } });
    expect(steps).toHaveLength(12);
    const status = Object.fromEntries(steps.map((s) => [s.stepKey, s.status]));
    expect(status).toEqual({
      client: 'COMPLETED', inquiry: 'COMPLETED', income: 'COMPLETED', loan: 'COMPLETED', collateral: 'PENDING', installment: 'PENDING', score: 'PENDING', document: 'PENDING', decision: 'PENDING',
      contract: 'LOCKED', official_documents: 'LOCKED', disburse: 'LOCKED',
    });
    expect(Object.keys(status).sort()).toEqual([...StepKey].sort());
    expect(steps.filter((s) => s.status === 'COMPLETED').every((s) => s.completedAt != null)).toBe(true);
  });

  it('давтан ажиллуулахад юу ч нэмэгдэхгүй, хэрэглэгчийн өөрчлөлтийг дарахгүй', async () => {
    await seedDemoCollateral(prisma(), SEED.org.id);
    await prisma().loanApplication.update({ where: { id: DEMO_IDS.application }, data: { amount: 25_000_000 } });
    await prisma().loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: DEMO_IDS.application, stepKey: 'collateral' } }, data: { status: 'COMPLETED' } });
    const again = await seedDemoCollateral(prisma(), SEED.org.id);
    expect(again.created).toBe(false);
    expect(await prisma().loanApplication.count()).toBe(1);
    expect(await prisma().customer.count()).toBe(1);
    expect(await prisma().loanApplicationBorrower.count()).toBe(1);
    expect(await prisma().loanApplicationStep.count()).toBe(12);
    expect(Number((await prisma().loanApplication.findUniqueOrThrow({ where: { id: DEMO_IDS.application } })).amount)).toBe(25_000_000);
    expect((await stepOf(prisma(), DEMO_IDS.application, 'collateral')).status).toBe('COMPLETED');
  });

  it('регистр өөр замаар бүртгэгдсэн байвал тэр харилцагчийг дахин ашиглана (давхар үүсгэхгүй)', async () => {
    const existing = await createCustomer(prisma(), { orgId: SEED.org.id, registerNo: DEMO_REGISTER_NO });
    const result = await seedDemoCollateral(prisma(), SEED.org.id);
    expect(result.customerId).toBe(existing.id);
    expect(await prisma().customer.count()).toBe(1);
    expect((await prisma().loanApplicationBorrower.findFirstOrThrow({ where: { applicationId: DEMO_IDS.application } })).customerId).toBe(existing.id);
  });

  it('demo хүсэлтийг API-аар G0 хүртэл бүрдүүлж болно (ХУР -> нэмэх -> өмчлөл -> ачаалал -> үнэлгээ -> баримт); 5-р алхам COMPLETED', async () => {
    await seedDemoCollateral(prisma(), SEED.org.id);
    // seed-ийн байгууллага, ЗЭЗ А, Төв салбар
    const as = { 'x-user-id': SEED.users.officerA.id, 'x-roles': 'OFFICER', 'x-branch-id': SEED.branches.head.id, 'x-org-id': SEED.org.id };
    const appId = DEMO_IDS.application;
    const ownerId = DEMO_IDS.customer;
    k.kyc.assets.set(DEMO_REGISTER_NO, { properties: [], vehicles: [{ plateNo: 'УЕН5246', vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: null, engineCc: 1800, fuelType: 'HYBRID', color: null }], fetchedAt: new Date().toISOString() });
    k.valuation.vehicles.set('УЕН5246', vehicleInfo('УЕН5246', { registerNo: DEMO_REGISTER_NO, name: 'Жишээ Бат-Эрдэнэ' }));
    k.valuation.defaultSuggestion = 60_000_000; // 60,000,000 x 0.7 = 42,000,000 -> LTV 20/42 = 47.6%

    const candidates = await get(`${url(appId, 'xyp-assets')}?ownerCustomerId=${ownerId}`, as);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.items).toHaveLength(1);
    const created = mutation(await post(url(appId), { assetType: 'VEHICLE', ownerCustomerId: ownerId, source: 'XYP', xypRef: 'УЕН5246', description: candidates.body.items[0].description }, as), 201);
    const cid = created.collateral.id;
    expect(created.gate.complete).toBe(false);
    expect(mutation(await post(url(appId, cid, 'ownership-check'), { method: 'REGISTRY' }, as)).collateral.ownership?.status).toBe('VERIFIED');
    expect(mutation(await post(url(appId, cid, 'encumbrance-check'), { method: 'REGISTRY' }, as)).collateral.encumbrance?.status).toBe('CLEAR');
    const valued = mutation(await post(url(appId, cid, 'valuation'), { mileageKm: 80_000 }, as));
    expect(valued.summary).toMatchObject({ loanAmount: 20_000_000, totalCollateralValue: 42_000_000, ltvPass: true });
    let last = valued;
    for (const [i, key] of ['vehicle_certificate', 'traffic_registry_extract', 'insurance'].entries()) {
      const fileId = `99999999-9999-4999-8999-99999999999${i}`;
      k.files.add({ id: fileId, name: `${key}.pdf` });
      last = mutation(await post(url(appId, cid, 'documents'), { checklistKey: key, fileId }, as), 201);
    }
    expect(last.gate).toMatchObject({ complete: true, issues: [] });
    expect((await stepOf(prisma(), appId, 'collateral')).status).toBe('COMPLETED');
  });
});
