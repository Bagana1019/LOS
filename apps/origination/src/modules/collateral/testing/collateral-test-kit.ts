import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { expect } from 'vitest';
import { CollateralChanged, CollateralMutationResponse, StepKey, type VehicleInfo, type XypPropertyAsset } from '@los/contracts';
import type { Customer, LoanApplication, Product } from '.prisma/client-origination';
import { actors, createApplication, createBorrower, createCustomer, nextSeq, ORG } from '../../../test-utils/factories';
import { createTestApp, type TestApp } from '../../../test-utils/test-app';
import type { PrismaService } from '../../../prisma.service';
import { CollateralModule } from '../collateral.module';
import { FILE_PORT } from '../ports/file.port';
import { KYC_ASSETS_PORT } from '../ports/kyc-assets.port';
import { VALUATION_PORT } from '../ports/valuation.port';
import { FakeFilePort } from './fake-file.port';
import { FakeKycAssetsPort } from './fake-kyc-assets.port';
import { FakeValuationPort } from './fake-valuation.port';

// Модуль 6-ийн DB-тэй тестүүдийн нийтлэг бэлтгэл: гурван порт нь fake, бусад нь бодит (Postgres, in-memory bus). Зөвхөн тестэд.

export interface CollateralKit {
  t: TestApp;
  kyc: FakeKycAssetsPort;
  valuation: FakeValuationPort;
  files: FakeFilePort;
  baseUrl: string;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function bootCollateralKit(now?: string): Promise<CollateralKit> {
  const kyc = new FakeKycAssetsPort();
  const valuation = new FakeValuationPort();
  const files = new FakeFilePort();
  const t = await createTestApp(
    [CollateralModule],
    (b) => b.overrideProvider(KYC_ASSETS_PORT).useValue(kyc).overrideProvider(VALUATION_PORT).useValue(valuation).overrideProvider(FILE_PORT).useValue(files),
    now,
  );
  // Зэрэгцээ хүсэлтийн тестэд supertest-ийн хүсэлт бүр сервер асаахгүйн тулд нэг удаа ephemeral порт дээр
  await t.app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  // fake-ууд clock-оо тестийн FixedClock-оос авна (valuedAt, checkedAt)
  kyc.now = () => t.clock.now();
  valuation.now = () => t.clock.now();
  return { t, kyc, valuation, files, baseUrl, http: () => request(baseUrl), close: () => t.close() };
}

export const url = (applicationId: string, ...rest: string[]): string => ['/api/applications', applicationId, 'collaterals', ...rest].join('/');
export { actors };

export const CHECKLIST = {
  VEHICLE: ['vehicle_certificate', 'traffic_registry_extract', 'insurance'],
  APARTMENT: ['ownership_certificate', 'cadastral_plan', 'registry_extract'],
  EQUIPMENT: ['purchase_invoice'],
};

export async function createProduct(prisma: PrismaService, over: Partial<Parameters<PrismaService['product']['create']>[0]['data']> = {}): Promise<Product> {
  const n = nextSeq();
  return prisma.product.create({
    data: {
      orgId: ORG, code: `VEH${n}`, name: 'Автомашины зээл', productType: 'CONSUMER', minAmount: 1_000_000, maxAmount: 500_000_000, minTerm: 3, maxTerm: 60, minRate: 12, maxRate: 36,
      requiresCollateral: true, maxLtv: 0.7, externalValuationThreshold: 100_000_000, collateralChecklistJson: CHECKLIST, haircutJson: { VEHICLE: 0.7, APARTMENT: 0.8, EQUIPMENT: 0.6 },
      ...over,
    } as never,
  });
}

export const vehicleInfo = (plateNo: string, owner: { registerNo: string; name: string }): VehicleInfo => ({
  plateNo, vin: null, make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: 2018, engineCc: 1800, fuelType: 'HYBRID', color: 'Цагаан', owner, registeredAt: '2018-05-01',
});

export const vehicleDescription = (plateNo = '1234УБА') => ({ plateNo, make: 'Toyota', model: 'Prius', manufactureYear: 2015, importYear: 2018, mileageKm: 90_000, fuelType: 'HYBRID' as const });
export const apartmentDescription = (propertyId = 'P-001') => ({ propertyId, address: { province: 'Улаанбаатар', district: 'СБД', khoroo: '1-р хороо' }, areaM2: 54.5, floor: 4, totalFloors: 9, rooms: 2 });

export const REGISTER = 'УЕ00000001';

export interface Scenario {
  app: LoanApplication;
  product: Product;
  owner: Customer;
}

/** DRAFT хүсэлт (зээл 10,000,000), PRIMARY зээлдэгч, 12 алхам (client..loan COMPLETED, collateral PENDING, бусад LOCKED). */
export async function seedScenario(prisma: PrismaService, o: { amount?: number; status?: string; productOver?: Parameters<typeof createProduct>[1]; officerId?: string; branchId?: string; withSteps?: boolean; registerNo?: string; product?: Product } = {}): Promise<Scenario> {
  const product = o.product ?? (await createProduct(prisma, o.productOver));
  const owner = await createCustomer(prisma, { registerNo: o.registerNo ?? REGISTER, lastName: 'Бат', firstName: 'Болд' });
  const app = await createApplication(prisma, {
    productId: product.id, amount: o.amount ?? 10_000_000, termMonths: 12, status: o.status ?? 'DRAFT', ...(o.officerId ? { officerId: o.officerId } : {}), ...(o.branchId ? { branchId: o.branchId } : {}),
  });
  await createBorrower(prisma, app.id, owner.id, 'PRIMARY');
  if (o.withSteps !== false) await seedSteps(prisma, app.id);
  return { app, product, owner };
}

const DONE_STEPS = new Set(['client', 'inquiry', 'income', 'loan']);
export async function seedSteps(prisma: PrismaService, applicationId: string, override: Partial<Record<StepKey, string>> = {}): Promise<void> {
  await prisma.loanApplicationStep.createMany({
    data: StepKey.map((stepKey) => {
      const status = override[stepKey] ?? (DONE_STEPS.has(stepKey) ? 'COMPLETED' : stepKey === 'collateral' ? 'PENDING' : 'LOCKED');
      return { orgId: ORG, applicationId, stepKey, status, ...(status === 'COMPLETED' ? { completedAt: new Date('2026-10-01T00:00:00Z') } : {}) };
    }),
  });
}

export const stepOf = (prisma: PrismaService, applicationId: string, key: StepKey) => prisma.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId, stepKey: key } } });

