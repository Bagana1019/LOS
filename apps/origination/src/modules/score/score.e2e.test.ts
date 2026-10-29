import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { annuityPayment } from '@los/calc';
import { ScoreOverview, ScorePreviewResponse, StepKey, type ScoreRequest } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import type { LoanApplication, Product } from '.prisma/client-origination';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, nextSeq, ORG, resetDb } from '../../test-utils/factories';
import { CREDIT_HISTORY, type CreditHistory, type CreditHistoryPort } from './credit-history/credit-history.port';
import { ScoreModule } from './score.module';
import { ScoreService } from './score.service';
import { SCORING_CLIENT } from './scoring.client';
import { FakeScoringClient } from './testing/fake-scoring.client';

/** `CreditHistoryPort` fake: тест бүр утгаа тогтооно (null = real горимын "мэдэгдэхгүй"). */
class FakeCreditHistory implements CreditHistoryPort {
  value: CreditHistory | null = null;
  failure: Error | null = null;
  calls: Array<{ applicationId: string; customerId: string }> = [];
  async get(_ctx: unknown, applicationId: string, customerId: string): Promise<CreditHistory | null> {
    this.calls.push({ applicationId, customerId });
    if (this.failure) throw this.failure;
    return this.value;
  }
}

Logger.overrideLogger(false); // 503/500 тест бүрийн алдааны лог дэлгэцийг дүүргэхгүй

const OFFICER = 'officer-1';
const BRANCH = 'branch-1';
const POLICY = { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 };
const STRESS = { rateDeltaPoints: 5, incomeChange: -0.2 };
const round2 = (n: number) => Math.round(n * 100) / 100;

