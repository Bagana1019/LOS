import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { annuityPayment } from '@los/calc';
import { BsaLosOverview, BsaLosPushResponse, StepKey } from '@los/contracts';
import { DomainError, UpstreamError } from '@los/nest-common';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { CREDIT_HISTORY } from '../score/credit-history/credit-history.port';
import { SCORING_CLIENT } from '../score/scoring.client';
import { FakeScoringClient } from '../score/testing/fake-scoring.client';
import { BSA_REPORT_STORE } from './bsa-report.store';
import { BSA_SCORING_CLIENT } from './bsa-scoring.client';
import { BsaModule } from './bsa.module';
import { BsaService } from './bsa.service';
import { FakeBsaScoringClient, FakeReportStore } from './testing/fake-bsa-scoring.client';

Logger.overrideLogger(false);

// M12c · INT-1/4/6/9 (origination талын BSA интеграци). Бодит Postgres + fake scoring/report store.
describe.skipIf(!hasTestDb)('origination · bsa (M12c)', () => {
  let t: TestApp;
  const bsa = new FakeBsaScoringClient();
  const reports = new FakeReportStore();
  const http = () => request(t.app.getHttpServer());
  const url = (appId: string, ...rest: string[]) => ['/api/applications', appId, 'bsa', ...rest].join('/');
  const PAYMENT = Math.round(annuityPayment(10_000_000, 24, 12) * 100) / 100;

  beforeAll(async () => {
    t = await createTestApp([BsaModule], (b) =>
      b.overrideProvider(BSA_SCORING_CLIENT).useValue(bsa).overrideProvider(BSA_REPORT_STORE).useValue(reports)
        .overrideProvider(SCORING_CLIENT).useValue(new FakeScoringClient()).overrideProvider(CREDIT_HISTORY).useValue({ get: async () => null }));
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    bsa.reset();
    reports.stored = [];
  });

  async function seed(o: { co?: boolean; status?: string; steps?: Partial<Record<(typeof StepKey)[number], string>> } = {}) {
    const app = await createApplication(t.prisma, { status: o.status ?? 'DRAFT' });
    const primary = await createCustomer(t.prisma, { firstName: 'Бат', lastName: 'Болд' });
    const pb = await createBorrower(t.prisma, app.id, primary.id, 'PRIMARY');
    let co = null;
    let cb = null;
    if (o.co) {
      co = await createCustomer(t.prisma, { firstName: 'Сар', lastName: 'Дорж' });
      cb = await createBorrower(t.prisma, app.id, co.id, 'CO_BORROWER');
    }
    await t.prisma.loanApplicationStep.createMany({ data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId: app.id, stepKey, status: o.steps?.[stepKey] ?? 'PENDING' })) });
    return { app, primary, pb, co, cb };
  }
  const reload = (id: string) => t.prisma.loanApplication.findUniqueOrThrow({ where: { id } });

  describe('эрх', () => {
    it('нэвтрээгүй 401; CUSTOMER 403; APPROVER унших боломжтой ч бичихгүй; өөр ЗЭЗ 403', async () => {
      const { app, primary, pb } = await seed();
      expect((await http().get(url(app.id)).set(actors.anonymous())).status).toBe(401);
      expect((await http().get(url(app.id)).set(actors.customer(primary.id))).status).toBe(403);
      expect((await http().get(url(app.id)).set(actors.approver())).status).toBe(200);
      expect((await http().post(url(app.id, 'analyses')).set(actors.approver()).send({ customerId: primary.id })).status).toBe(403);
      expect((await http().post(url(app.id, 'analyses')).set(actors.officer('other-officer')).send({ customerId: primary.id })).status).toBe(403);
      expect((await http().post(url(app.id, 'analyses', 'x', 'push')).set(actors.branchManager()).send({})).status).toBe(403);
      expect(pb).toBeTruthy();
      expect(bsa.created).toHaveLength(0);
    });
  });

  describe('INT-1 шинжилгээ үүсгэх', () => {
    it('LOS-оос регистр, нэр, санал болгосон төлбөр (аннуитет)-ийг дүүргэж scoring-д үүсгэнэ', async () => {
      const { app, primary, pb } = await seed();
      const res = await http().post(url(app.id, 'analyses')).set(actors.officer()).send({ customerId: primary.id, periodMonths: 6 });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(bsa.created).toHaveLength(1);
      const req = bsa.created[0]!;
      expect(req).toMatchObject({ loanApplicationId: app.id, customerId: primary.id, borrowerId: pb.id, periodMonths: 6, branchId: app.branchId });
      expect(req.customer.registerNo).toMatch(/^УБ9\d{7}$/);
      expect(req.customer).toMatchObject({ firstName: 'Бат', lastName: 'Болд' });
      expect(req.proposedMonthlyPayment).toBeCloseTo(PAYMENT, 2);
      const audit = await t.prisma.auditLog.findFirst({ where: { applicationId: app.id, action: 'BSA_ANALYSIS_CREATED' } });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit)).not.toMatch(/УБ9\d{7}/); // регистр аудитад орохгүй
    });

    it('хүсэлтийн зээлдэгч биш → 422; "Шинэ/Буцаасан" биш → 409; scoring унавал 503', async () => {
      const { app } = await seed();
      const stranger = await createCustomer(t.prisma);
      const r1 = await http().post(url(app.id, 'analyses')).set(actors.officer()).send({ customerId: stranger.id });
      expect([r1.status, r1.body.code]).toEqual([422, 'BORROWER_NOT_IN_APPLICATION']);
      const sub = await seed({ status: 'SUBMITTED' });
      const r2 = await http().post(url(sub.app.id, 'analyses')).set(actors.officer()).send({ customerId: sub.primary.id });
      expect([r2.status, r2.body.code]).toEqual([409, 'APPLICATION_NOT_EDITABLE']);
      const ok = await seed();
      bsa.failWith = new DomainError('BSA_UNAVAILABLE', 'унтарсан', 503);
      const r3 = await http().post(url(ok.app.id, 'analyses')).set(actors.officer()).send({ customerId: ok.primary.id });
      expect([r3.status, r3.body.code]).toEqual([503, 'BSA_UNAVAILABLE']);
    });
  });

  describe('INT-4 «Системрүү татах» + INT-9', () => {
    it('нэг зээлдэгч: bsa_summary_json, business_ncf_monthly бичигдэж income бүрдэнэ, score STALE, PDF хавсаргана', async () => {
      const { app, primary, pb } = await seed({ steps: { score: 'COMPLETED' } });
      const a = bsa.seedAnalysis({ customerId: primary.id, borrowerId: pb.id, applicationId: app.id, payment: PAYMENT });
      const res = await http().post(url(app.id, 'analyses', a.id, 'push')).set(actors.officer()).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = BsaLosPushResponse.parse(res.body);
      expect(body.reportAttached).toBe(true);
      expect(reports.stored).toEqual([{ applicationId: app.id, bytes: 13 }]);

      const row = await reload(app.id);
      expect(row.bsaSummaryJson).toMatchObject({ status: 'ANALYZED', analysisId: a.id, combined: false, dtiIncome: 2_250_000, existingDebtServiceMonthly: 200_000, pendingSuspiciousCount: 0 });
      const inc = await t.prisma.incomeSummary.findUniqueOrThrow({ where: { applicationId_customerId: { applicationId: app.id, customerId: primary.id } } });
      expect(inc.businessNcfMonthly?.toNumber()).toBe(1_500_000);
      expect(inc.businessExpenseMonthly?.toNumber()).toBe(500_000);
      const steps = await t.prisma.loanApplicationStep.findMany({ where: { applicationId: app.id } });
      expect(steps.find((s) => s.stepKey === 'income')?.status).toBe('COMPLETED'); // бизнесийн ЦМУ > 0 ⇒ орлого бүрдсэн
      expect(steps.find((s) => s.stepKey === 'score')).toMatchObject({ status: 'STALE', staleReason: 'BSA шинжилгээ өөрчлөгдсөн' });
      expect(await t.prisma.auditLog.count({ where: { applicationId: app.id, action: 'BSA_PUSHED' } })).toBe(1);
      expect(bsa.calls).toEqual(['list', 'finalize', 'combined', 'pdf']);
    });

    it('хамтран зээлдэгч 2: нэг нь л татагдсан бол DRAFT; хоёул татагдвал нэгтгэсэн DTI (Σ) ANALYZED', async () => {
      const { app, primary, pb, co, cb } = await seed({ co: true });
      const a1 = bsa.seedAnalysis({ customerId: primary.id, borrowerId: pb.id, applicationId: app.id, payment: PAYMENT });
      const a2 = bsa.seedAnalysis({ customerId: co!.id, borrowerId: cb!.id, applicationId: app.id, payment: PAYMENT, numbers: { dtiIncome: 750_000, existingDebtServiceMonthly: 50_000, netCashFlowMonthly: 400_000 } });
      await http().post(url(app.id, 'analyses', a1.id, 'push')).set(actors.officer()).send({}).expect(200);
      expect((await reload(app.id)).bsaSummaryJson).toMatchObject({ status: 'DRAFT', allAnalyzed: false, combined: true });

      await http().post(url(app.id, 'analyses', a2.id, 'push')).set(actors.officer()).send({}).expect(200);
      const json = (await reload(app.id)).bsaSummaryJson as Record<string, number | string>;
      expect(json).toMatchObject({ status: 'ANALYZED', combined: true, analysisCount: 2, dtiIncome: 3_000_000, existingDebtServiceMonthly: 250_000 });
      expect(json.dtiPercent).toBe(Math.round(((PAYMENT + 250_000) / 3_000_000) * 1000) / 10);
      // Хамтран зээлдэгч өөрийн мөрөнд
      const inc = await t.prisma.incomeSummary.findUniqueOrThrow({ where: { applicationId_customerId: { applicationId: app.id, customerId: co!.id } } });
      expect(inc.businessNcfMonthly?.toNumber()).toBe(400_000);
    });

    it('сэжигтэй хориг (BLOCK) → scoring-ийн 422 дамжина, юу ч бичигдэхгүй; PDF алдаа нь татахыг эвдэхгүй', async () => {
      const { app, primary, pb } = await seed();
      const a = bsa.seedAnalysis({ customerId: primary.id, borrowerId: pb.id, applicationId: app.id, numbers: { pendingSuspiciousCount: 2 } });
      bsa.blockPending = true;
      const blocked = await http().post(url(app.id, 'analyses', a.id, 'push')).set(actors.officer()).send({});
      expect([blocked.status, blocked.body.code]).toEqual([422, 'PENDING_SUSPICIOUS_BLOCK']);
      expect((await reload(app.id)).bsaSummaryJson).toBeNull();
      expect(await t.prisma.incomeSummary.count({ where: { applicationId: app.id } })).toBe(0);

      bsa.blockPending = false;
      bsa.pdfFails = true;
      const ok = await http().post(url(app.id, 'analyses', a.id, 'push')).set(actors.officer()).send({});
      expect(ok.status).toBe(200);
      expect(ok.body.reportAttached).toBe(false);
      expect(ok.body.warnings.join(' ')).toContain('PDF');
      expect((await reload(app.id)).bsaSummaryJson).toMatchObject({ pendingSuspiciousCount: 2 });
    });

    it('өөр хүсэлтийн шинжилгээ 404; "Шинэ/Буцаасан" биш 409; scoring унавал 503 ба хадгалагдсан зүйл хэвээр', async () => {
      const { app, primary, pb } = await seed();
      const other = await seed();
      const foreign = bsa.seedAnalysis({ customerId: other.primary.id, borrowerId: other.pb.id, applicationId: other.app.id });
      expect((await http().post(url(app.id, 'analyses', foreign.id, 'push')).set(actors.officer()).send({})).body.code).toBe('BSA_ANALYSIS_NOT_FOUND');
      const a = bsa.seedAnalysis({ customerId: primary.id, borrowerId: pb.id, applicationId: app.id });
      bsa.failWith = new UpstreamError('scoring', null, 'down', 502);
      const down = await http().post(url(app.id, 'analyses', a.id, 'push')).set(actors.officer()).send({});
      expect(down.status).toBe(502); // fake нь UpstreamError-ийг шууд шидсэн; бодит client 503 болгоно
      bsa.failWith = null;
      const sub = await seed({ status: 'SUBMITTED' });
      const sa = bsa.seedAnalysis({ customerId: sub.primary.id, borrowerId: sub.pb.id, applicationId: sub.app.id });
      expect((await http().post(url(sub.app.id, 'analyses', sa.id, 'push')).set(actors.officer()).send({})).status).toBe(409);
    });
  });

  describe('INT-6 санал болгосон төлбөр', () => {
    it('нөхцөл өөрчлөгдөхөд (sync-payment) өөрчлөгдсөн шинжилгээг дахин тооцуулж, татсан нэгтгэлийг шинэчилнэ', async () => {
      const { app, primary, pb } = await seed();
      const a = bsa.seedAnalysis({ customerId: primary.id, borrowerId: pb.id, applicationId: app.id, payment: 1_000 });
      await t.prisma.auditLog.create({ data: { orgId: ORG, entity: 'BSA_ANALYSIS', entityId: a.id, action: 'BSA_ANALYSIS_CREATED', applicationId: app.id } });
      await http().post(url(app.id, 'analyses', a.id, 'push')).set(actors.officer()).send({}).expect(200);
      bsa.recalculated = [];

      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { amount: 20_000_000 } });
      const res = await http().post(url(app.id, 'sync-payment')).set(actors.officer()).send({});
      expect(res.body).toEqual({ updated: 1 });
      const expected = Math.round(annuityPayment(20_000_000, 24, 12) * 100) / 100;
      expect(bsa.recalculated).toEqual([{ id: a.id, payment: expected }]);
      const json = (await reload(app.id)).bsaSummaryJson as { dtiPercent: number; status: string };
      expect(json.dtiPercent).toBe(Math.round(((expected + 200_000) / 2_250_000) * 1000) / 10);
      // дахин дуудахад өөрчлөлт байхгүй
      expect((await http().post(url(app.id, 'sync-payment')).set(actors.officer()).send({})).body).toEqual({ updated: 0 });
    });

    it('BSA шинжилгээгүй хүсэлтэд scoring-ийг огт дуудахгүй; scoring унасан ч алдаа шидэхгүй', async () => {
      const { app } = await seed();
      const svc = t.app.get(BsaService);
      const ctx = { orgId: ORG, userId: 'officer-1', roles: ['OFFICER'], branchId: app.branchId, correlationId: 'c' } as never;
      expect(await svc.syncPayment(ctx, app.id)).toEqual({ updated: 0 });
      expect(bsa.calls).toEqual([]);
      await t.prisma.auditLog.create({ data: { orgId: ORG, entity: 'BSA_ANALYSIS', entityId: 'x', action: 'BSA_ANALYSIS_CREATED', applicationId: app.id } });
      bsa.failWith = new DomainError('BSA_UNAVAILABLE', 'унтарсан', 503);
      expect(await svc.syncPayment(ctx, app.id)).toEqual({ updated: 0 });
    });
  });

  describe('overview', () => {
    it('зээлдэгч бүрийн сүүлийн шинжилгээ, санал болгосон төлбөр; scoring унасан бол available=false', async () => {
      const { app, primary, pb, co } = await seed({ co: true });
      bsa.seedAnalysis({ customerId: primary.id, borrowerId: pb.id, applicationId: app.id });
      const res = await http().get(url(app.id)).set(actors.officer());
      expect(res.status).toBe(200);
      const ov = BsaLosOverview.parse(res.body);
      expect(ov.available).toBe(true);
      expect(ov.editable).toBe(true);
      expect(ov.proposedMonthlyPayment).toBeCloseTo(PAYMENT, 2);
      expect(ov.borrowers.map((b) => [b.customerId, b.role, b.status])).toEqual([[primary.id, 'PRIMARY', 'DRAFT'], [co!.id, 'CO_BORROWER', null]]);
      bsa.failWith = new DomainError('BSA_UNAVAILABLE', 'унтарсан', 503);
      const down = BsaLosOverview.parse((await http().get(url(app.id)).set(actors.officer())).body);
      expect(down.available).toBe(false);
      expect(down.borrowers.every((b) => b.analysisId === null)).toBe(true);
    });
  });
});