export const apartmentProperty = (propertyId: string, owners: Array<{ registerNo: string; name: string }>): XypPropertyAsset => ({
  propertyId, certificateNo: `GER-${propertyId}`, assetType: 'APARTMENT', address: { province: 'Улаанбаатар', district: 'СБД', khoroo: '1-р хороо' } as never, areaM2: 54.5, floor: 4, totalFloors: 9, rooms: 2,
  buildYear: 2012, purpose: 'RESIDENTIAL', landUse: null, owners: owners.map((o) => ({ ...o, sharePercent: null })),
});

/**
 * HTTP туслахууд (тест бүрийн файлд давтахгүйн тулд). `kit` нь `beforeAll`-д үүсэх тул getter-ээр дамжуулна.
 * Бүх helper нь амжилтыг (`expect`) шалгаж, хариуг гэрээний схемээр parse хийнэ.
 */
export function collateralApi(kit: () => CollateralKit) {
  const prisma = () => kit().t.prisma;
  const officer = actors.officer();
  const post = (path: string, body: unknown = {}, actor: Record<string, string> = officer) => kit().http().post(path).set(actor).send(body as object);
  const get = (path: string, actor: Record<string, string> = officer) => kit().http().get(path).set(actor);
  const patch = (path: string, body: unknown, actor: Record<string, string> = officer) => kit().http().patch(path).set(actor).send(body as object);
  const del = (path: string, actor: Record<string, string> = officer) => kit().http().delete(path).set(actor);
  const ok = <T>(res: { status: number; body: unknown }, expected: number, parse: (b: unknown) => T): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return parse(res.body);
  };
  const mutation = (res: { status: number; body: unknown }, expected = 200) => ok(res, expected, (b) => CollateralMutationResponse.parse(b));
  const codes = (r: { gate: { issues: Array<{ code: string }> } }): string[] => r.gate.issues.map((i) => i.code);

  const registerVehicle = (plate = '1234УБА', registerNo = REGISTER) => kit().valuation.vehicles.set(plate, vehicleInfo(plate, { registerNo, name: 'Бат Болд' }));
  async function addVehicle(s: Scenario, plate = '1234УБА', over: Record<string, unknown> = {}) {
    return mutation(await post(url(s.app.id), { assetType: 'VEHICLE', ownerCustomerId: s.owner.id, description: vehicleDescription(plate), ...over }), 201).collateral;
  }
  const verifyOwnership = async (s: Scenario, cid: string) => mutation(await post(url(s.app.id, cid, 'ownership-check'), { method: 'REGISTRY' }));
  const checkEncumbrance = async (s: Scenario, cid: string) => mutation(await post(url(s.app.id, cid, 'encumbrance-check'), { method: 'REGISTRY' }));
  const value = async (s: Scenario, cid: string, body: Record<string, unknown> = {}) => mutation(await post(url(s.app.id, cid, 'valuation'), body));
  let fileSeq = 0;
  async function attachAll(s: Scenario, cid: string, keys: string[]) {
    let last = null as unknown as ReturnType<typeof mutation>;
    for (const key of keys) {
      const id = `00000000-0000-4000-8000-${String(++fileSeq).padStart(12, '0')}`;
      kit().files.add({ id, name: `${key}.pdf` });
      last = mutation(await post(url(s.app.id, cid, 'documents'), { checklistKey: key, fileId: id }), 201);
    }
    return last;
  }
  const events = async () => (await prisma().outbox.findMany({ orderBy: { createdAt: 'asc' } })).filter((r) => r.type === 'CollateralChanged').map((r) => CollateralChanged.parse(r.payload));
  const audits = (entity = 'COLLATERAL') => prisma().auditLog.findMany({ where: { entity }, orderBy: { at: 'asc' } });

  /** Бүрэн замаар G0-г хангана (автомашин: өмчлөл, ачаалал, үнэлгээ, 3 баримт). */
  async function completeVehicle(s: Scenario, plate = '1234УБА') {
    registerVehicle(plate);
    const c = await addVehicle(s, plate);
    await verifyOwnership(s, c.id);
    await checkEncumbrance(s, c.id);
    await value(s, c.id);
    return attachAll(s, c.id, ['vehicle_certificate', 'traffic_registry_extract', 'insurance']);
  }
  return { officer, prisma, post, get, patch, del, ok, mutation, codes, registerVehicle, addVehicle, verifyOwnership, checkEncumbrance, value, attachAll, events, audits, completeVehicle };
}
