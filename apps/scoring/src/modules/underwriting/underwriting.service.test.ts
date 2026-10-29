// UnderwritingService — жинхэнэ PostgreSQL (TEST_DATABASE_URL, нэр `test`-ээр төгснө). FR-8.1…8.6, BR-1…BR-5.
// Хамрах: сонголт (AUTO/MANUAL/хэрэглэгдэхгүй), сүүлийн тооцоолол, хуучирсан, ScoringCompleted outbox, атомик байдал, зэрэгцээ бичилт, байгууллагын тусгаарлал.
import { underwrite } from '@los/calc';
import { CalculationRecord, DomainEvent, ScoringCompleted } from '@los/contracts';
import { Clock, FixedClock, SystemClock } from '@los/nest-common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import {
  businessRequest, ctxOf, failOutboxInserts, mixedRequest, noIncomeRequest, ORG, OTHER_ORG, outboxEvents, resetM8Tables, restoreSeed, scoreRequest,
} from './testing/m8';
import { UnderwritingService } from './underwriting.service';

const CUSTOMER = 'cust-m8-1';
const officer = ctxOf('officer');

describe.skipIf(!process.env.TEST_DATABASE_URL)('UnderwritingService (PostgreSQL)', () => {
  const db = new PrismaService();
  const service = (clock: Clock = new SystemClock()) => new UnderwritingService(db, clock);
  const persist = (req = scoreRequest(), extra: Record<string, unknown> = {}, svc = service()) => svc.persist(officer, { request: req, customerId: CUSTOMER, ...extra });

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

  describe('preview', () => {
    it('is the pure underwrite result and never touches the DB or the outbox (FR-8.3)', async () => {
      const untouched = new Proxy({}, { get: () => { throw new Error('preview must not touch the database'); } }) as unknown as PrismaService;
      const svc = new UnderwritingService(untouched, new SystemClock());
      const req = scoreRequest();
      expect(svc.preview(req)).toEqual(underwrite(req));
      // жинхэнэ DB дээр ч мөр, event нэмэгдэхгүй
      service().preview(req);
      expect(await db.calculation.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
    });
  });

  describe('persist', () => {
    it('AUTO: salary-dominant income selects A_SALARY (BR-4); stores inputs, result, the three verdicts, policy check and stress', async () => {
      const req = scoreRequest();
      const record = await persist(req);
      expect(CalculationRecord.safeParse(record).success).toBe(true);
      expect(record).toMatchObject({ applicationId: 'app-m8-1', customerId: CUSTOMER, isStale: false, staleReason: null, selectedMethod: 'A_SALARY', selection: 'AUTO', selectedBy: null, selectionReason: null });
      expect(record.selectedAt).not.toBeNull();
      expect(record.inputs).toEqual(req);
      expect(record.result).toEqual(underwrite(req));

      const row = await db.calculation.findUniqueOrThrow({ where: { id: record.id } });
      expect(row).toMatchObject({ orgId: ORG, applicationId: 'app-m8-1', customerId: CUSTOMER, autoSelectedMethod: 'A_SALARY', selectedMethod: 'A_SALARY', selectedBy: null, createdBy: officer.userId });
      expect([row.methodAJson, row.methodBJson, row.methodCJson]).toEqual(record.result.methods);
      expect(row.resultJson).toEqual(record.result);
      expect(row.inputsJson).toEqual(req);
      expect(row.policyCheckJson).toMatchObject({ dti: { limit: 0.55 }, dscr: { limit: 1.25 }, dscrCombined: { limit: 1.25 }, ltv: { limit: 0.7 } });
      expect(row.stressJson).toMatchObject({ rateDeltaPoints: 5, incomeChange: -0.2 });
    });

    it('AUTO follows BR-4: business-dominant → B_BUSINESS, mixed → C_COMBINED (policy weightThreshold comes from the request, not code)', async () => {
      expect((await persist(businessRequest({ applicationId: 'app-b' }))).selectedMethod).toBe('B_BUSINESS');
      expect((await persist(mixedRequest({ applicationId: 'app-c' }))).selectedMethod).toBe('C_COMBINED');
      // босгыг 0.5 болгобол 2:1 харьцаатай цалин давамгайлна
      const skewed = scoreRequest({ applicationId: 'app-t', salaryMonthly: 3_000_000, businessNcfMonthly: 1_500_000 });
      expect((await persist(skewed)).selectedMethod).toBe('C_COMBINED'); // 0.667 ≤ 0.7
      expect((await persist({ ...skewed, applicationId: 'app-t2', policy: { ...skewed.policy, weightThreshold: 0.5 } })).selectedMethod).toBe('A_SALARY');
    });

    it('MANUAL: an applicable requested method wins over auto; selected_by/reason/selected_at stored; ScoringCompleted names it', async () => {
      const record = await persist(scoreRequest(), { selectedMethod: 'C_COMBINED', selectionReason: 'Хамтарсан орлого' });
      expect(record).toMatchObject({ selectedMethod: 'C_COMBINED', selection: 'MANUAL', selectedBy: officer.userId, selectionReason: 'Хамтарсан орлого' });
      expect(record.result.autoSelected).toBe('A_SALARY'); // автомат санал хэвээр
      const [event] = await outboxEvents(db, 'ScoringCompleted');
      expect(event).toMatchObject({ selectedMethod: 'C_COMBINED', dtiPercent: record.result.methods[2]!.burdenPercent });
    });

    it('a requested method without an income base → 422 METHOD_NOT_APPLICABLE and NOTHING is stored (FR-8.6)', async () => {
      await expect(persist(scoreRequest(), { selectedMethod: 'B_BUSINESS' })).rejects.toMatchObject({ code: 'METHOD_NOT_APPLICABLE', status: 422 });
      expect(await db.calculation.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
    });

    it('no income at all: the calculation is stored without a selection and NO event is emitted', async () => {
      const record = await persist(noIncomeRequest());
      expect(record).toMatchObject({ selectedMethod: null, selection: null, selectedBy: null, selectedAt: null });
      expect(record.result.autoSelected).toBeNull();
      expect(await db.outbox.count()).toBe(0);
      expect(CalculationRecord.safeParse(record).success).toBe(true);
      await expect(service().select(officer, 'app-m8-1', { method: 'A_SALARY' })).rejects.toMatchObject({ code: 'METHOD_NOT_APPLICABLE' });
    });

    it('ScoringCompleted (v1) is in scoring.outbox in the same commit: parses with DomainEvent, carries selectedMethod, dtiPercent = burdenPercent, soscoScore null without a Sosco result', async () => {
      const record = await persist();
      const rows = await db.outbox.findMany();
      expect(rows).toHaveLength(1);
      const event = DomainEvent.parse(rows[0]!.payload);
      expect(rows[0]).toMatchObject({ type: 'ScoringCompleted', id: event.eventId, publishedAt: null });
      expect(ScoringCompleted.parse(event)).toMatchObject({
        applicationId: 'app-m8-1', selectedMethod: 'A_SALARY', soscoScore: null, dtiPercent: 41.7, orgId: ORG, actorId: officer.userId, correlationId: 'corr-test-1', version: 1,
      });
      expect(record.result.methods[0]!.burdenPercent).toBe(41.7); // (200 000 + 1 050 000) ÷ 3 000 000 × 100, дээш 1 орон
    });

    it('soscoScore = the NEWEST sosco_result of (org, application, customer); other customers, applications and organisations are ignored', async () => {
      const model = await db.soscoModel.create({ data: { orgId: ORG, version: 1, weightsJson: {}, gradeThresholdsJson: {}, isActive: true } });
      const at = (s: string) => new Date(`2026-10-29T0${s}:00:00.000Z`);
      const result = (score: number, over: Record<string, unknown>) => db.soscoResult.create({ data: { orgId: ORG, applicationId: 'app-m8-1', customerId: CUSTOMER, modelId: model.id, score, grade: 'C', computedAt: at('1'), ...over } });
      await result(640, { computedAt: at('1') });
      await result(810, { computedAt: at('3') }); // хамгийн шинэ
      await result(700, { computedAt: at('2') });
      await result(999, { customerId: 'someone-else', computedAt: at('5') });
      await result(998, { applicationId: 'other-app', computedAt: at('5') });
      await result(997, { orgId: OTHER_ORG, computedAt: at('5') });
      await persist();
      const [event] = await outboxEvents(db, 'ScoringCompleted');
      expect(event!.soscoScore).toBe(810);
    });
  });

  describe('latest', () => {
    it('404 CALCULATION_NOT_FOUND without a calculation', async () => {
      await expect(service().latest(officer, 'app-m8-1')).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND', status: 404 });
    });

    it('persist → latest round trip is identical and satisfies CalculationRecord; a newer persist replaces it; other applications are independent', async () => {
      const first = await persist();
      expect(await service().latest(officer, 'app-m8-1')).toEqual(first);
      const second = await persist(scoreRequest({ amount: 15_000_000 }));
      const latest = await service().latest(officer, 'app-m8-1');
      expect(latest).toEqual(second);
      expect(latest.id).not.toBe(first.id);
      expect(CalculationRecord.safeParse(latest).success).toBe(true);
      await expect(service().latest(officer, 'app-other')).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND' });
      expect(await db.calculation.count({ where: { applicationId: 'app-m8-1' } })).toBe(2); // түүх хадгалагдана
    });

    it('computed_at is strictly increasing even when the clock does not advance or goes backwards, so "latest" is the last stored', async () => {
      const clock = new FixedClock(new Date('2026-10-29T03:00:00.000Z'));
      const a = await persist(scoreRequest(), {}, service(clock));
      const b = await persist(scoreRequest({ amount: 15_000_000 }), {}, service(clock)); // цаг өөрчлөгдөөгүй
      clock.set(new Date('2026-10-29T02:00:00.000Z'));
      const c = await persist(scoreRequest({ amount: 12_000_000 }), {}, service(clock)); // цаг ухарсан
      expect(Date.parse(b.computedAt)).toBe(Date.parse(a.computedAt) + 1);
      expect(Date.parse(c.computedAt)).toBe(Date.parse(b.computedAt) + 1);
      expect((await service().latest(officer, 'app-m8-1')).id).toBe(c.id);
    });
  });

  describe('select (FR-8.2)', () => {
    it('switches the latest calculation to MANUAL with the actor, reason and time, and emits ScoringCompleted for the new method', async () => {
      await persist();
      const clock = new FixedClock(new Date('2026-10-29T05:00:00.000Z'));
      const approverLike = ctxOf('officerB', 'corr-select');
      const record = await service(clock).select(approverLike, 'app-m8-1', { method: 'C_COMBINED', reason: 'Бизнесийн орлого нэмэгдсэн' });
      expect(record).toMatchObject({ selectedMethod: 'C_COMBINED', selection: 'MANUAL', selectedBy: approverLike.userId, selectionReason: 'Бизнесийн орлого нэмэгдсэн', selectedAt: '2026-10-29T05:00:00.000Z' });
      expect(CalculationRecord.safeParse(record).success).toBe(true);
      expect(await service().latest(officer, 'app-m8-1')).toEqual(record);
      const events = await outboxEvents(db, 'ScoringCompleted');
      expect(events).toHaveLength(2); // persist (AUTO) + select
      expect(events[1]).toMatchObject({ selectedMethod: 'C_COMBINED', dtiPercent: record.result.methods[2]!.burdenPercent, correlationId: 'corr-select', actorId: approverLike.userId });
    });

    it('404 CALCULATION_NOT_FOUND without a calculation; 409 CALCULATION_STALE when stale (checked before applicability); 422 METHOD_NOT_APPLICABLE', async () => {
      await expect(service().select(officer, 'app-m8-1', { method: 'A_SALARY' })).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND', status: 404 });
      await persist();
      await expect(service().select(officer, 'app-m8-1', { method: 'B_BUSINESS' })).rejects.toMatchObject({ code: 'METHOD_NOT_APPLICABLE', status: 422 });
      await service().markStale(officer, 'app-m8-1', { reason: 'Хүү өөрчлөгдсөн' });
      await expect(service().select(officer, 'app-m8-1', { method: 'A_SALARY' })).rejects.toMatchObject({ code: 'CALCULATION_STALE', status: 409 });
      await expect(service().select(officer, 'app-m8-1', { method: 'B_BUSINESS' })).rejects.toMatchObject({ code: 'CALCULATION_STALE', status: 409 });
      expect(await db.outbox.count()).toBe(1); // зөвхөн persist-ийн event
    });

    it('a new persist after stale gives a fresh, selectable calculation', async () => {
      await persist();
      await service().markStale(officer, 'app-m8-1', { reason: 'Дүн өөрчлөгдсөн' });
      const fresh = await persist(scoreRequest({ amount: 18_000_000 }));
      expect(fresh.isStale).toBe(false);
      await expect(service().select(officer, 'app-m8-1', { method: 'C_COMBINED' })).resolves.toMatchObject({ id: fresh.id, selectedMethod: 'C_COMBINED' });
    });
  });

  describe('markStale (FR-7.3)', () => {
    it('marks only the latest calculation stale with the reason; idempotent — a repeat keeps the first reason and changes nothing', async () => {
      const older = await persist(scoreRequest({ amount: 10_000_000 }));
      const latest = await persist();
      const stale = await service().markStale(officer, 'app-m8-1', { reason: 'Хүү өөрчлөгдсөн' });
      expect(stale).toMatchObject({ id: latest.id, isStale: true, staleReason: 'Хүү өөрчлөгдсөн', selectedMethod: 'A_SALARY' });
      expect(CalculationRecord.safeParse(stale).success).toBe(true);
      const before = await db.calculation.findUniqueOrThrow({ where: { id: latest.id } });
      await new Promise((r) => setTimeout(r, 15));
      const again = await service().markStale(ctxOf('officerB'), 'app-m8-1', { reason: 'Өөр шалтгаан' });
      expect(again).toEqual(stale);
      const after = await db.calculation.findUniqueOrThrow({ where: { id: latest.id } });
      expect(after.updatedAt).toEqual(before.updatedAt); // мөр шинэчлэгдээгүй
      expect(after.updatedBy).toBe(officer.userId);
      expect((await db.calculation.findUniqueOrThrow({ where: { id: older.id } })).isStale).toBe(false);
    });

    it('404 CALCULATION_NOT_FOUND when there is none', async () => {
      await expect(service().markStale(officer, 'app-m8-1', { reason: 'x' })).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND', status: 404 });
    });
  });

  describe('organisation isolation (NFR-3)', () => {
    it('another organisation sees nothing and cannot select or stale; its own application ids are independent', async () => {
      await persist();
      const other = ctxOf('otherOrgOfficer');
      await expect(service().latest(other, 'app-m8-1')).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND' });
      await expect(service().select(other, 'app-m8-1', { method: 'A_SALARY' })).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND' });
      await expect(service().markStale(other, 'app-m8-1', { reason: 'x' })).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND' });
      // өөр байгууллага ижил applicationId-аар өөрийн тооцооллыг үүсгэж болно; эхнийх нь хөндөгдөхгүй
      const theirs = await service().persist(other, { request: scoreRequest({ amount: 9_000_000 }), customerId: 'cust-x' });
      expect((await service().latest(officer, 'app-m8-1')).inputs.amount).toBe(20_000_000);
      expect((await service().latest(other, 'app-m8-1')).id).toBe(theirs.id);
      expect((await db.outbox.findMany()).map((r) => (r.payload as { orgId: string }).orgId).sort()).toEqual([ORG, OTHER_ORG].sort());
      expect((await service().latest(officer, 'app-m8-1')).isStale).toBe(false);
    });
  });

  describe('identity', () => {
    it('writes need an accountable user (NFR-4): no X-User-Id → 401 UNAUTHENTICATED, nothing stored', async () => {
      const anonymous = { ...officer, userId: null };
      await expect(service().persist(anonymous, { request: scoreRequest(), customerId: CUSTOMER })).rejects.toMatchObject({ status: 401 });
      await persist();
      await expect(service().select(anonymous, 'app-m8-1', { method: 'A_SALARY' })).rejects.toMatchObject({ status: 401 });
      await expect(service().markStale(anonymous, 'app-m8-1', { reason: 'x' })).rejects.toMatchObject({ status: 401 });
      expect(await db.calculation.count()).toBe(1);
    });
  });

  describe('atomicity — the calculation and its ScoringCompleted commit together', () => {
    it('persist: an outbox failure AFTER the calculation insert rolls the calculation back', async () => {
      const restore = await failOutboxInserts(db);
      try {
        await expect(persist()).rejects.toThrow();
      } finally {
        await restore();
      }
      expect(await db.calculation.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
      await expect(service().latest(officer, 'app-m8-1')).rejects.toMatchObject({ code: 'CALCULATION_NOT_FOUND' });
    });

    it('select: an outbox failure after the update leaves the previous (AUTO) selection untouched', async () => {
      const original = await persist();
      const restore = await failOutboxInserts(db);
      try {
        await expect(service().select(officer, 'app-m8-1', { method: 'C_COMBINED', reason: 'x' })).rejects.toThrow();
      } finally {
        await restore();
      }
      expect(await service().latest(officer, 'app-m8-1')).toEqual(original);
      expect(await db.outbox.count()).toBe(1);
    });
  });

  describe('concurrency', () => {
    it('parallel persists for the same application all succeed; computed_at values are distinct and "latest" is deterministic and is the last stored', async () => {
      const amounts = [10, 11, 12, 13, 14, 15, 16, 17].map((m) => m * 1_000_000);
      // цаг тогтсон (бүгд ижил `now`) — хамгийн хүнд тохиолдол
      const clock = new FixedClock(new Date('2026-10-29T03:00:00.000Z'));
      const records = await Promise.all(amounts.map((amount) => persist(scoreRequest({ amount }), {}, service(clock))));
      expect(records).toHaveLength(8);
      expect(new Set(records.map((r) => r.computedAt)).size).toBe(8);
      expect(await db.calculation.count({ where: { applicationId: 'app-m8-1' } })).toBe(8);
      expect(await db.outbox.count()).toBe(8);

      const newest = [...records].sort((a, b) => Date.parse(b.computedAt) - Date.parse(a.computedAt))[0]!;
      const reads = await Promise.all([1, 2, 3, 4, 5].map(() => service().latest(officer, 'app-m8-1')));
      for (const r of reads) expect(r.id).toBe(newest.id);
      expect(newest.computedAt).toBe(new Date(Date.parse('2026-10-29T03:00:00.000Z') + 7).toISOString());
    });

    it('mixed persist / select / stale for one application stay consistent (no lost or double-applied state)', async () => {
      await persist();
      await Promise.all([
        persist(scoreRequest({ amount: 12_000_000 })),
        service().select(officer, 'app-m8-1', { method: 'C_COMBINED' }).catch((e: unknown) => e),
        service().markStale(officer, 'app-m8-1', { reason: 'Нөхцөл өөрчлөгдсөн' }),
        persist(scoreRequest({ amount: 13_000_000 })),
      ]);
      const latest = await service().latest(officer, 'app-m8-1');
      expect(CalculationRecord.safeParse(latest).success).toBe(true);
      const rows = await db.calculation.findMany({ where: { applicationId: 'app-m8-1' }, orderBy: { computedAt: 'asc' } });
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(new Set(rows.map((r) => r.computedAt.getTime())).size).toBe(rows.length);
      expect(latest.id).toBe(rows[rows.length - 1]!.id);
    });
  });
});
