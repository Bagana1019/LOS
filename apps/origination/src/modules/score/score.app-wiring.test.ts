import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScoreOverview, StepKey } from '@los/contracts';
import { SEED } from '@los/database';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../prisma.service';
import { createApplication, createBorrower, createCustomer, hasTestDb } from '../../test-utils/factories';
import { CREDIT_HISTORY } from './credit-history/credit-history.port';
import { MockCreditHistory } from './credit-history/mock-credit-history';
import { HttpScoringClient, SCORING_CLIENT } from './scoring.client';
import { FakeScoringClient } from './testing/fake-scoring.client';

Logger.overrideLogger(false);

/** Gateway-ийн баталгаажуулсан толгойг дуурайна (сервис тэдэнд итгэнэ — CLAUDE.md §3.2.9). `test/app.ts`-ийн `as`-тэй ижил. */
const as = (u: keyof typeof SEED.users) => {
  const user = SEED.users[u];
  return { 'x-user-id': user.id, 'x-roles': user.roles.join(','), 'x-org-id': SEED.org.id, ...(user.branch ? { 'x-branch-id': SEED.branches[user.branch].id } : {}) };
};

// AppModule-д ScoreModule залгагдсан эсэх, жинхэнэ seed (org, салбар, ЗЭЗ, бүтээгдэхүүн, setting) дээр үйлчилгээний замыг шалгана.
describe('ScoreModule · AppModule-д залгалт (DI)', () => {
  it.skipIf(!hasTestDb)('override-гүй: SCORING_CLIENT = HttpScoringClient, CREDIT_HISTORY = Mock (анхдагч INTEGRATION_MODE=mock)', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      expect(mod.get(SCORING_CLIENT)).toBeInstanceOf(HttpScoringClient);
      expect(mod.get(CREDIT_HISTORY)).toBeInstanceOf(MockCreditHistory);
    } finally {
      await mod.close();
    }
  });
});

describe.skipIf(!hasTestDb)('ScoreModule · AppModule + seed (gateway толгойн дуураймал)', () => {
  let app: INestApplication;
  let db: PrismaService;
  const scoring = new FakeScoringClient();
  let applicationId: string;
  let customerId: string;
  const api = () => request(app.getHttpServer());
  const url = (...rest: string[]) => ['/api/applications', applicationId, 'score', ...rest].join('/');

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(SCORING_CLIENT).useValue(scoring).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    db = app.get(PrismaService);

    const customer = await createCustomer(db, { orgId: SEED.org.id });
    customerId = customer.id;
    const application = await createApplication(db, {
      orgId: SEED.org.id, branchId: SEED.branches.head.id, officerId: SEED.users.officerA.id, productId: SEED.products.consumer, appNo: `SCORE-WIRING-${randomUUID()}`,
    });
    applicationId = application.id;
    await createBorrower(db, application.id, customer.id, 'PRIMARY', { orgId: SEED.org.id });
    await db.incomeSummary.create({ data: { orgId: SEED.org.id, applicationId, customerId: customer.id, avgSalaryMonthly: 3_000_000, businessNcfMonthly: 0, householdExpenseMonthly: 0 } });
    await db.loanApplicationStep.createMany({ data: StepKey.map((stepKey) => ({ orgId: SEED.org.id, applicationId, stepKey, status: 'PENDING' })) });
  });
  afterAll(async () => {
    if (db && applicationId) {
      await db.auditLog.deleteMany({ where: { applicationId } });
      await db.loanApplication.delete({ where: { id: applicationId } }); // оролцогч, орлого, алхам cascade
      await db.customer.delete({ where: { id: customerId } });
    }
    await app?.close();
  });

  it('seed-ийн бүтээгдэхүүний хязгаар (BR-6) ба setting-ийн BR утгууд (hardcode биш) үйлчилнэ', async () => {
    const res = await api().get(url()).set(as('officerA'));
    expect(res.status).toBe(200);
    expect(ScoreOverview.parse(res.body)).toMatchObject({
      applicationId, editable: true, blockers: [], calculation: null,
      limits: { minAmount: 100_000, maxAmount: 50_000_000, minTermMonths: 1, maxTermMonths: 36, minRate: 18, maxRate: 42 },
    });
    await api().post(url('preview')).set(as('officerA')).send({});
    expect(scoring.callsOf('preview')[0]!.args[0]).toMatchObject({ policy: { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 }, stress: { rateDeltaPoints: 5, incomeChange: -0.2 }, collateralRequired: false });
  });

  it('seed дүрүүд: officer.a/manager/approver/admin уншина; officer.b 403; тооцоолох нь зөвхөн officer.a', async () => {
    for (const who of ['officerA', 'manager', 'approver', 'admin'] as const) expect((await api().get(url()).set(as(who))).status, who).toBe(200);
    expect((await api().get(url()).set(as('officerB'))).status).toBe(403);
    for (const who of ['officerB', 'manager', 'approver', 'admin'] as const) expect((await api().post(url('calculate')).set(as(who))).status, who).toBe(403);

    const res = await api().post(url('calculate')).set(as('officerA')).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ScoreOverview.parse(res.body).calculation).toMatchObject({ selectedMethod: 'A_SALARY' });
    const row = await db.loanApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.selectedCalcMethod).toBe('A_SALARY');
    expect(await db.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId, stepKey: 'score' } } })).toMatchObject({ status: 'COMPLETED' });
  });
});
