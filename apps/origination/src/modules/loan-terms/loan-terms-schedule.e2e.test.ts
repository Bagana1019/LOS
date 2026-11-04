import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { LoanTermsView, ScheduleResponse } from '@los/contracts';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { ApplicationModule } from '../application/application.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { ScoreModule } from '../score/score.module';
import { SCORING_CLIENT } from '../score/scoring.client';
import { FakeScoringClient } from '../score/testing/fake-scoring.client';
import { LoanTermsModule } from './loan-terms.module';

Logger.overrideLogger(false);

const officer = actors.officer('officer-1');
const other = actors.officer('officer-2');
const SCHED = { startDate: '2026-01-01', firstPaymentDate: '2026-02-01', type: 'ANNUITY', graceMonths: 0 };
const TERMS = { amount: 30_000_000, termMonths: 36, interestRate: 23.99, purpose: 'Хэрэглээ' };

// Модуль 5 + 7 AC (docs/04): хязгаар, STALE, ЭТХ ≈ 1,176,828₮, Excel 36 мөр, илгээх хаалт (G1) — бодит Postgres + fake scoring.
describe.skipIf(!hasTestDb)('loan terms (FR-5) + repayment schedule (FR-7) API', () => {
  let t: TestApp;
  const scoring = new FakeScoringClient();
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp([ApplicationModule, LoanTermsModule, ScheduleModule, ScoreModule], (b) => b.overrideProvider(SCORING_CLIENT).useValue(scoring));
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(t.prisma); scoring.reset(); });

  async function seed(o: { status?: string } = {}) {
    const product = await t.prisma.product.create({
      data: { orgId: ORG, code: `P${Math.random().toString(36).slice(2, 8)}`, name: 'Хэрэглээний', productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42, defaultFeeRate: 0.01, requiresCollateral: false },
    });
    const app = await createApplication(t.prisma, { productId: product.id, amount: null, interestRate: null, termMonths: null, ...(o.status ? { status: o.status } : {}) });
    const keys = ['client', 'inquiry', 'income', 'loan', 'collateral', 'installment', 'score'];
    await t.prisma.loanApplicationStep.createMany({ data: keys.map((stepKey) => ({ orgId: ORG, applicationId: app.id, stepKey, status: 'PENDING' })) });
    return { app, product };
  }
  const setSteps = (appId: string, keys: string[], status: string) => t.prisma.loanApplicationStep.updateMany({ where: { applicationId: appId, stepKey: { in: keys } }, data: { status, completedAt: status === 'COMPLETED' ? new Date() : null } });
  const stepStatus = async (appId: string, key: string) => (await t.prisma.loanApplicationStep.findFirstOrThrow({ where: { applicationId: appId, stepKey: key } })).status;
  const saveTerms = (appId: string, productId: string, over: Record<string, unknown> = {}, actor: Record<string, string> = officer) =>
    http().put(`/api/applications/${appId}/loan-terms`).set(actor).send({ productId, ...TERMS, ...over });
  const generate = (appId: string, over: Record<string, unknown> = {}, actor: Record<string, string> = officer) => http().post(`/api/applications/${appId}/schedule`).set(actor).send({ ...SCHED, ...over });

  describe('M5 · зээлийн нөхцөл', () => {
    it('бүтээгдэхүүний каталог хязгаартай, ЗМС ангилал байна (FR-5.1, 5.2)', async () => {
      const { product } = await seed();
      const res = await http().get('/api/loan-terms/products').set(officer);
      expect(res.status).toBe(200);
      expect(res.body.items.find((p: { id: string }) => p.id === product.id).limits).toMatchObject({ minAmount: 100_000, maxAmount: 50_000_000, maxTermMonths: 36, minRate: 18, maxRate: 42 });
      expect((await http().get('/api/loan-terms/cib-purposes').set(officer)).body.items.length).toBeGreaterThan(0);
    });

    it('AC: 60 сарын хугацаа → 422, хадгалахгүй', async () => {
      const { app, product } = await seed();
      const res = await saveTerms(app.id, product.id, { termMonths: 60 });
      expect(res.status).toBe(422);
      expect(res.body.code ?? res.body.error?.code).toBe('LOAN_TERMS_OUT_OF_LIMITS');
      expect(JSON.stringify(res.body)).toContain('termMonths');
      expect((await t.prisma.loanApplication.findUniqueOrThrow({ where: { id: app.id } })).termMonths).toBeNull();
      expect(await stepStatus(app.id, 'loan')).toBe('PENDING');
    });

    it('хүү, дүн хязгаараас гарвал 422; хүү/шимтгэл хоосон бол default (бүтээгдэхүүний доод хүү, default шимтгэл)', async () => {
      const { app, product } = await seed();
      expect((await saveTerms(app.id, product.id, { interestRate: 50 })).status).toBe(422);
      expect((await saveTerms(app.id, product.id, { amount: 10 })).status).toBe(422);
      const { interestRate: _omit, ...noRate } = TERMS;
      const res = await http().put(`/api/applications/${app.id}/loan-terms`).set(officer).send({ productId: product.id, ...noRate });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const view = LoanTermsView.parse(res.body);
      expect(view).toMatchObject({ interestRate: 18, feeRate: 0.01, feeAmount: 300_000, currency: 'MNT' });
    });

    it('хадгалахад 4-р алхам COMPLETED + audit; ЗМС ангилал буруу бол 400', async () => {
      const { app, product } = await seed();
      const res = await saveTerms(app.id, product.id, { cibPurposeCode: 'CONS', cibSubCode: 'CONS-EDU', officerNote: 'Сайн харилцагч' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const view = LoanTermsView.parse(res.body);
      expect(view).toMatchObject({ amount: 30_000_000, termMonths: 36, interestRate: 23.99, cibSubCode: 'CONS-EDU', officerNote: 'Сайн харилцагч', editable: true, step: { status: 'COMPLETED' } });
      expect((await t.prisma.auditLog.findMany({ where: { applicationId: app.id, action: 'LOAN_TERMS_SAVED' } }))).toHaveLength(1);
      expect((await saveTerms(app.id, product.id, { cibPurposeCode: 'NOPE' })).status).toBe(400);
    });

    it('эрх: өөр ЗЭЗ 403, зээлдэгчийн портал 403, SUBMITTED төлөвт 409', async () => {
      const { app, product } = await seed();
      expect((await saveTerms(app.id, product.id, {}, other)).status).toBe(403);
      expect((await http().get(`/api/applications/${app.id}/loan-terms`).set(actors.customer('c1'))).status).toBe(403);
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { status: 'SUBMITTED' } });
      const res = await saveTerms(app.id, product.id);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('APPLICATION_NOT_EDITABLE');
    });
  });

  describe('M7 · ЭТХ', () => {
    it('AC: 30,000,000₮ · 23.99% · 36 сар annuity → ≈1,176,828₮, үлдэгдэл 0, алхам COMPLETED', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id);
      const res = await generate(app.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const { schedule, editable } = ScheduleResponse.parse(res.body);
      expect(editable).toBe(true);
      expect(schedule?.isStale).toBe(false);
      expect(schedule?.summary.installments).toBe(36);
      expect(schedule?.params).toMatchObject({ principal: 30_000_000, annualRate: 23.99, termMonths: 36, dayCount: 'ACT/365', endDate: '2029-01-01' });
      expect(Math.abs(schedule!.rows[1]!.total - 1_176_828)).toBeLessThanOrEqual(1);
      expect(schedule!.rows[36]!.balance).toBe(0);
      expect(schedule!.rows[0]).toMatchObject({ seq: 0, disbursement: 30_000_000 });
      expect(await stepStatus(app.id, 'installment')).toBe('COMPLETED');
      expect(await t.prisma.repaymentScheduleRow.count({ where: { schedule: { applicationId: app.id } } })).toBe(37);
    });

    it('AC: Excel 36 мөр', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id);
      await generate(app.id);
      const res = await http().get(`/api/applications/${app.id}/schedule/export`).set(officer).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as Buffer);
      const ws = wb.worksheets[0]!;
      const dataRows: number[] = [];
      ws.eachRow((row) => { if (typeof row.getCell(1).value === 'number' && row.number > 6) dataRows.push(row.number); });
      expect(dataRows).toHaveLength(36);
      expect(ws.getCell(`G${dataRows[35]}`).value).toBe(0);
    });

    it('нөхцөл байхгүй бол 422; параметр буруу бол 422; урьдчилж харах хадгалахгүй', async () => {
      const { app, product } = await seed();
      expect((await generate(app.id)).status).toBe(422);
      await saveTerms(app.id, product.id);
      expect((await generate(app.id, { firstPaymentDate: '2025-12-01' })).status).toBe(422);
      expect((await generate(app.id, { type: 'QUARTERLY', firstPaymentDate: '2026-04-01', startDate: '2026-01-01' })).status).toBe(200); // 36 сар = 3-ын үржвэр
      const prev = await http().post(`/api/applications/${app.id}/schedule/preview`).set(officer).send({ ...SCHED, type: 'BULLET' });
      expect(prev.status).toBe(200);
      expect(prev.body.id).toBeNull();
      expect(await t.prisma.repaymentSchedule.count({ where: { applicationId: app.id } })).toBe(1);
    });

    it('ACT/365 нь setting `schedule.day_count`-оос', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id, { termMonths: 12, amount: 1_000_000 });
      await t.prisma.setting.upsert({ where: { orgId_key: { orgId: ORG, key: 'schedule.day_count' } }, update: { valueJson: 'ACT/365' }, create: { orgId: ORG, key: 'schedule.day_count', valueJson: 'ACT/365' } });
      const { schedule } = ScheduleResponse.parse((await generate(app.id)).body);
      expect(schedule?.params.dayCount).toBe('ACT/365');
      expect(schedule?.rows[1]?.days).toBe(31);
    });

    it('дахин үүсгэхэд өмнөх хуваарь хуучирна, GET хамгийн сүүлийнхийг буцаана', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id, { termMonths: 12, amount: 1_200_000 });
      const first = ScheduleResponse.parse((await generate(app.id)).body).schedule!;
      const second = ScheduleResponse.parse((await generate(app.id, { graceMonths: 2 })).body).schedule!;
      expect(second.id).not.toBe(first.id);
      expect(second.params.graceMonths).toBe(2);
      expect((await t.prisma.repaymentSchedule.findUniqueOrThrow({ where: { id: first.id! } })).isStale).toBe(true);
      expect(ScheduleResponse.parse((await http().get(`/api/applications/${app.id}/schedule`).set(officer)).body).schedule?.id).toBe(second.id);
    });
  });

  describe('FR-7.3 · нөхцөл өөрчлөгдвөл STALE', () => {
    it('AC: дүн өөрчлөхөд ЭТХ алхам STALE, ЭТХ хуучирсан, тооцоолол алхам STALE, Excel 409; дахин үүсгэвэл COMPLETED', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id);
      await generate(app.id);
      await setSteps(app.id, ['score'], 'COMPLETED');

      expect((await saveTerms(app.id, product.id, { amount: 20_000_000 })).status).toBe(200);
      expect(await stepStatus(app.id, 'installment')).toBe('STALE');
      expect(await stepStatus(app.id, 'score')).toBe('STALE');
      expect(scoring.calls.some((c) => c.op === 'markStale')).toBe(true);
      const view = LoanTermsView.parse((await http().get(`/api/applications/${app.id}/loan-terms`).set(officer)).body);
      expect(view.installmentStep).toMatchObject({ status: 'STALE', staleReason: 'LOAN_TERMS_CHANGED' });
      expect(ScheduleResponse.parse((await http().get(`/api/applications/${app.id}/schedule`).set(officer)).body).schedule?.isStale).toBe(true);
      expect((await http().get(`/api/applications/${app.id}/schedule/export`).set(officer)).status).toBe(409);

      await generate(app.id);
      expect(await stepStatus(app.id, 'installment')).toBe('COMPLETED');
      expect(ScheduleResponse.parse((await http().get(`/api/applications/${app.id}/schedule`).set(officer)).body).schedule?.isStale).toBe(false);
    });

    it('нөлөөгүй талбар (даатгал, тайлбар) өөрчлөхөд STALE болохгүй', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id);
      await generate(app.id);
      await saveTerms(app.id, product.id, { insurance: 50_000, officerNote: 'шинэчилсэн' });
      expect(await stepStatus(app.id, 'installment')).toBe('COMPLETED');
    });

    it('нөхцөл DB-д өөр замаар өөрчлөгдсөн ч ЭТХ хуучирсан гэж харагдана', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id);
      await generate(app.id);
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { termMonths: 24 } });
      expect(ScheduleResponse.parse((await http().get(`/api/applications/${app.id}/schedule`).set(officer)).body).schedule?.isStale).toBe(true);
    });

    it('G1: ЭТХ STALE бол илгээх 422 (STEPS_INCOMPLETE), шинэчилсний дараа ApplicationStateMachine-ээр SUBMITTED', async () => {
      const { app, product } = await seed();
      await saveTerms(app.id, product.id);
      await generate(app.id);
      await setSteps(app.id, ['client', 'inquiry', 'income', 'collateral', 'score'], 'COMPLETED');
      await saveTerms(app.id, product.id, { amount: 25_000_000 });
      await setSteps(app.id, ['score'], 'COMPLETED');
      const blocked = await http().post(`/api/applications/${app.id}/transition`).set(officer).send({ to: 'SUBMITTED' });
      expect(blocked.status).toBe(422);
      expect(JSON.stringify(blocked.body)).toContain('installment');
      await generate(app.id);
      expect(await stepStatus(app.id, 'score')).toBe('STALE'); // ЭТХ өөрчлөгдсөн → тооцоолол дахин хийгдэх ёстой
      await setSteps(app.id, ['score'], 'COMPLETED');
      const ok = await http().post(`/api/applications/${app.id}/transition`).set(officer).send({ to: 'SUBMITTED' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe('SUBMITTED');
      // илгээсний дараа нөхцөл, ЭТХ засахгүй
      expect((await generate(app.id)).status).toBe(409);
    });
  });
});
