import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { Prisma } from '.prisma/client-origination';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StepKey, type DomainEvent } from '@los/contracts';
import type { EventBus } from '@los/database';
import { getRequestContext } from '@los/nest-common';
import { createTestApp, type TestApp } from '../../test-utils/test-app';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb, ORG, resetDb } from '../../test-utils/factories';
import { PrismaService } from '../../prisma.service';
import { ScoreEventsSubscriber, EVENT_GROUP } from './score-events.subscriber';
import { ScoreModule } from './score.module';
import { buildSnapshot } from './score.rules';
import { SCORING_CLIENT } from './scoring.client';
import { FakeScoringClient } from './testing/fake-scoring.client';
import { calculationRecord } from './testing/scoring-fixtures';

Logger.overrideLogger(false);

const scoringCompleted = (applicationId: string, over: Record<string, unknown> = {}): DomainEvent => ({
  type: 'ScoringCompleted', eventId: randomUUID(), occurredAt: new Date().toISOString(), version: 1, orgId: ORG, actorId: null, correlationId: 'corr-evt',
  applicationId, selectedMethod: 'B_BUSINESS', soscoScore: 650, dtiPercent: 20, ...over,
}) as DomainEvent;

describe('ScoreEventsSubscriber · бүртгэл (unit)', () => {
  function fakeBus() {
    const subscribe = vi.fn<EventBus['subscribe']>().mockResolvedValue(undefined);
    return { bus: { publish: vi.fn(), subscribe, close: vi.fn() } as EventBus, subscribe };
  }
  const db = {} as PrismaService;
  const clock = { now: () => new Date('2026-10-28T02:00:00Z') };

  it("'origination' group-д зөвхөн ScoringCompleted-д бүртгүүлнэ", async () => {
    const { bus, subscribe } = fakeBus();
    await new ScoreEventsSubscriber(bus, db, clock).onApplicationBootstrap();
    expect(EVENT_GROUP).toBe('origination');
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]!.slice(0, 2)).toEqual(['origination', ['ScoringCompleted']]);
  });

  it('bus байхгүй (Redis-гүй) бол чимээгүй алгасна; subscribe унавал bootstrap унана', async () => {
    await expect(new ScoreEventsSubscriber(null, db, clock).onApplicationBootstrap()).resolves.toBeUndefined();
    const { bus, subscribe } = fakeBus();
    subscribe.mockRejectedValue(new Error('NOGROUP'));
    await expect(new ScoreEventsSubscriber(bus, db, clock).onApplicationBootstrap()).rejects.toThrow('NOGROUP');
  });

  it('handler-ийг event-ийн орг/correlationId-тай системийн контекстод ажиллуулна; бусад төрлийн event-д юу ч хийхгүй', async () => {
    const { bus, subscribe } = fakeBus();
    const processed = new Set<string>();
    const tx = { processedEvent: { create: async ({ data }: { data: { eventId: string } }) => { processed.add(data.eventId); } } };
    const fake = { $transaction: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx) } as unknown as PrismaService;
    const sub = new ScoreEventsSubscriber(bus, fake, clock);
    let seen: ReturnType<typeof getRequestContext> = null;
    vi.spyOn(sub, 'handle').mockImplementation(async () => { seen = getRequestContext(); });
    await sub.onApplicationBootstrap();
    await subscribe.mock.calls[0]![2](scoringCompleted('app-1', { orgId: 'org-9', correlationId: 'corr-9' }));
    expect(seen).toMatchObject({ orgId: 'org-9', correlationId: 'corr-9', userId: null });
  });
});

