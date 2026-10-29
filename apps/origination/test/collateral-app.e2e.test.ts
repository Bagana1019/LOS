import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED } from '@los/database';
import { CollateralListResponse, CollateralMutationResponse } from '@los/contracts';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { CollateralGateService } from '../src/modules/collateral/collateral-gate.service';
import { FILE_PORT, HttpFilePort } from '../src/modules/collateral/ports/file.port';
import { HttpKycAssetsPort, KYC_ASSETS_PORT } from '../src/modules/collateral/ports/kyc-assets.port';
import { HttpValuationPort, VALUATION_PORT } from '../src/modules/collateral/ports/valuation.port';
import { DEMO_IDS, seedDemoCollateral } from '../prisma/seeds/demo-collateral';
import { hasTestDb, resetDb } from '../src/test-utils/factories';
import { as } from './app';

// Модуль 6 · production wiring: AppModule + бодит HTTP портууд (kyc хүрэх боломжгүй). Fake-гүй - DI, route, алдааны зам.
describe.skipIf(!hasTestDb)('collateral in AppModule (DB)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const http = () => request(app.getHttpServer());
  const list = (who: Parameters<typeof as>[0] = 'officerA') => http().get(`/api/applications/${DEMO_IDS.application}/collaterals`).set(as(who));

  beforeAll(async () => {
    process.env.KYC_URL = 'http://127.0.0.1:9'; // discard порт: холболт татгалзана
    process.env.VALUATION_URL = 'http://127.0.0.1:9';
    process.env.DMS_URL = 'http://127.0.0.1:9';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);
  });
  afterAll(async () => { await resetDb(db); await app.close(); });
  beforeEach(async () => {
    await resetDb(db);
    await seedDemoCollateral(db, SEED.org.id);
  });

  it('DI: портуудад бодит HTTP хэрэгжилт, G0 үйлчилгээ Модуль 10-д экспортлогдсон', () => {
    expect(app.get(KYC_ASSETS_PORT)).toBeInstanceOf(HttpKycAssetsPort);
    expect(app.get(VALUATION_PORT)).toBeInstanceOf(HttpValuationPort);
    expect(app.get(FILE_PORT)).toBeInstanceOf(HttpFilePort);
    expect(app.get(CollateralGateService, { strict: false })).toBeInstanceOf(CollateralGateService);
  });

  it('нэвтрээгүй -> 401; өөр ЗЭЗ -> 403; өөрийн ЗЭЗ -> 200 (барьцаагүй: NO_COLLATERAL)', async () => {
    expect((await http().get(`/api/applications/${DEMO_IDS.application}/collaterals`)).status).toBe(401);
    expect((await list('officerB')).status).toBe(403);
    const res = await list();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = CollateralListResponse.parse(res.body);
    expect(body.gate.issues.map((i) => i.code)).toEqual(['NO_COLLATERAL']);
    expect(body.summary).toMatchObject({ requiresCollateral: true, loanAmount: 20_000_000, ltvLimit: 0.7, count: 0 });
  });

  it('гар аргаар (бүртгэлгүй) барьцаа нэмэх, засах, устгах: outbox-д CollateralChanged, 5-р алхам PENDING', async () => {
    const created = await http().post(`/api/applications/${DEMO_IDS.application}/collaterals`).set(as('officerA'))
      .send({ assetType: 'EQUIPMENT', ownerCustomerId: DEMO_IDS.customer, description: { name: 'Станок', serialNo: 'SN-1' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const cid = CollateralMutationResponse.parse(created.body).collateral.id;
    const patched = await http().patch(`/api/applications/${DEMO_IDS.application}/collaterals/${cid}`).set(as('officerA')).send({ note: 'Шинэ' });
    expect(patched.status).toBe(200);
    expect((await http().delete(`/api/applications/${DEMO_IDS.application}/collaterals/${cid}`).set(as('officerA'))).status).toBe(204);
    const outbox = await db.outbox.findMany({ where: { type: 'CollateralChanged' }, orderBy: { createdAt: 'asc' } });
    expect(outbox.map((o) => (o.payload as { change: string }).change)).toEqual(['ADDED', 'UPDATED', 'REMOVED']);
    expect((await db.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId: DEMO_IDS.application, stepKey: 'collateral' } } })).status).toBe('PENDING');
  });

  it('kyc хүрэх боломжгүй бол ХУР-ын хөрөнгө 502 UPSTREAM_ERROR (монгол мессеж), барьцаа үүсэхгүй', async () => {
    const res = await http().get(`/api/applications/${DEMO_IDS.application}/collaterals/xyp-assets`).query({ ownerCustomerId: DEMO_IDS.customer }).set(as('officerA'));
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_ERROR');
    expect(res.body.message).toContain('kyc');
    expect(JSON.stringify(res.body)).not.toContain('УЕ00000001');
    expect(await db.collateral.count()).toBe(0);
  });

  it('статик замууд барьцааны :id замд залгиулахгүй: monitoring, recheck, xyp-assets', async () => {
    expect((await http().get('/api/collaterals/monitoring').set(as('admin'))).status).toBe(200);
    const recheck = await http().post(`/api/applications/${DEMO_IDS.application}/collaterals/recheck`).set(as('officerA'));
    expect(recheck.status).toBe(200);
    expect((await http().get(`/api/applications/${DEMO_IDS.application}/collaterals/xyp-assets`).set(as('officerA'))).status).toBe(400); // ownerCustomerId дутуу
  });
});
