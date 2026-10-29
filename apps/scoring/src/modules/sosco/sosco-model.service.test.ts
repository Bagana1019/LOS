// SoscoModelService — жинхэнэ PostgreSQL. Docs/05 §3: хувилбартай загвар, нэг идэвхтэй/байгууллага, SettingsChanged outbox.
import { DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS } from '@los/calc';
import { DomainEvent, SaveSoscoModelRequest, SettingsChanged, SoscoModelView, type SoscoCurves } from '@los/contracts';
import { FixedClock, SystemClock } from '@los/nest-common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { ctxOf, failOutboxInserts, ORG, OTHER_ORG, outboxEvents, resetM8Tables, restoreSeed } from '../underwriting/testing/m8';
import { assertValidModel, SoscoModelService } from './sosco-model.service';

const admin = ctxOf('admin');
const WEIGHTS = { fico: 0.2, dti: 0.2, reliability: 0.2, suspicious: 0.1, history: 0.2, ltv: 0.1 };
const THRESHOLDS = { A: 850, B: 750, C: 650, D: 550, E: 0 };
const save = (over: Partial<SaveSoscoModelRequest> = {}) => ({ weights: WEIGHTS, gradeThresholds: THRESHOLDS, ...over });

describe('assertValidModel (pure)', () => {
  const ok = { weights: DEFAULT_SOSCO_WEIGHTS, gradeThresholds: DEFAULT_SOSCO_GRADE_THRESHOLDS, curves: DEFAULT_SOSCO_CURVES };
  it('accepts the DEMO defaults', () => {
    expect(() => assertValidModel(ok)).not.toThrow();
  });
  it('turns @los/calc RangeError into 422 INVALID_SOSCO_MODEL with a Mongolian message and a technical reason', () => {
    const bad = { ...ok, curves: { ...DEFAULT_SOSCO_CURVES, history: { overdueMonthsWorst: 0, activeLoanPenalty: 0.05 } } };
    expect(() => assertValidModel(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_SOSCO_MODEL', status: 422, message: expect.stringMatching(/Sosco загвар буруу/) }));
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('SoscoModelService (PostgreSQL)', () => {
  const db = new PrismaService();
  const service = () => new SoscoModelService(db, new SystemClock());

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

  describe('ensureActiveModel', () => {
    it('creates DEMO v1 from the @los/calc defaults when the organisation has no active model; later calls return the same row', async () => {
      const model = await service().ensureActiveModel(ORG);
      expect(model).toMatchObject({ orgId: ORG, version: 1, isActive: true, weightsJson: DEFAULT_SOSCO_WEIGHTS, gradeThresholdsJson: DEFAULT_SOSCO_GRADE_THRESHOLDS, paramsJson: DEFAULT_SOSCO_CURVES });
      expect((await service().ensureActiveModel(ORG)).id).toBe(model.id);
      expect(await db.soscoModel.count()).toBe(1);
      expect(await db.outbox.count()).toBe(0); // анхдагч загвар settings event гаргахгүй
    });

    it('returns the existing active model untouched (does not recreate the seed)', async () => {
      const seeded = await db.soscoModel.create({ data: { orgId: ORG, version: 3, weightsJson: WEIGHTS, gradeThresholdsJson: THRESHOLDS, isActive: true } });
      expect((await service().ensureActiveModel(ORG)).id).toBe(seeded.id);
      expect(await db.soscoModel.count()).toBe(1);
    });

    it('race: parallel first use creates exactly ONE model and everyone gets it', async () => {
      const rows = await Promise.all(Array.from({ length: 12 }, () => service().ensureActiveModel(ORG)));
      expect(new Set(rows.map((r) => r.id)).size).toBe(1);
      expect(await db.soscoModel.count({ where: { orgId: ORG } })).toBe(1);
      expect(await db.soscoModel.count({ where: { orgId: ORG, isActive: true } })).toBe(1);
    });

    it('an organisation whose models are all inactive gets a new active version after the highest; other organisations are independent', async () => {
      await db.soscoModel.create({ data: { orgId: ORG, version: 4, weightsJson: WEIGHTS, gradeThresholdsJson: THRESHOLDS, isActive: false } });
      expect(await service().ensureActiveModel(ORG)).toMatchObject({ version: 5, isActive: true });
      expect(await service().ensureActiveModel(OTHER_ORG)).toMatchObject({ version: 1, isActive: true, orgId: OTHER_ORG });
    });
  });

  describe('getActive / list', () => {
    it('views satisfy SoscoModelView; a legacy row without params_json falls back to the DEMO curves', async () => {
      await db.soscoModel.create({ data: { orgId: ORG, version: 1, weightsJson: DEFAULT_SOSCO_WEIGHTS, gradeThresholdsJson: DEFAULT_SOSCO_GRADE_THRESHOLDS, isActive: true } }); // Модуль 0-ийн хэлбэр
      const active = await service().getActive(admin);
      expect(SoscoModelView.safeParse(active).success).toBe(true);
      expect(active).toMatchObject({ version: 1, isActive: true, weights: DEFAULT_SOSCO_WEIGHTS, curves: DEFAULT_SOSCO_CURVES });
    });

    it('list is newest-first, scoped to the organisation, and creates nothing', async () => {
      expect(await service().list(admin)).toEqual([]);
      await service().save(admin, save());
      await service().save(admin, save({ weights: { ...WEIGHTS, fico: 0.3, ltv: 0 } }));
      await service().ensureActiveModel(OTHER_ORG);
      const views = await service().list(admin);
      expect(views.map((v) => [v.version, v.isActive])).toEqual([[2, true], [1, false]]);
      for (const v of views) expect(SoscoModelView.safeParse(v).success).toBe(true);
    });
  });

  describe('save', () => {
    it('creates version+1, deactivates the previous (kept for history), activates the new one; createdBy is the admin', async () => {
      const v1 = await service().ensureActiveModel(ORG);
      const saved = await service().save(admin, save());
      expect(SoscoModelView.safeParse(saved).success).toBe(true);
      expect(saved).toMatchObject({ version: 2, isActive: true, weights: WEIGHTS, gradeThresholds: THRESHOLDS, curves: DEFAULT_SOSCO_CURVES, createdBy: admin.userId });
      const rows = await db.soscoModel.findMany({ where: { orgId: ORG }, orderBy: { version: 'asc' } });
      expect(rows.map((r) => [r.version, r.isActive])).toEqual([[1, false], [2, true]]);
      expect(rows[0]!.id).toBe(v1.id);
      expect(rows[1]).toMatchObject({ paramsJson: DEFAULT_SOSCO_CURVES, updatedBy: admin.userId });
    });

    it('the first save for an organisation without any model becomes v1', async () => {
      expect(await service().save(admin, save())).toMatchObject({ version: 1, isActive: true });
    });

    it('explicit curves are stored; omitted curves carry over the ACTIVE model curves (editing weights does not reset them)', async () => {
      const curves: SoscoCurves = { ...DEFAULT_SOSCO_CURVES, fico: { min: 350, max: 800 }, minCoverage: 0.6 };
      expect((await service().save(admin, save({ curves }))).curves).toEqual(curves);
      const carried = await service().save(admin, save({ weights: { ...WEIGHTS, fico: 0.3, ltv: 0 } }));
      expect(carried).toMatchObject({ version: 2, curves });
    });

    it('emits SettingsChanged { key: "sosco.model", productId: null } in the same commit (CLAUDE.md §3.2.8)', async () => {
      await service().save(ctxOf('admin', 'corr-model'), save());
      const rows = await db.outbox.findMany();
      expect(rows).toHaveLength(1);
      const event = DomainEvent.parse(rows[0]!.payload);
      expect(rows[0]).toMatchObject({ type: 'SettingsChanged', id: event.eventId, publishedAt: null });
      expect(SettingsChanged.parse(event)).toMatchObject({ key: 'sosco.model', productId: null, orgId: ORG, actorId: admin.userId, correlationId: 'corr-model', version: 1 });
    });

    it.each([
      ['weights do not sum to 1', save({ weights: { ...WEIGHTS, fico: 0.1 } })],
      ['thresholds are not strictly decreasing', save({ gradeThresholds: { A: 700, B: 700, C: 600, D: 500, E: 0 } })],
      ['E threshold is not 0', save({ gradeThresholds: { A: 800, B: 700, C: 600, D: 500, E: 10 } })],
      ['a curve is inverted', save({ curves: { ...DEFAULT_SOSCO_CURVES, fico: { min: 850, max: 300 } } })],
    ])('invalid model (%s) → 422 INVALID_SOSCO_MODEL; nothing changes', async (_name, body) => {
      const v1 = await service().ensureActiveModel(ORG);
      await expect(service().save(admin, body)).rejects.toMatchObject({ code: 'INVALID_SOSCO_MODEL', status: 422 });
      expect(await db.soscoModel.count()).toBe(1);
      expect((await db.soscoModel.findUniqueOrThrow({ where: { id: v1.id } })).isActive).toBe(true);
      expect(await db.outbox.count()).toBe(0);
    });

    it('a malformed body (not a SaveSoscoModelRequest) is also INVALID_SOSCO_MODEL when it reaches the service', async () => {
      await expect(service().save(admin, { weights: 'zxq', gradeThresholds: null } as never)).rejects.toMatchObject({ code: 'INVALID_SOSCO_MODEL', status: 422 });
    });

    it('omitted curves with a CORRUPT active model → 422 (revalidated inside the transaction), nothing changes', async () => {
      const v1 = await db.soscoModel.create({ data: { orgId: ORG, version: 1, weightsJson: WEIGHTS, gradeThresholdsJson: THRESHOLDS, isActive: true, paramsJson: { ...DEFAULT_SOSCO_CURVES, history: { overdueMonthsWorst: 0, activeLoanPenalty: 0.05 } } } });
      await expect(service().save(admin, save())).rejects.toMatchObject({ code: 'INVALID_SOSCO_MODEL', status: 422 });
      expect((await db.soscoModel.findUniqueOrThrow({ where: { id: v1.id } })).isActive).toBe(true);
    });

    it('needs an accountable user → 401', async () => {
      await expect(service().save({ ...admin, userId: null }, save())).rejects.toMatchObject({ status: 401 });
      expect(await db.soscoModel.count()).toBe(0);
    });

    it('atomic: an outbox failure rolls back the new version AND the deactivation of the previous one', async () => {
      const v1 = await service().ensureActiveModel(ORG);
      const restore = await failOutboxInserts(db);
      try {
        await expect(service().save(admin, save())).rejects.toThrow();
      } finally {
        await restore();
      }
      expect(await db.soscoModel.count()).toBe(1);
      expect(await db.soscoModel.findFirstOrThrow({ where: { orgId: ORG } })).toMatchObject({ id: v1.id, isActive: true, version: 1 });
      expect(await db.outbox.count()).toBe(0);
    });

    it('concurrent saves: versions are unique and consecutive, exactly one model stays active (the newest), one event per save', async () => {
      await service().ensureActiveModel(ORG);
      const clock = new FixedClock(new Date('2026-10-29T03:00:00.000Z'));
      const racers = Array.from({ length: 6 }, (_, i) => new SoscoModelService(db, clock).save(admin, save({ weights: { ...WEIGHTS, fico: 0.2 + i / 1000, ltv: 0.1 - i / 1000 } })));
      const views = await Promise.all(racers);
      expect(views.map((v) => v.version).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
      const rows = await db.soscoModel.findMany({ where: { orgId: ORG }, orderBy: { version: 'asc' } });
      expect(rows.filter((r) => r.isActive).map((r) => r.version)).toEqual([7]);
      expect((await outboxEvents(db, 'SettingsChanged'))).toHaveLength(6);
    });

    it('is scoped to the organisation: saving for one organisation does not deactivate another', async () => {
      await service().ensureActiveModel(OTHER_ORG);
      await service().save(admin, save());
      expect((await db.soscoModel.findFirstOrThrow({ where: { orgId: OTHER_ORG } })).isActive).toBe(true);
    });
  });
});