describe.skipIf(!hasTestDb)('ScoreEventsSubscriber · ScoringCompleted тулгалт (DB)', () => {
  let t: TestApp;
  let db: PrismaService;
  const scoring = new FakeScoringClient();
  const baseRequest = {
    applicationId: 'x', amount: 10_000_000, termMonths: 12, interestRate: 24, monthlyPayment: 1, salaryMonthly: 1, businessNcfMonthly: 0, householdExpenseMonthly: 0,
    existingDebtServiceMonthly: 0, collateralValueTotal: 0, collateralRequired: false, policy: { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 },
  };

  beforeAll(async () => {
    t = await createTestApp([ScoreModule], (b) => b.overrideProvider(SCORING_CLIENT).useValue(scoring));
    db = t.prisma;
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => { await resetDb(db); scoring.reset(); });

  async function seed(o: { status?: string; steps?: Record<string, string> | false; method?: string | null; snapshot?: unknown } = {}) {
    const app = await createApplication(db, { status: o.status ?? 'DRAFT', selectedCalcMethod: o.method ?? null, calcSnapshotJson: (o.snapshot ?? undefined) as never });
    if (o.steps !== false) {
      await db.loanApplicationStep.createMany({ data: StepKey.map((stepKey) => ({ orgId: ORG, applicationId: app.id, stepKey, status: (o.steps || {})[stepKey] ?? 'PENDING' })) });
    }
    return app;
  }
  const step = (appId: string) => db.loanApplicationStep.findUnique({ where: { applicationId_stepKey: { applicationId: appId, stepKey: 'score' } } });
  const reload = (appId: string) => db.loanApplication.findUniqueOrThrow({ where: { id: appId } });
  const publish = (e: DomainEvent) => t.bus.publish(e);
  const markers = () => db.processedEvent.count({ where: { consumer: EVENT_GROUP } });

  it('scoring бичсэн ч origination унасан: selected_calc_method + snapshot (reconciled) + алхам COMPLETED болгож засна', async () => {
    const app = await seed();
    await publish(scoringCompleted(app.id, { occurredAt: '2026-10-29T10:00:00.000Z' }));

    const row = await reload(app.id);
    expect(row.selectedCalcMethod).toBe('B_BUSINESS');
    expect(row.calcSnapshotJson).toMatchObject({ calculationId: null, selectedMethod: 'B_BUSINESS', soscoScore: 650, ratio: null, pass: null, reconciled: true, syncedAt: '2026-10-29T10:00:00.000Z' });
    const s = await step(app.id);
    expect(s).toMatchObject({ status: 'COMPLETED', staleReason: null });
    expect(s!.completedAt?.toISOString()).toBe(t.clock.now().toISOString());
    expect(await markers()).toBe(1);
  });

  it('арга солигдсон бол өмнөх snapshot-ийн арга-тусгай дэлгэрэнгүйг хүчингүй болгож, LTV/calculationId-г хадгална', async () => {
    const snapshot = buildSnapshot(calculationRecord({ ...baseRequest, applicationId: 'app' }, { id: 'calc-7', selectedMethod: 'A_SALARY', ltv: 0.4 }), { score: 700, grade: 'B' });
    const app = await seed({ method: 'A_SALARY', snapshot, steps: { score: 'COMPLETED' } });
    await publish(scoringCompleted(app.id, { selectedMethod: 'C_COMBINED', soscoScore: 710 }));
    const row = await reload(app.id);
    expect(row.selectedCalcMethod).toBe('C_COMBINED');
    expect(row.calcSnapshotJson).toMatchObject({ calculationId: 'calc-7', selectedMethod: 'C_COMBINED', ratio: null, limit: null, pass: null, eligible: null, ltv: 0.4, soscoScore: 710, soscoGrade: null, reconciled: true });
  });

  it('арга ижил, алхам аль хэдийн COMPLETED бол юу ч өөрчлөхгүй', async () => {
    const snapshot = buildSnapshot(calculationRecord({ ...baseRequest, applicationId: 'app' }, { selectedMethod: 'B_BUSINESS' }), null);
    const app = await seed({ method: 'B_BUSINESS', snapshot, steps: { score: 'COMPLETED' } });
    const before = { app: await reload(app.id), step: await step(app.id) };
    await publish(scoringCompleted(app.id));
    expect(await reload(app.id)).toEqual(before.app);
    expect(await step(app.id)).toEqual(before.step);
    expect(await markers()).toBe(1);
  });

  it('IDEMPOTENT: ижил event (ижил eventId) хоёр хүргэгдвэл нэг л удаа боловсруулагдана', async () => {
    const app = await seed();
    const e = scoringCompleted(app.id);
    await publish(e);
    // эхний боловсруулалтын үр дүнг гараар буцаагаад ижил event-ийг дахин хүргэнэ — дахин хэрэглэгдэх ёсгүй
    await db.loanApplication.update({ where: { id: app.id }, data: { selectedCalcMethod: null, calcSnapshotJson: Prisma.DbNull } });
    await db.loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: app.id, stepKey: 'score' } }, data: { status: 'PENDING', completedAt: null } });
    await publish(e);
    expect((await reload(app.id)).selectedCalcMethod).toBeNull();
    expect((await step(app.id))!.status).toBe('PENDING');
    expect(await markers()).toBe(1);
    // харин ШИНЭ eventId-тай event дахин хэрэглэгдэнэ
    await publish(scoringCompleted(app.id));
    expect((await reload(app.id)).selectedCalcMethod).toBe('B_BUSINESS');
    expect(await markers()).toBe(2);
  });

  it('олдохгүй хүсэлт → чимээгүй алгасана (алдаагүй, мөр үүсгэхгүй), давхар хүргэлтээс хамгаалагдсан хэвээр', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const e = scoringCompleted('00000000-0000-4000-8000-00000000dead');
    await expect(publish(e)).resolves.toBeUndefined();
    await expect(publish(e)).resolves.toBeUndefined();
    expect(await db.loanApplication.count()).toBe(0);
    expect(await db.loanApplicationStep.count()).toBe(0);
    expect(await markers()).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('unknown application');
    warn.mockRestore();
  });

  it('өөр байгууллагын хүсэлтэд хамаарах event-ийг үл тооно', async () => {
    const app = await seed();
    await publish(scoringCompleted(app.id, { orgId: 'other-org' }));
    expect((await reload(app.id)).selectedCalcMethod).toBeNull();
    expect((await step(app.id))!.status).toBe('PENDING');
  });

  it('мэдэгдэхгүй аргын нэр → үл тооно', async () => {
    const app = await seed();
    await publish(scoringCompleted(app.id, { selectedMethod: 'Z_UNKNOWN' }));
    expect((await reload(app.id)).selectedCalcMethod).toBeNull();
  });

  it.each(['SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'ACTIVE'])('%s хүсэлтийн сонголтыг хоцорсон event-ээр өөрчлөхгүй', async (status) => {
    const app = await seed({ status, method: 'A_SALARY' });
    await publish(scoringCompleted(app.id));
    expect((await reload(app.id)).selectedCalcMethod).toBe('A_SALARY');
    expect((await step(app.id))!.status).toBe('PENDING');
  });

  it('RETURNED хүсэлтийг засна', async () => {
    const app = await seed({ status: 'RETURNED' });
    await publish(scoringCompleted(app.id));
    expect((await reload(app.id)).selectedCalcMethod).toBe('B_BUSINESS');
  });

  it('хэрэглэгдсэн төлвөөс хуучин event (syncedAt-аас өмнөх) шинэ төлвийг дарахгүй', async () => {
    const snapshot = { ...buildSnapshot(calculationRecord({ ...baseRequest, applicationId: 'app' }, { selectedMethod: 'A_SALARY', computedAt: '2026-10-29T10:00:00.000Z' }), null), syncedAt: '2026-10-29T10:30:00.000Z' };
    const app = await seed({ method: 'A_SALARY', snapshot, steps: { score: 'COMPLETED' } });
    await publish(scoringCompleted(app.id, { selectedMethod: 'B_BUSINESS', occurredAt: '2026-10-29T10:10:00.000Z' }));
    expect((await reload(app.id)).selectedCalcMethod).toBe('A_SALARY');
    await publish(scoringCompleted(app.id, { selectedMethod: 'B_BUSINESS', occurredAt: '2026-10-29T10:40:00.000Z' }));
    expect((await reload(app.id)).selectedCalcMethod).toBe('B_BUSINESS');
  });

  it('алхам STALE: хуучруулсны ДАРАА гарсан event COMPLETED болгоно (origination унасан тохиолдол); ӨМНӨ гарсан нь STALE хэвээр', async () => {
    const older = await seed({ steps: { score: 'STALE' } });
    await db.loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: older.id, stepKey: 'score' } }, data: { staleReason: 'LOAN_TERMS_CHANGED' } });
    await publish(scoringCompleted(older.id, { occurredAt: new Date(Date.now() - 3_600_000).toISOString() }));
    expect(await step(older.id)).toMatchObject({ status: 'STALE', staleReason: 'LOAN_TERMS_CHANGED' });

    const newer = await seed({ steps: { score: 'STALE' } });
    await db.loanApplicationStep.update({ where: { applicationId_stepKey: { applicationId: newer.id, stepKey: 'score' } }, data: { staleReason: 'LOAN_TERMS_CHANGED' } });
    await publish(scoringCompleted(newer.id, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }));
    expect(await step(newer.id)).toMatchObject({ status: 'COMPLETED', staleReason: null });
  });

  it('LOCKED алхамд хүрэхгүй; алхамын мөр байхгүй бол үүсгэнэ', async () => {
    const locked = await seed({ steps: { score: 'LOCKED' } });
    await publish(scoringCompleted(locked.id));
    expect(await step(locked.id)).toMatchObject({ status: 'LOCKED', completedAt: null });
    expect((await reload(locked.id)).selectedCalcMethod).toBe('B_BUSINESS');

    const none = await seed({ steps: false });
    await publish(scoringCompleted(none.id));
    expect(await step(none.id)).toMatchObject({ status: 'COMPLETED' });
  });

  it('origination-ийн өөрийн calculate-ийн дараа ирсэн ScoringCompleted нь юу ч өөрчлөхгүй (давхар бичилтгүй)', async () => {
    // фасадаар тооцоолсны дараа scoring-ийн event ирнэ — нэг ижил арга, алхам COMPLETED
    const app = await seed();
    const customer = await createCustomer(db);
    await createBorrower(db, app.id, customer.id, 'PRIMARY');
    await db.incomeSummary.create({ data: { orgId: ORG, applicationId: app.id, customerId: customer.id, avgSalaryMonthly: 3_000_000, businessNcfMonthly: 0, householdExpenseMonthly: 0 } });
    const res = await request(t.app.getHttpServer()).post(`/api/applications/${app.id}/score/calculate`).set(actors.officer()).send({});
    expect(res.status).toBe(200);
    const before = await reload(app.id);
    await publish(scoringCompleted(app.id, { selectedMethod: 'A_SALARY', occurredAt: new Date().toISOString(), soscoScore: 720 }));
    const after = await reload(app.id);
    expect(after.selectedCalcMethod).toBe('A_SALARY');
    expect(after.calcSnapshotJson).toEqual(before.calcSnapshotJson); // reconcile хийгдээгүй (арга ижил)
    expect((await step(app.id))!.status).toBe('COMPLETED');
  });
});