// Модуль 8 · origination фасад (FR-8, NFR-3, NFR-4). Бодит Postgres + fake ScoringClient (SCORING_CLIENT token).
describe.skipIf(!hasTestDb)('origination · score (Модуль 8)', () => {
  let t: TestApp;
  const scoring = new FakeScoringClient();
  const credit = new FakeCreditHistory();
  const http = () => request(t.app.getHttpServer());
  const url = (appId: string, ...rest: string[]) => ['/api/applications', appId, 'score', ...rest].join('/');

  beforeAll(async () => {
    t = await createTestApp([ScoreModule], (b) => b.overrideProvider(SCORING_CLIENT).useValue(scoring).overrideProvider(CREDIT_HISTORY).useValue(credit));
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    scoring.reset();
    credit.value = null;
    credit.failure = null;
    credit.calls = [];
  });

  // ── fixture туслахууд ───────────────────────────────────────────────────────────────────
  interface Seed {
    app?: Partial<Parameters<typeof createApplication>[1]>;
    product?: Record<string, unknown> | false;
    primary?: { salary?: number | null; ncf?: number | null; household?: number | null } | false;
    co?: { salary?: number; ncf?: number; household?: number; included?: boolean };
    collateral?: Array<number | null | { value: number; released: true }>;
    steps?: boolean | Partial<Record<StepKey, string>>;
  }
  async function seed(o: Seed = {}): Promise<{ app: LoanApplication; product: Product | null; primaryId: string | null; coId: string | null }> {
    const n = nextSeq();
    const product = o.product === false ? null : await t.prisma.product.create({
      data: {
        orgId: ORG, code: `P${n}`, name: `Бүтээгдэхүүн ${n}`, productType: 'CONSUMER', minAmount: 100_000, maxAmount: 50_000_000, minTerm: 1, maxTerm: 36, minRate: 18, maxRate: 42,
        requiresCollateral: false, ...(o.product ?? {}),
      } as never,
    });
    const app = await createApplication(t.prisma, { productId: product?.id ?? null, ...o.app });
    let primaryId: string | null = null;
    if (o.primary !== false) {
      const c = await createCustomer(t.prisma);
      primaryId = c.id;
      await createBorrower(t.prisma, app.id, c.id, 'PRIMARY');
      const p = o.primary ?? { salary: 3_000_000, ncf: 0, household: 0 };
      await t.prisma.incomeSummary.create({ data: { orgId: ORG, applicationId: app.id, customerId: c.id, avgSalaryMonthly: p.salary ?? null, businessNcfMonthly: p.ncf ?? null, householdExpenseMonthly: p.household ?? null } });
    }
    let coId: string | null = null;
    if (o.co) {
      const c = await createCustomer(t.prisma);
      coId = c.id;
      await createBorrower(t.prisma, app.id, c.id, 'CO_BORROWER', { incomeIncluded: o.co.included ?? true });
      await t.prisma.incomeSummary.create({ data: { orgId: ORG, applicationId: app.id, customerId: c.id, avgSalaryMonthly: o.co.salary ?? 0, businessNcfMonthly: o.co.ncf ?? 0, householdExpenseMonthly: o.co.household ?? 0 } });
    }
    for (const c of o.collateral ?? []) {
      const released = typeof c === 'object' && c !== null;
      await t.prisma.collateral.create({
        data: { orgId: ORG, applicationId: app.id, kind: 'MOVABLE', assetType: 'VEHICLE', collateralValue: released ? c.value : c, releasedAt: released ? new Date('2026-01-01T00:00:00Z') : null },
      });
    }
    if (o.steps !== false) {
      const status = typeof o.steps === 'object' ? o.steps : {};
      await t.prisma.loanApplicationStep.createMany({
        data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId: app.id, stepKey, status: status[stepKey] ?? 'PENDING', ...((status[stepKey] ?? 'PENDING') === 'COMPLETED' ? { completedAt: new Date('2026-10-01T00:00:00Z') } : {}) })),
      });
    }
    return { app, product, primaryId, coId };
  }
  const setSetting = (key: string, value: unknown) => t.prisma.setting.create({ data: { orgId: ORG, key, valueJson: value as never } });
  const step = (appId: string) => t.prisma.loanApplicationStep.findUniqueOrThrow({ where: { applicationId_stepKey: { applicationId: appId, stepKey: 'score' } } });
  const reload = (appId: string) => t.prisma.loanApplication.findUniqueOrThrow({ where: { id: appId } });
  const audits = (appId: string) => t.prisma.auditLog.findMany({ where: { applicationId: appId, entity: 'CALCULATION' }, orderBy: { at: 'asc' } });
  const calculate = (appId: string, actor: Record<string, string> = actors.officer()) => http().post(url(appId, 'calculate')).set(actor).send({});
  async function calcOk(appId: string) {
    const res = await calculate(appId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ScoreOverview.parse(res.body);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('эрх ба хүрээ (NFR-3)', () => {
    const calls = (appId: string) => [
      ['GET', url(appId), 'read'], ['POST', url(appId, 'preview'), 'read'], ['POST', url(appId, 'calculate'), 'write'], ['PUT', url(appId, 'selection'), 'write'],
    ] as const;
    const send = (method: string, path: string, headers: Record<string, string>) => {
      const body = path.endsWith('selection') ? { method: 'A_SALARY' } : {};
      switch (method) {
        case 'GET': return http().get(path).set(headers);
        case 'PUT': return http().put(path).set(headers).send(body);
        default: return http().post(path).set(headers).send(body);
      }
    };

    it('нэвтрээгүй → 401 UNAUTHENTICATED (бүх endpoint)', async () => {
      const { app } = await seed();
      for (const [m, p] of calls(app.id)) {
        const res = await send(m, p, actors.anonymous());
        expect([m, p, res.status]).toEqual([m, p, 401]);
        expect(res.body.code).toBe('UNAUTHENTICATED');
      }
      expect(scoring.calls).toHaveLength(0);
    });

    it('CUSTOMER дүр (өөрийн хүсэлт дээр ч) → 403 FORBIDDEN (бүх endpoint)', async () => {
      const { app, primaryId } = await seed();
      for (const [m, p] of calls(app.id)) {
        const res = await send(m, p, actors.customer(primaryId!));
        expect([m, p, res.status]).toEqual([m, p, 403]);
        expect(res.body.code).toBe('FORBIDDEN');
      }
      expect(scoring.calls).toHaveLength(0);
    });

    it('унших/preview: өөрийн ЗЭЗ, өөрийн салбарын захирал, батлагч, админ → 200', async () => {
      const { app } = await seed();
      for (const actor of [actors.officer(OFFICER, BRANCH), actors.branchManager('bm', BRANCH), actors.approver(), actors.admin()]) {
        expect((await send('GET', url(app.id), actor)).status, actor['x-roles']).toBe(200);
        expect((await send('POST', url(app.id, 'preview'), actor)).status, actor['x-roles']).toBe(200);
      }
    });

    it('тооцоолох/сонгох: зөвхөн ЗЭЗ — салбарын захирал, батлагч, админ → 403 (scoring дуудагдахгүй)', async () => {
      const { app } = await seed();
      for (const actor of [actors.branchManager('bm', BRANCH), actors.approver(), actors.admin()]) {
        expect((await send('POST', url(app.id, 'calculate'), actor)).status, actor['x-roles']).toBe(403);
        expect((await send('PUT', url(app.id, 'selection'), actor)).status, actor['x-roles']).toBe(403);
      }
      expect(scoring.calls).toHaveLength(0);
      expect((await reload(app.id)).selectedCalcMethod).toBeNull();
    });

    it('өөр ЗЭЗ (officer B) нөгөөгийнх нь хүсэлтийг уншиж, preview хийж, тооцоолж, сонгож чадахгүй → 403', async () => {
      const { app } = await seed();
      for (const [m, p] of calls(app.id)) {
        const res = await send(m, p, actors.officer('officer-2', 'branch-2'));
        expect([m, p, res.status]).toEqual([m, p, 403]);
        expect(res.body.code).toBe('FORBIDDEN');
      }
      expect(scoring.calls).toHaveLength(0);
    });

    it('өөр салбарын захирал → 403; нэг салбарын ЗЭЗ (өөр хүн) → 403', async () => {
      const { app } = await seed();
      expect((await send('GET', url(app.id), actors.branchManager('bm', 'branch-2'))).status).toBe(403);
      expect((await send('POST', url(app.id, 'preview'), actors.branchManager('bm', 'branch-2'))).status).toBe(403);
      expect((await send('GET', url(app.id), actors.officer('officer-2', BRANCH))).status).toBe(403);
    });

    it('олдохгүй хүсэлт / өөр байгууллагын хүсэлт → 404 APPLICATION_NOT_FOUND', async () => {
      const { app } = await seed();
      for (const [m, p] of calls('00000000-0000-4000-8000-00000000dead')) expect((await send(m, p, actors.officer())).status, p).toBe(404);
      const res = await http().get(url(app.id)).set({ ...actors.admin(), 'x-org-id': 'other-org' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('GET overview', () => {
    it('шинэ хүсэлт: нөхцөл, хязгаар (BR-6), саадгүй, тооцоолол/Sosco байхгүй, ЗЭЗ засах боломжтой', async () => {
      const { app } = await seed();
      const res = await http().get(url(app.id)).set(actors.officer());
      expect(res.status).toBe(200);
      expect(ScoreOverview.parse(res.body)).toEqual({
        applicationId: app.id, editable: true, terms: { amount: 10_000_000, termMonths: 12, interestRate: 24 },
        limits: { minAmount: 100_000, maxAmount: 50_000_000, minTermMonths: 1, maxTermMonths: 36, minRate: 18, maxRate: 42 },
        blockers: [], calculation: null, sosco: null,
      });
    });

    it('editable = төлөв DRAFT/RETURNED + бичих эрх (ЗЭЗ); бусад дүр / илгээгдсэн хүсэлт → false', async () => {
      const draft = await seed();
      const returned = await seed({ app: { status: 'RETURNED' } });
      const submitted = await seed({ app: { status: 'SUBMITTED' } });
      const editable = async (appId: string, actor: Record<string, string>) => (await http().get(url(appId)).set(actor)).body.editable;
      expect(await editable(draft.app.id, actors.officer())).toBe(true);
      expect(await editable(returned.app.id, actors.officer())).toBe(true);
      expect(await editable(submitted.app.id, actors.officer())).toBe(false);
      for (const actor of [actors.branchManager('bm', BRANCH), actors.approver(), actors.admin()]) expect(await editable(draft.app.id, actor)).toBe(false);
    });

    it('нөхцөл дутуу → terms=null, blockers=[LOAN_TERMS_MISSING · алхам loan]', async () => {
      const { app } = await seed({ app: { interestRate: null, termMonths: null } });
      const res = ScoreOverview.parse((await http().get(url(app.id)).set(actors.officer())).body);
      expect(res.terms).toBeNull();
      expect(res.blockers).toEqual([expect.objectContaining({ code: 'LOAN_TERMS_MISSING', step: 'loan' })]);
      expect(res.limits).not.toBeNull();
    });

    it('бүтээгдэхүүнгүй хүсэлт → limits=null', async () => {
      const { app } = await seed({ product: false });
      expect(ScoreOverview.parse((await http().get(url(app.id)).set(actors.officer())).body).limits).toBeNull();
    });

    it('сүүлийн тооцоолол + үндсэн зээлдэгчийн Sosco-г scoring-аас авна', async () => {
      const { app, primaryId } = await seed();
      await calcOk(app.id);
      scoring.calls.length = 0;
      const res = ScoreOverview.parse((await http().get(url(app.id)).set(actors.branchManager('bm', BRANCH))).body);
      expect(res.calculation).toMatchObject({ applicationId: app.id, selectedMethod: 'A_SALARY', selection: 'AUTO' });
      expect(res.sosco).toMatchObject({ customerId: primaryId, score: 720, grade: 'B' });
      expect(scoring.callsOf('latest')[0]!.args).toEqual([app.id]);
      expect(scoring.callsOf('latestSosco')[0]!.args).toEqual([app.id, primaryId]);
      expect(scoring.callsOf('calculate')).toHaveLength(0); // GET нь тооцоолохгүй
    });

    it('scoring унасан үед GET 503 болохгүй: нөхцөл/хязгаар/саадыг буцааж calculation, sosco = null', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.failAlways('latest').failAlways('latestSosco');
      const res = await http().get(url(app.id)).set(actors.officer());
      expect(res.status).toBe(200);
      expect(ScoreOverview.parse(res.body)).toMatchObject({ terms: { amount: 10_000_000 }, calculation: null, sosco: null, editable: true });
    });

    it('scoring мэдэгдээгүй ч алхам STALE бол тооцоолол хуучирсан гэж харуулна', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.failNext('markStale');
      await t.app.get(ScoreService).markStale(ctxOf(), app.id, 'LOAN_TERMS_CHANGED');
      const res = ScoreOverview.parse((await http().get(url(app.id)).set(actors.officer())).body);
      expect(res.calculation).toMatchObject({ isStale: true, staleReason: 'LOAN_TERMS_CHANGED' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('POST preview (FR-8.3 slider, BR-6)', () => {
    it('одоогийн нөхцөлөөр: ScoreRequest-ийг scoring-д дамжуулж {terms, result} буцаана; юу ч хадгалахгүй, event/аудитгүй', async () => {
      const { app } = await seed({ primary: { salary: 3_000_000, ncf: 0, household: 0 } });
      const res = await http().post(url(app.id, 'preview')).set(actors.officer()).send({});
      expect(res.status).toBe(200);
      const body = ScorePreviewResponse.parse(res.body);
      expect(body.terms).toEqual({ amount: 10_000_000, termMonths: 12, interestRate: 24 });
      expect(body.result.applicationId).toBe(app.id);
      expect(scoring.calls.map((c) => c.op)).toEqual(['preview']);
      expect(scoring.calls[0]!.args[0]).toEqual({
        applicationId: app.id, amount: 10_000_000, termMonths: 12, interestRate: 24, monthlyPayment: round2(annuityPayment(10_000_000, 24, 12)),
        salaryMonthly: 3_000_000, businessNcfMonthly: 0, householdExpenseMonthly: 0, existingDebtServiceMonthly: 0, collateralValueTotal: 0, collateralRequired: false, policy: POLICY, stress: STRESS,
      });
      const after = await reload(app.id);
      expect(after.selectedCalcMethod).toBeNull();
      expect(after.calcSnapshotJson).toBeNull();
      expect((await step(app.id)).status).toBe('PENDING');
      expect(await audits(app.id)).toHaveLength(0);
      expect(await t.prisma.outbox.count()).toBe(0);
    });

    it('slider override: өгсөн талбар тооцоонд орно (шинэ төлбөр annuity-аар), хадгалагдсан нөхцөл өөрчлөгдөхгүй', async () => {
      const { app } = await seed();
      const res = await http().post(url(app.id, 'preview')).set(actors.officer()).send({ amount: 5_000_000, termMonths: 24 });
      expect(res.status).toBe(200);
      expect(res.body.terms).toEqual({ amount: 5_000_000, termMonths: 24, interestRate: 24 });
      expect(scoring.calls[0]!.args[0]).toMatchObject({ amount: 5_000_000, termMonths: 24, interestRate: 24, monthlyPayment: round2(annuityPayment(5_000_000, 24, 24)) });
      expect(Number((await reload(app.id)).amount)).toBe(10_000_000);
    });

    it('slider override хуучраагүй ЭТХ-ийг ашиглахгүй (ЭТХ хадгалагдсан нөхцөлд хамаарна)', async () => {
      const { app } = await seed({ app: { amount: 1_200_000 } });
      await t.prisma.repaymentSchedule.create({ data: { orgId: ORG, applicationId: app.id, paramsJson: {}, rows: { create: scheduleRows(12, 100_000, 120_000) } } });
      await http().post(url(app.id, 'preview')).set(actors.officer()).send({ termMonths: 12, amount: 1_200_001 });
      expect(scoring.calls[0]!.args[0]).toMatchObject({ monthlyPayment: round2(annuityPayment(1_200_001, 24, 12)) });
    });

    it.each([
      [{ amount: 99_999 }, 'amount'], [{ amount: 50_000_001 }, 'amount'], [{ termMonths: 37 }, 'termMonths'], [{ interestRate: 17.99 }, 'interestRate'], [{ interestRate: 42.01 }, 'interestRate'],
    ])('хязгаараас гарсан override %j → 422 OUT_OF_PRODUCT_LIMITS (scoring дуудагдахгүй)', async (body, field) => {
      const { app } = await seed();
      const res = await http().post(url(app.id, 'preview')).set(actors.officer()).send(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OUT_OF_PRODUCT_LIMITS');
      expect(res.body.details).toEqual([expect.objectContaining({ field })]);
      expect(scoring.calls).toHaveLength(0);
    });

    it('хилийн утга (min/max) зөвшөөрөгдөнө', async () => {
      const { app } = await seed();
      expect((await http().post(url(app.id, 'preview')).set(actors.officer()).send({ amount: 100_000, termMonths: 36, interestRate: 18 })).status).toBe(200);
      expect((await http().post(url(app.id, 'preview')).set(actors.officer()).send({ amount: 50_000_000, termMonths: 1, interestRate: 42 })).status).toBe(200);
    });

    it('хадгалагдсан нөхцөл хязгаараас гарсан ч (ЗЭЗ-ийн хариуцлага) override-гүй preview 200', async () => {
      const { app } = await seed({ app: { amount: 90_000_000 } });
      expect((await http().post(url(app.id, 'preview')).set(actors.officer()).send({})).status).toBe(200);
    });

    it('нөхцөл дутуу → 422 LOAN_TERMS_MISSING; override-оор бүрэн болговол preview хийгдэнэ', async () => {
      const { app } = await seed({ app: { amount: null, termMonths: null, interestRate: null } });
      const missing = await http().post(url(app.id, 'preview')).set(actors.officer()).send({ amount: 1_000_000 });
      expect(missing.status).toBe(422);
      expect(missing.body).toMatchObject({ code: 'LOAN_TERMS_MISSING', details: [expect.objectContaining({ step: 'loan' })] });
      expect(scoring.calls).toHaveLength(0);
      const full = await http().post(url(app.id, 'preview')).set(actors.officer()).send({ amount: 1_000_000, termMonths: 6, interestRate: 30 });
      expect(full.status).toBe(200);
    });

    it('илгээгдсэн хүсэлтийг ч preview хийж болно (унших эрх); бичих үйлдэл биш', async () => {
      const { app } = await seed({ app: { status: 'SUBMITTED' } });
      expect((await http().post(url(app.id, 'preview')).set(actors.approver()).send({})).status).toBe(200);
    });

    it('буруу body → 400 VALIDATION_FAILED; scoring унасан → 503 SCORING_UNAVAILABLE', async () => {
      const { app } = await seed();
      for (const body of [{ amount: -5 }, { termMonths: 1.5 }, { interestRate: -1 }, { amount: 'x' }]) {
        const res = await http().post(url(app.id, 'preview')).set(actors.officer()).send(body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      scoring.failNext('preview');
      const down = await http().post(url(app.id, 'preview')).set(actors.officer()).send({});
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('SCORING_UNAVAILABLE');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('оролт цуглуулалт (ScoreRequest-ийн бүтэн payload)', () => {
    const previewPayload = () => scoring.callsOf('preview').at(-1)!.args[0] as ScoreRequest;

    it('цалин/ЦМУ = үндсэн + income_included хамтран зээлдэгч; өрхийн зардал = үндсэнийх; барьцаа = Σ (чөлөөлөгдсөнийг үл тооно); setting + product override; ЗМС/BSA өр = их нь', async () => {
      await setSetting('br1.dti_max', 0.5); // BR hardcode биш
      await setSetting('stress.rate_delta', 0.07);
      const { app, primaryId } = await seed({
        product: { requiresCollateral: true, maxLtv: 0.6, calcWeightThreshold: 0.8 },
        primary: { salary: 3_000_000, ncf: 1_500_000, household: 800_000 },
        co: { salary: 1_000_000, ncf: 500_000, household: 700_000, included: true },
        collateral: [8_000_000, 2_000_000.5, null, { value: 5_000_000, released: true }],
        app: { bsaSummaryJson: { status: 'ANALYZED', existingDebtServiceMonthly: 400_000, dtiPercent: 41.5, incomeReliability: 87, pendingSuspiciousCount: 2 } },
      });
      credit.value = { ficoScore: 680, activeLoanCount: 2, overdueHistoryMonths: 1, existingDebtServiceMonthly: 300_000 };
      scoring.result = { ltv: 0.42 };

      await calcOk(app.id);

      const expected: ScoreRequest = {
        applicationId: app.id, amount: 10_000_000, termMonths: 12, interestRate: 24, monthlyPayment: round2(annuityPayment(10_000_000, 24, 12)),
        salaryMonthly: 4_000_000, businessNcfMonthly: 2_000_000, householdExpenseMonthly: 800_000, existingDebtServiceMonthly: 400_000,
        collateralValueTotal: 10_000_000.5, collateralRequired: true,
        policy: { maxDti: 0.5, minDscr: 1.25, maxLtv: 0.6, weightThreshold: 0.8 }, stress: { rateDeltaPoints: 7, incomeChange: -0.2 },
      };
      expect(previewPayload()).toEqual(expected);
      expect(scoring.callsOf('calculate')[0]!.args[0]).toEqual({ request: expected, customerId: primaryId });
      expect(scoring.callsOf('scoreSosco')[0]!.args[0]).toEqual({
        applicationId: app.id, customerId: primaryId, persist: true,
        input: { ficoScore: 680, dtiPercent: 41.5, incomeReliability: 87, pendingSuspiciousCount: 2, activeLoanCount: 2, overdueHistoryMonths: 1, ltv: 0.42 },
      });
      expect(credit.calls).toEqual([{ applicationId: app.id, customerId: primaryId }]); // зөвхөн үндсэн зээлдэгчийн ЗМС
    });

    it('income_included=false хамтран зээлдэгчийн орлого орохгүй', async () => {
      const { app } = await seed({ primary: { salary: 3_000_000, ncf: 0, household: 0 }, co: { salary: 9_000_000, ncf: 9_000_000, included: false } });
      await calcOk(app.id);
      expect(previewPayload()).toMatchObject({ salaryMonthly: 3_000_000, businessNcfMonthly: 0 });
    });

    it('батлан даагчийн орлого incomeIncluded=true байсан ч орохгүй', async () => {
      const { app } = await seed();
      const g = await createCustomer(t.prisma);
      await createBorrower(t.prisma, app.id, g.id, 'GUARANTOR', { incomeIncluded: true });
      await t.prisma.incomeSummary.create({ data: { orgId: ORG, applicationId: app.id, customerId: g.id, avgSalaryMonthly: 9_000_000, businessNcfMonthly: 9_000_000, householdExpenseMonthly: 1 } });
      await calcOk(app.id);
      expect(previewPayload()).toMatchObject({ salaryMonthly: 3_000_000, householdExpenseMonthly: 0 });
    });

    it('алдагдалтай бизнес: сөрөг ЦМУ scoring-д сөргөөрөө очно', async () => {
      const { app } = await seed({ primary: { salary: 0, ncf: -250_000, household: 0 } });
      await calcOk(app.id);
      expect(previewPayload()).toMatchObject({ salaryMonthly: 0, businessNcfMonthly: -250_000 });
    });

    it('барьцаагүй бүтээгдэхүүн collateralRequired=false; барьцаа шаарддаг бол true; бүтээгдэхүүнгүй бол консерватив true', async () => {
      const a = await seed({ product: { requiresCollateral: false } });
      const b = await seed({ product: { requiresCollateral: true } });
      const c = await seed({ product: false });
      for (const [seeded, expected] of [[a, false], [b, true], [c, true]] as const) {
        await http().post(url(seeded.app.id, 'preview')).set(actors.officer()).send({});
        expect(previewPayload().collateralRequired).toBe(expected);
      }
    });

    it('ЗМС байхгүй (real горим · null): ЗМС-ээс орсон зүйл мэдэгдэхгүй, BSA өр л үлдэнэ; Sosco-д зохиомол утга орохгүй', async () => {
      const { app } = await seed({ app: { bsaSummaryJson: { status: 'DRAFT', existingDebtServiceMonthly: 250_000, dtiPercent: 99, incomeReliability: 10, pendingSuspiciousCount: 9 } } });
      scoring.result = { burdenPercent: { A_SALARY: 33.3 } };
      await calcOk(app.id);
      expect(previewPayload().existingDebtServiceMonthly).toBe(250_000);
      // DRAFT BSA: dti = сонгосон аргын burdenPercent; найдвар/сэжигтэй мэдэгдэхгүй
      expect(scoring.callsOf('scoreSosco')[0]!.args[0]).toMatchObject({
        input: { ficoScore: null, dtiPercent: 33.3, incomeReliability: null, pendingSuspiciousCount: null, activeLoanCount: null, overdueHistoryMonths: null, ltv: 0.5 },
      });
    });

    it('ЗМС дуудлага унавал "мэдэгдэхгүй"-ээр үргэлжилнэ', async () => {
      const { app } = await seed();
      credit.failure = new Error('kyc down');
      await calcOk(app.id);
      expect(previewPayload().existingDebtServiceMonthly).toBe(0);
    });

    it('ЗМС-ийн өр BSA-аас их бол ЗМС-ийнх (нэмэхгүй)', async () => {
      const { app } = await seed({ app: { bsaSummaryJson: { status: 'ANALYZED', existingDebtServiceMonthly: 100_000, dtiPercent: 10, incomeReliability: 50, pendingSuspiciousCount: 0 } } });
      credit.value = { ficoScore: null, activeLoanCount: null, overdueHistoryMonths: null, existingDebtServiceMonthly: 700_000 };
      await calcOk(app.id);
      expect(previewPayload().existingDebtServiceMonthly).toBe(700_000);
    });

    it('хуучраагүй, тэнцүү төлбөртэй ЭТХ байвал шинэ төлбөр = ЭТХ-ийн төлбөр (M07 хүртэл annuity-г орлуулна); хуучирсан ЭТХ → annuity', async () => {
      const { app } = await seed({ app: { amount: 1_200_000 } });
      const schedule = await t.prisma.repaymentSchedule.create({ data: { orgId: ORG, applicationId: app.id, paramsJson: {}, rows: { create: scheduleRows(12, 100_000, 120_000) } } });
      await calcOk(app.id);
      expect(previewPayload().monthlyPayment).toBe(120_000);
      await t.prisma.repaymentSchedule.update({ where: { id: schedule.id }, data: { isStale: true } });
      await calcOk(app.id);
      expect(previewPayload().monthlyPayment).toBe(round2(annuityPayment(1_200_000, 24, 12)));
    });

    it('createSchedule-ийн жинхэнэ annuity ЭТХ-ийг ч хүлээн авна', async () => {
      const { app } = await seed({ app: { amount: 1_200_000 } });
      await createSchedule(t.prisma, app.id, { principal: 1_200_000, rate: 24, months: 12, firstDue: '2026-11-28' });
      await calcOk(app.id);
      expect(previewPayload().monthlyPayment).toBeCloseTo(annuityPayment(1_200_000, 24, 12), 1);
    });

    it('хамгийн сүүлийн ЭТХ хуучирсан бол өмнөх (хуучраагүй) ЭТХ-г ашиглахгүй — annuity', async () => {
      const { app } = await seed({ app: { amount: 1_200_000 } });
      await t.prisma.repaymentSchedule.create({ data: { orgId: ORG, applicationId: app.id, paramsJson: {}, generatedAt: new Date('2026-10-01T00:00:00Z'), rows: { create: scheduleRows(12, 100_000, 120_000) } } });
      await t.prisma.repaymentSchedule.create({ data: { orgId: ORG, applicationId: app.id, paramsJson: {}, generatedAt: new Date('2026-10-02T00:00:00Z'), isStale: true, rows: { create: scheduleRows(12, 100_000, 130_000) } } });
      await calcOk(app.id);
      expect(previewPayload().monthlyPayment).toBe(round2(annuityPayment(1_200_000, 24, 12)));
    });

    it('өөр хүсэлтийн орлого/барьцаа/ЭТХ орохгүй', async () => {
      const mine = await seed({ primary: { salary: 1_000_000, ncf: 0, household: 0 }, collateral: [1_000_000] });
      await seed({ primary: { salary: 7_000_000, ncf: 7_000_000, household: 7_000_000 }, collateral: [7_000_000] });
      await calcOk(mine.app.id);
      expect(previewPayload()).toMatchObject({ salaryMonthly: 1_000_000, businessNcfMonthly: 0, householdExpenseMonthly: 0, collateralValueTotal: 1_000_000 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('POST calculate (FR-8.1/8.2, NFR-4)', () => {
    it('дараалал: preview → Sosco(persist) → underwrite(persist); тооцооллын мөр + Sosco-той ScoreOverview буцаана', async () => {
      const { app, primaryId } = await seed();
      const overview = await calcOk(app.id);
      const ops = scoring.calls.map((c) => c.op);
      expect(ops.indexOf('scoreSosco')).toBeGreaterThan(ops.indexOf('preview'));
      expect(ops.indexOf('calculate')).toBeGreaterThan(ops.indexOf('scoreSosco'));
      expect(ops.filter((o) => o === 'calculate' || o === 'scoreSosco')).toEqual(['scoreSosco', 'calculate']);
      expect(overview).toMatchObject({
        applicationId: app.id, editable: true, blockers: [], terms: { amount: 10_000_000 },
        calculation: { selectedMethod: 'A_SALARY', selection: 'AUTO', customerId: primaryId }, sosco: { customerId: primaryId, score: 720, grade: 'B', status: 'SCORED' },
      });
    });

    it('хүсэлтийн selected_calc_method, calc_snapshot_json, алхам score COMPLETED, аудит — нэг дор; origination өөрөө event гаргахгүй', async () => {
      const { app } = await seed();
      scoring.result = { pass: { A_SALARY: false }, ltv: 0.61 };
      const overview = await calcOk(app.id);
      const rec = overview.calculation!;

      const row = await reload(app.id);
      expect(row.selectedCalcMethod).toBe('A_SALARY');
      expect(row.calcSnapshotJson).toEqual({
        calculationId: rec.id, selectedMethod: 'A_SALARY', selection: 'AUTO', ratioKind: 'DTI', ratio: 0.3, limit: 0.55, pass: false, eligible: false, ltv: 0.61,
        soscoScore: 720, soscoGrade: 'B', computedAt: rec.computedAt, syncedAt: rec.computedAt,
      });
      const s = await step(app.id);
      expect(s).toMatchObject({ status: 'COMPLETED', staleReason: null });
      expect(s.completedAt?.toISOString()).toBe(t.clock.now().toISOString());

      const log = await audits(app.id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ orgId: ORG, entity: 'CALCULATION', entityId: rec.id, action: 'CALCULATION_COMPUTED', actorId: OFFICER, applicationId: app.id });
      expect(log[0]!.afterJson).toMatchObject({ selectedMethod: 'A_SALARY', ltv: 0.61 });
      expect(log[0]!.beforeJson).toMatchObject({ calculationId: null, selectedMethod: null });
      expect(log[0]!.correlationId).toBeTruthy();
      expect(await t.prisma.outbox.count()).toBe(0);
    });

    it('дахин тооцоолоход өмнөх төлөвийг шинэчилнэ (before = өмнөх snapshot) ба STALE алхам COMPLETED болж шалтгаан арилна', async () => {
      const { app } = await seed({ steps: { score: 'STALE' } });
      await t.prisma.loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: app.id, stepKey: 'score' } }, data: { staleReason: 'LOAN_TERMS_CHANGED' } });
      const first = (await calcOk(app.id)).calculation!;
      expect(await step(app.id)).toMatchObject({ status: 'COMPLETED', staleReason: null });
      const second = (await calcOk(app.id)).calculation!;
      expect(second.id).not.toBe(first.id);
      const log = await audits(app.id);
      expect(log.map((l) => l.entityId)).toEqual([first.id, second.id]);
      expect(log[1]!.beforeJson).toMatchObject({ calculationId: first.id, selectedMethod: 'A_SALARY' });
    });

    it('алхамын мөр байхгүй бол үүсгэнэ; LOCKED алхамд хүрэхгүй', async () => {
      const none = await seed({ steps: false });
      await calcOk(none.app.id);
      expect(await step(none.app.id)).toMatchObject({ status: 'COMPLETED' });
      const locked = await seed({ steps: { score: 'LOCKED' } });
      await calcOk(locked.app.id);
      expect(await step(locked.app.id)).toMatchObject({ status: 'LOCKED', completedAt: null });
      expect((await reload(locked.app.id)).selectedCalcMethod).toBe('A_SALARY'); // хүсэлтийн сонголт шинэчлэгдэнэ
    });

    it('арга сонгогдоогүй (орлого байхгүй): selected_calc_method=null, алхам PENDING (өмнө нь COMPLETED байсан ч)', async () => {
      const { app } = await seed({ primary: { salary: 0, ncf: 0, household: 0 }, steps: { score: 'COMPLETED' } });
      scoring.result = { autoSelected: null, applicable: { A_SALARY: false, B_BUSINESS: false, C_COMBINED: false } };
      const overview = await calcOk(app.id);
      expect(overview.calculation).toMatchObject({ selectedMethod: null });
      const row = await reload(app.id);
      expect(row.selectedCalcMethod).toBeNull();
      expect(row.calcSnapshotJson).toMatchObject({ selectedMethod: null, ratio: null, pass: null, ltv: 0.5 });
      expect(await step(app.id)).toMatchObject({ status: 'PENDING', completedAt: null });
      // Sosco-ийн dtiPercent: сонгогдсон арга байхгүй (орлогогүй) → хамгийн муу утга, «мэдэгдэхгүй» биш (жин дахин хуваарилагдаж оноо өсөхөөс сэргийлнэ)
      expect(scoring.callsOf('scoreSosco')[0]!.args[0]).toMatchObject({ input: { dtiPercent: 999.9 } });
    });

    it('нөхцөл дутуу → 422 LOAN_TERMS_MISSING; scoring дуудагдахгүй, өгөгдөл өөрчлөгдөхгүй', async () => {
      const { app } = await seed({ app: { termMonths: null } });
      const res = await calculate(app.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('LOAN_TERMS_MISSING');
      expect(res.body.details).toEqual([expect.objectContaining({ code: 'LOAN_TERMS_MISSING', step: 'loan' })]);
      expect(scoring.calls).toHaveLength(0);
      expect((await reload(app.id)).calcSnapshotJson).toBeNull();
      expect(await audits(app.id)).toHaveLength(0);
    });

    it('үндсэн зээлдэгчгүй → 422 PRIMARY_BORROWER_MISSING (Sosco/тооцоолол хадгалагдахгүй)', async () => {
      const { app } = await seed({ primary: false });
      const res = await calculate(app.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PRIMARY_BORROWER_MISSING');
      expect(scoring.callsOf('calculate')).toHaveLength(0);
      expect(scoring.callsOf('scoreSosco')).toHaveLength(0);
    });

    it('зөвхөн DRAFT/RETURNED: илгээгдсэн, батлагдсан → 409 APPLICATION_NOT_EDITABLE (scoring дуудагдахгүй); RETURNED → 200', async () => {
      for (const status of ['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'ACTIVE']) {
        const { app } = await seed({ app: { status } });
        const res = await calculate(app.id);
        expect([status, res.status]).toEqual([status, 409]);
        expect(res.body.code).toBe('APPLICATION_NOT_EDITABLE');
      }
      expect(scoring.calls).toHaveLength(0);
      const { app } = await seed({ app: { status: 'RETURNED' } });
      expect((await calculate(app.id)).status).toBe(200);
    });

    it('Sosco загвар байхгүй / хүчингүй бол A/B/C тооцоолол үргэлжилнэ (sosco=null, оноо snapshot-д null)', async () => {
      for (const code of ['SOSCO_MODEL_NOT_FOUND', 'INVALID_SOSCO_MODEL']) {
        const { app } = await seed();
        scoring.failNext('scoreSosco', new DomainError(code, 'Загвар алга', code === 'SOSCO_MODEL_NOT_FOUND' ? 404 : 422));
        const overview = await calcOk(app.id);
        expect(overview.sosco).toBeNull();
        expect(overview.calculation?.selectedMethod).toBe('A_SALARY');
        expect((await reload(app.id)).calcSnapshotJson).toMatchObject({ soscoScore: null, soscoGrade: null });
      }
    });

    it('Sosco INSUFFICIENT_DATA → оноо null, статус хэвээр, snapshot-д null', async () => {
      const { app } = await seed();
      scoring.soscoOptions = { status: 'INSUFFICIENT_DATA' };
      const overview = await calcOk(app.id);
      expect(overview.sosco).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, resultId: null });
      expect((await reload(app.id)).calcSnapshotJson).toMatchObject({ soscoScore: null, soscoGrade: null });
    });

    it('scoring унасан: preview / Sosco / underwrite-ийн алхам бүрд 503 SCORING_UNAVAILABLE, хүсэлт/алхам/аудит өөрчлөгдөхгүй', async () => {
      for (const op of ['latest', 'preview', 'scoreSosco', 'calculate'] as const) {
        const { app } = await seed({ steps: { score: 'STALE' } });
        scoring.reset();
        scoring.failNext(op);
        const res = await calculate(app.id);
        expect([op, res.status, res.body.code]).toEqual([op, 503, 'SCORING_UNAVAILABLE']);
        const row = await reload(app.id);
        expect([op, row.selectedCalcMethod, row.calcSnapshotJson]).toEqual([op, null, null]);
        expect((await step(app.id)).status).toBe('STALE');
        expect(await audits(app.id)).toHaveLength(0);
      }
    });

    it('scoring-ийн домэйн алдаа (жишээ нь METHOD_NOT_APPLICABLE) өөрчлөгдөхгүй дамжина', async () => {
      const { app } = await seed();
      scoring.failNext('calculate', new DomainError('METHOD_NOT_APPLICABLE', 'Арга хэрэглэгдэхгүй', 422));
      const res = await calculate(app.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('METHOD_NOT_APPLICABLE');
    });

    it('өмнөх ГАР сонголтыг хадгална: B гараар сонгосон → дахин тооцоолоход selectedMethod+reason дамжиж, Sosco dti нь B-ийн burdenPercent', async () => {
      const { app } = await seed();
      scoring.result = { burdenPercent: { A_SALARY: 33.3, B_BUSINESS: 12.5 } };
      await calcOk(app.id);
      const sel = await http().put(url(app.id, 'selection')).set(actors.officer()).send({ method: 'B_BUSINESS', reason: 'Бизнес давамгайлна' });
      expect(sel.status).toBe(200);
      scoring.calls.length = 0;

      const overview = await calcOk(app.id);
      const sent = scoring.callsOf('calculate')[0]!.args[0] as Record<string, unknown>;
      expect(sent).toMatchObject({ selectedMethod: 'B_BUSINESS', selectionReason: 'Бизнес давамгайлна' });
      expect(scoring.callsOf('scoreSosco')[0]!.args[0]).toMatchObject({ input: { dtiPercent: 12.5 } });
      expect(overview.calculation).toMatchObject({ selectedMethod: 'B_BUSINESS', selection: 'MANUAL', selectionReason: 'Бизнес давамгайлна' });
      expect(await reload(app.id)).toMatchObject({ selectedCalcMethod: 'B_BUSINESS' });
      expect((await reload(app.id)).calcSnapshotJson).toMatchObject({ selection: 'MANUAL', ratioKind: 'DSCR' });
    });

    it('гар сонголт хэрэглэгдэхгүй болсон бол автомат сонголт руу буцна (selectedMethod дамжуулахгүй)', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      await http().put(url(app.id, 'selection')).set(actors.officer()).send({ method: 'B_BUSINESS' });
      scoring.result = { applicable: { B_BUSINESS: false } };
      scoring.calls.length = 0;
      const overview = await calcOk(app.id);
      expect('selectedMethod' in (scoring.callsOf('calculate')[0]!.args[0] as object)).toBe(false);
      expect(overview.calculation).toMatchObject({ selectedMethod: 'A_SALARY', selection: 'AUTO' });
    });

    it('автомат сонголтыг (AUTO) дараагийн тооцоололд "гар сонголт" болгон хадгалахгүй', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.result = { autoSelected: 'C_COMBINED' };
      scoring.calls.length = 0;
      const overview = await calcOk(app.id);
      expect('selectedMethod' in (scoring.callsOf('calculate')[0]!.args[0] as object)).toBe(false);
      expect(overview.calculation).toMatchObject({ selectedMethod: 'C_COMBINED', selection: 'AUTO' });
    });

    it('зэрэгцээ тооцоололд хоцорсон хуучин үр дүн шинэ snapshot-ийг дарахгүй; хариу нь scoring-ийн сүүлийн үр дүн', async () => {
      const { app } = await seed();
      const first = (await calcOk(app.id)).calculation!;
      // шинэ snapshot (илүү хожуу цагтай) аль хэдийн бичигдсэн гэж дууриана
      const future = '2099-01-01T00:00:00.000Z';
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { selectedCalcMethod: 'C_COMBINED', calcSnapshotJson: { ...(await reload(app.id)).calcSnapshotJson as object, calculationId: 'calc-newer', selectedMethod: 'C_COMBINED', syncedAt: future } } });
      const second = (await calcOk(app.id)).calculation!;
      expect(second.id).not.toBe(first.id);
      const row = await reload(app.id);
      expect(row.selectedCalcMethod).toBe('C_COMBINED');
      expect(row.calcSnapshotJson).toMatchObject({ calculationId: 'calc-newer', syncedAt: future });
      expect(await audits(app.id)).toHaveLength(1); // хоёр дахь нь бичигдээгүй
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('PUT selection (FR-8.2)', () => {
    const select = (appId: string, body: unknown, actor: Record<string, string> = actors.officer()) => http().put(url(appId, 'selection')).set(actor).send(body as object);

    it('арга сонгоно: хариу ScoreOverview, хүсэлт/snapshot/алхам/аудит шинэчлэгдэнэ', async () => {
      const { app, primaryId } = await seed();
      scoring.result = { pass: { B_BUSINESS: false } };
      const first = (await calcOk(app.id)).calculation!;
      const res = await select(app.id, { method: 'B_BUSINESS', reason: 'Бизнес давамгайлна' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const overview = ScoreOverview.parse(res.body);
      expect(overview.calculation).toMatchObject({ id: first.id, selectedMethod: 'B_BUSINESS', selection: 'MANUAL', selectedBy: OFFICER, selectionReason: 'Бизнес давамгайлна' });
      expect(overview.sosco).toMatchObject({ customerId: primaryId, score: 720 });
      expect(overview.editable).toBe(true);

      const row = await reload(app.id);
      expect(row.selectedCalcMethod).toBe('B_BUSINESS');
      expect(row.calcSnapshotJson).toMatchObject({ calculationId: first.id, selectedMethod: 'B_BUSINESS', selection: 'MANUAL', ratioKind: 'DSCR', limit: 1.25, pass: false, eligible: false, soscoScore: 720, soscoGrade: 'B' });
      expect(await step(app.id)).toMatchObject({ status: 'COMPLETED' });
      const log = await audits(app.id);
      expect(log.map((l) => l.action)).toEqual(['CALCULATION_COMPUTED', 'CALCULATION_METHOD_SELECTED']);
      expect(log[1]).toMatchObject({ entityId: first.id, actorId: OFFICER });
      expect(log[1]!.beforeJson).toMatchObject({ selectedMethod: 'A_SALARY', selection: 'AUTO' });
    });

    it('хэрэглэгдэхгүй арга → 422 METHOD_NOT_APPLICABLE; юу ч өөрчлөгдөхгүй', async () => {
      const { app } = await seed();
      scoring.result = { applicable: { B_BUSINESS: false } };
      await calcOk(app.id);
      const before = await reload(app.id);
      const res = await select(app.id, { method: 'B_BUSINESS' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('METHOD_NOT_APPLICABLE');
      expect((await reload(app.id)).calcSnapshotJson).toEqual(before.calcSnapshotJson);
      expect(await audits(app.id)).toHaveLength(1);
    });

    it('тооцоолол байхгүй → 404 CALCULATION_NOT_FOUND', async () => {
      const { app } = await seed();
      const res = await select(app.id, { method: 'A_SALARY' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CALCULATION_NOT_FOUND');
    });

    it('scoring-д хуучирсан тооцоолол → 409 CALCULATION_STALE (scoring-ийн алдаа дамжина)', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      await scoring.markStale({} as never, app.id, { reason: 'X' });
      const res = await select(app.id, { method: 'A_SALARY' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CALCULATION_STALE');
    });

    it('алхам STALE (markStale scoring-д хүрээгүй ч) → 409 CALCULATION_STALE, scoring-ийн select дуудагдахгүй', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.failNext('markStale');
      await t.app.get(ScoreService).markStale(ctxOf(), app.id, 'LOAN_TERMS_CHANGED');
      scoring.calls.length = 0;
      const res = await select(app.id, { method: 'A_SALARY' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CALCULATION_STALE', details: { reason: 'LOAN_TERMS_CHANGED' } });
      expect(scoring.callsOf('select')).toHaveLength(0);
      // дахин тооцоолсны дараа сонгож болно
      await calcOk(app.id);
      expect((await select(app.id, { method: 'C_COMBINED' })).status).toBe(200);
    });

    it('илгээгдсэн хүсэлтэд → 409 APPLICATION_NOT_EDITABLE', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      await t.prisma.loanApplication.update({ where: { id: app.id }, data: { status: 'SUBMITTED' } });
      const res = await select(app.id, { method: 'B_BUSINESS' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('APPLICATION_NOT_EDITABLE');
      expect(scoring.callsOf('select')).toHaveLength(0);
    });

    it.each([[{ method: 'X' }], [{}], [{ method: 'B_BUSINESS', reason: 'x'.repeat(501) }], [{ method: 'B_BUSINESS', reason: 5 }]])('буруу body %j → 400 VALIDATION_FAILED', async (body) => {
      const { app } = await seed();
      await calcOk(app.id);
      const res = await select(app.id, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('scoring унасан → 503, төлөв өөрчлөгдөхгүй', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.failNext('select');
      const res = await select(app.id, { method: 'B_BUSINESS' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SCORING_UNAVAILABLE');
      expect((await reload(app.id)).selectedCalcMethod).toBe('A_SALARY');
    });

    it('Sosco-г уншиж чадаагүй ч сонголт хийгдэнэ; snapshot-ийн өмнөх оноо хадгалагдана', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.failNext('latestSosco');
      const res = await select(app.id, { method: 'C_COMBINED' });
      expect(res.status).toBe(200);
      expect(res.body.sosco).toBeNull();
      expect((await reload(app.id)).calcSnapshotJson).toMatchObject({ selectedMethod: 'C_COMBINED', soscoScore: 720, soscoGrade: 'B' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════
  describe('ScoreService.markStale (FR-7.3)', () => {
    const service = () => t.app.get(ScoreService);

    it('алхам COMPLETED → STALE (шалтгаантай) ба scoring-ийн тооцоолол хуучирна; аудит бичигдэнэ', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      const result = await service().markStale(ctxOf(), app.id, 'LOAN_TERMS_CHANGED');
      expect(result).toEqual({ stepMarked: true, scoringMarked: true });
      expect(await step(app.id)).toMatchObject({ status: 'STALE', staleReason: 'LOAN_TERMS_CHANGED' });
      expect(scoring.callsOf('markStale')[0]!.args).toEqual([app.id, { reason: 'LOAN_TERMS_CHANGED' }]);
      expect(scoring.records.get(app.id)).toMatchObject({ isStale: true, staleReason: 'LOAN_TERMS_CHANGED' });
      const log = await audits(app.id);
      expect(log.at(-1)).toMatchObject({ action: 'CALCULATION_MARKED_STALE', actorId: OFFICER });
      expect(log.at(-1)!.afterJson).toEqual({ step: 'STALE', reason: 'LOAN_TERMS_CHANGED' });
    });

    it('идемпотент: дахин дуудахад алхам/аудит өөрчлөгдөхгүй (stepMarked=false)', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      await service().markStale(ctxOf(), app.id, 'FIRST');
      const again = await service().markStale(ctxOf(), app.id, 'SECOND');
      expect(again).toEqual({ stepMarked: false, scoringMarked: true });
      expect(await step(app.id)).toMatchObject({ status: 'STALE', staleReason: 'FIRST' });
      expect((await audits(app.id)).filter((a) => a.action === 'CALCULATION_MARKED_STALE')).toHaveLength(1);
    });

    it('COMPLETED биш алхамд (PENDING / LOCKED) хүрэхгүй, ч scoring-д мэдэгдэнэ', async () => {
      const pending = await seed();
      const locked = await seed({ steps: { score: 'LOCKED' } });
      expect(await service().markStale(ctxOf(), pending.app.id, 'X')).toEqual({ stepMarked: false, scoringMarked: true });
      expect(await service().markStale(ctxOf(), locked.app.id, 'X')).toEqual({ stepMarked: false, scoringMarked: true });
      expect((await step(pending.app.id)).status).toBe('PENDING');
      expect((await step(locked.app.id)).status).toBe('LOCKED');
    });

    it('scoring унасан ч шидэхгүй: алхам STALE болж, scoringMarked=false', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      scoring.failNext('markStale');
      expect(await service().markStale(ctxOf(), app.id, 'LOAN_TERMS_CHANGED')).toEqual({ stepMarked: true, scoringMarked: false });
      expect((await step(app.id)).status).toBe('STALE');
    });

    it('scoring-ийн бусад (программын) алдаа дамжина', async () => {
      const { app } = await seed();
      scoring.failNext('markStale', new Error('bug'));
      await expect(service().markStale(ctxOf(), app.id, 'X')).rejects.toThrow('bug');
    });

    it('олдохгүй / өөр байгууллагын хүсэлт → 404; 200-аас урт шалтгаан таслагдана', async () => {
      await expect(service().markStale(ctxOf(), '00000000-0000-4000-8000-00000000dead', 'X')).rejects.toMatchObject({ code: 'APPLICATION_NOT_FOUND', status: 404 });
      const { app } = await seed();
      await expect(service().markStale({ ...ctxOf(), orgId: 'other' }, app.id, 'X')).rejects.toMatchObject({ status: 404 });
      await calcOk(app.id);
      await service().markStale(ctxOf(), app.id, 'R'.repeat(300));
      expect((await step(app.id)).staleReason).toHaveLength(200);
    });

    it('хоосон шалтгаан дуудагчийг унагаахгүй (өөрчлөлт аль хэдийн commit хийгдсэн): стандарт шалтгаан бичигдэнэ', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      expect(await service().markStale(ctxOf(), app.id, '   ')).toEqual({ stepMarked: true, scoringMarked: true });
      const row = await step(app.id);
      expect(row.status).toBe('STALE');
      expect(row.staleReason).toBeTruthy();
      expect(scoring.callsOf('markStale')[0]!.args).toEqual([app.id, { reason: row.staleReason }]);
    });

    it('хуучирсны дараа дахин тооцоолбол алхам COMPLETED болж шалтгаан арилна', async () => {
      const { app } = await seed();
      await calcOk(app.id);
      await service().markStale(ctxOf(), app.id, 'LOAN_TERMS_CHANGED');
      await calcOk(app.id);
      expect(await step(app.id)).toMatchObject({ status: 'COMPLETED', staleReason: null });
    });
  });

  /** Ямар ч контекст: `markStale`-ийг бусад модуль өөрийн ctx-оор дууддаг. */
  function ctxOf() {
    return { userId: OFFICER, roles: ['OFFICER'], branchId: BRANCH, orgId: ORG, customerId: null, correlationId: 'corr-test' };
  }
});

/** n мөр: үндсэн төлбөр тогтмол, нийт төлбөр тогтмол (annuity-төст), сүүлийн мөр үлдэгдлээр. */
function scheduleRows(n: number, principal: number, total: number) {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1, dueDate: new Date(Date.UTC(2026, 10 + i, 28)), days: 30, disbursement: 0, principal, interest: total - principal, total, balance: principal * (n - i - 1),
  }));
}
