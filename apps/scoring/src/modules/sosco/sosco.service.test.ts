// SoscoService — жинхэнэ PostgreSQL. Docs/05 §3, FR-5.5 (Sosco → үнэ тогтоолт).
import { DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS, soscoScore } from '@los/calc';
import { SoscoScoreRequest, SoscoScoreResponse, SoscoSummary } from '@los/contracts';
import { FixedClock, SystemClock, type Clock } from '@los/nest-common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { ctxOf, EMPTY_SOSCO_INPUT, FULL_SOSCO_INPUT, ORG, OTHER_ORG, resetM8Tables, restoreSeed } from '../underwriting/testing/m8';
import { SoscoModelService } from './sosco-model.service';
import { SoscoService, stableComponents } from './sosco.service';

const officer = ctxOf('officer');
const admin = ctxOf('admin');
const req = (over: Partial<SoscoScoreRequest> = {}): SoscoScoreRequest => ({ applicationId: 'app-s-1', customerId: 'cust-s-1', input: FULL_SOSCO_INPUT, persist: true, ...over });
const expected = (input = FULL_SOSCO_INPUT, version = 1) => soscoScore(input, DEFAULT_SOSCO_WEIGHTS, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_CURVES, version);

describe.skipIf(!process.env.TEST_DATABASE_URL)('SoscoService (PostgreSQL)', () => {
  const db = new PrismaService();
  const models = (clock: Clock = new SystemClock()) => new SoscoModelService(db, clock);
  const service = (clock: Clock = new SystemClock()) => new SoscoService(db, models(clock), clock);

  beforeAll(async () => {
    await db.$connect();
  });
  afterAll(async () => {
    await restoreSeed(db);
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetM8Tables(db);
  });

  describe('score', () => {
    it('SCORED + persist: returns the @los/calc result and stores sosco_result (score, grade, inputs, breakdown, model)', async () => {
      const res = await service().score(officer, req());
      const want = expected();
      expect(SoscoScoreResponse.safeParse(res).success).toBe(true);
      expect(res).toMatchObject({ status: 'SCORED', score: want.score, grade: want.grade, coverage: want.coverage, modelVersion: 1 });
      expect(res.components).toEqual(stableComponents(want.components));
      expect(res.resultId).toEqual(expect.any(String));

      const model = await db.soscoModel.findFirstOrThrow({ where: { orgId: ORG, isActive: true } });
      expect(res.modelId).toBe(model.id);
      const row = await db.soscoResult.findUniqueOrThrow({ where: { id: res.resultId! } });
      expect(row).toMatchObject({ orgId: ORG, applicationId: 'app-s-1', customerId: 'cust-s-1', modelId: model.id, score: want.score, grade: want.grade, createdBy: officer.userId });
      expect(row.inputsJson).toEqual(FULL_SOSCO_INPUT);
      expect(row.breakdownJson).toEqual({ components: stableComponents(want.components), coverage: want.coverage });
      expect(row.computedAt.toISOString()).toBe(res.computedAt);
    });

    it('POST response and the stored breakdown are IDENTICAL even for repeating-decimal weights (Prisma Json 1-ULP regression)', async () => {
      // fico+dti+history мэдэгдэнэ → effectiveWeight 3/7, 5/14, 3/14 (17 оронт float: 0.21428571428571427 нь Json-д 1 ULP хазайдаг байсан)
      const partial = { ...EMPTY_SOSCO_INPUT, ficoScore: 576, dtiPercent: 31.6, overdueHistoryMonths: 0, activeLoanCount: 0 };
      const res = await service().score(officer, req({ input: partial }));
      expect(res.status).toBe('SCORED');
      expect(res.components.find((c) => c.key === 'history')!.effectiveWeight).toBe(0.214285714285714);
      const row = await db.soscoResult.findUniqueOrThrow({ where: { id: res.resultId! } });
      expect(row.breakdownJson).toEqual({ components: res.components, coverage: res.coverage });
      const latest = await service().latest(officer, 'app-s-1', 'cust-s-1');
      expect(latest.components).toEqual(res.components);
      const sum = res.components.reduce((a, c) => a + c.effectiveWeight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
    });

    it('persist=false computes without storing (resultId null)', async () => {
      const res = await service().score({ ...officer, userId: null }, req({ persist: false })); // хадгалахгүй бол хариуцагч заавал биш
      expect(res).toMatchObject({ status: 'SCORED', resultId: null });
      expect(res.score).toBe(expected().score);
      expect(await db.soscoResult.count()).toBe(0);
    });

    it('INSUFFICIENT_DATA is returned (score null) but NEVER persisted, even with persist=true (FR-5.5 → default tier)', async () => {
      const none = await service().score(officer, req({ input: EMPTY_SOSCO_INPUT }));
      expect(none).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, resultId: null, coverage: 0 });
      expect(SoscoScoreResponse.safeParse(none).success).toBe(true);
      // coverage 0.25 (reliability 0.15 + suspicious 0.10) < minCoverage 0.5
      const partial = await service().score(officer, req({ input: { ...EMPTY_SOSCO_INPUT, incomeReliability: 90, pendingSuspiciousCount: 0 } }));
      expect(partial).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, coverage: 0.25, resultId: null });
      expect(await db.soscoResult.count()).toBe(0);
      // яг босго (0.5): dti 0.25 + reliability 0.15 + suspicious 0.10 → оноотой
      const enough = await service().score(officer, req({ input: { ...EMPTY_SOSCO_INPUT, dtiPercent: 40, incomeReliability: 90, pendingSuspiciousCount: 0 } }));
      expect(enough).toMatchObject({ status: 'SCORED', coverage: 0.5 });
      expect(enough.resultId).not.toBeNull();
    });

    it('creates the DEMO model on first use (no SOSCO_MODEL_NOT_FOUND) and always uses the ACTIVE version; older results keep their model', async () => {
      const first = await service().score(officer, req());
      expect(first.modelVersion).toBe(1);
      await models().save(admin, { weights: { fico: 0.5, dti: 0.1, reliability: 0.1, suspicious: 0.1, history: 0.1, ltv: 0.1 }, gradeThresholds: { A: 900, B: 800, C: 700, D: 600, E: 0 } });
      const second = await service().score(officer, req());
      expect(second.modelVersion).toBe(2);
      expect(second.modelId).not.toBe(first.modelId);
      expect(second.score).not.toBe(first.score);
      const rows = await db.soscoResult.findMany({ orderBy: { computedAt: 'asc' }, include: { model: true } });
      expect(rows.map((r) => r.model.version)).toEqual([1, 2]);
    });

    it('a corrupt stored model → 422 INVALID_SOSCO_MODEL (not a 500), nothing stored', async () => {
      await db.soscoModel.create({ data: { orgId: ORG, version: 1, weightsJson: { ...DEFAULT_SOSCO_WEIGHTS, fico: 0.9 }, gradeThresholdsJson: DEFAULT_SOSCO_GRADE_THRESHOLDS, isActive: true } });
      await expect(service().score(officer, req())).rejects.toMatchObject({ code: 'INVALID_SOSCO_MODEL', status: 422 });
      expect(await db.soscoResult.count()).toBe(0);
    });

    it('persisting needs an accountable user → 401', async () => {
      await expect(service().score({ ...officer, userId: null }, req())).rejects.toMatchObject({ status: 401 });
      expect(await db.soscoResult.count()).toBe(0);
    });

    it('parallel first use (no model yet): one model is created and every score is stored against it', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => service().score(officer, req({ applicationId: `app-par-${i}` }))));
      expect(new Set(results.map((r) => r.modelId)).size).toBe(1);
      expect(await db.soscoModel.count()).toBe(1);
      expect(await db.soscoResult.count()).toBe(8);
    });
  });

  describe('latest', () => {
    it('404 NOT_FOUND until a score is stored; INSUFFICIENT_DATA never makes one', async () => {
      await expect(service().latest(officer, 'app-s-1', 'cust-s-1')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      await service().score(officer, req({ input: EMPTY_SOSCO_INPUT }));
      await expect(service().latest(officer, 'app-s-1', 'cust-s-1')).rejects.toMatchObject({ status: 404 });
    });

    it('returns the NEWEST stored score as a SoscoSummary (model version from the producing model), scoped to org, application and customer', async () => {
      const clock = new FixedClock(new Date('2026-10-29T01:00:00.000Z'));
      await service(clock).score(officer, req({ input: { ...FULL_SOSCO_INPUT, ficoScore: 500 } }));
      clock.set(new Date('2026-10-29T03:00:00.000Z'));
      const newest = await service(clock).score(officer, req());
      clock.set(new Date('2026-10-29T02:00:00.000Z'));
      await service(clock).score(officer, req({ input: { ...FULL_SOSCO_INPUT, ficoScore: 600 } })); // дунд (цагаар)
      await service().score(officer, req({ customerId: 'cust-s-2', input: { ...FULL_SOSCO_INPUT, ficoScore: 300 } }));
      await service().score(ctxOf('otherOrgOfficer'), req({ input: { ...FULL_SOSCO_INPUT, ficoScore: 300 } }));

      const latest = await service().latest(officer, 'app-s-1', 'cust-s-1');
      expect(SoscoSummary.safeParse(latest).success).toBe(true);
      expect(latest).toMatchObject({ resultId: newest.resultId, customerId: 'cust-s-1', status: 'SCORED', score: newest.score, grade: newest.grade, coverage: newest.coverage, modelVersion: 1, computedAt: '2026-10-29T03:00:00.000Z' });
      expect(latest.components).toEqual(newest.components);

      await expect(service().latest(officer, 'app-s-1', 'cust-s-3')).rejects.toMatchObject({ status: 404 });
      await expect(service().latest(officer, 'app-other', 'cust-s-1')).rejects.toMatchObject({ status: 404 });
      const other = await service().latest(ctxOf('otherOrgOfficer'), 'app-s-1', 'cust-s-1');
      expect(other.score).not.toBe(latest.score);
      expect(other.modelVersion).toBe(1); // тус байгууллагынх нь DEMO v1
      expect(await db.soscoModel.count({ where: { orgId: OTHER_ORG } })).toBe(1);
    });
  });
});
