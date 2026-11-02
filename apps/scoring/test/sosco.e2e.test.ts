// Модуль 8 · /api/sosco — ЖИНХЭНЭ scoring AppModule + main.ts-тэй ижил configureBsaApp + supertest, gateway-ийн X-* толгойгоор.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { DEFAULT_SOSCO_CURVES, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_WEIGHTS, soscoScore } from '@los/calc';
import { DomainEvent, SettingsChanged, SoscoModelView, SoscoScoreResponse, SoscoSummary } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { ACTORS, bootApp, EMPTY_SOSCO_INPUT, FULL_SOSCO_INPUT, ORG, OTHER_ORG, resetM8Tables, restoreSeed } from '../src/modules/underwriting/testing/m8';
import { stableComponents } from '../src/modules/sosco/sosco.service';

const CYRILLIC = /[Ѐ-ӿ]/;
const scoreBody = (over: Record<string, unknown> = {}) => ({ applicationId: 'app-s-1', customerId: 'cust-s-1', input: FULL_SOSCO_INPUT, ...over });
const WEIGHTS = { fico: 0.2, dti: 0.2, reliability: 0.2, suspicious: 0.1, history: 0.2, ltv: 0.1 };
const THRESHOLDS = { A: 850, B: 750, C: 650, D: 550, E: 0 };
const modelBody = (over: Record<string, unknown> = {}) => ({ weights: WEIGHTS, gradeThresholds: THRESHOLDS, ...over });

describe.skipIf(!process.env.TEST_DATABASE_URL)('/api/sosco on the real scoring AppModule', () => {
  let app: INestApplication;
  let db: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, db } = await bootApp());
  });
  afterAll(async () => {
    await restoreSeed(db);
    await app.close();
  });
  beforeEach(async () => {
    await resetM8Tables(db);
  });

  const score = (actor: keyof typeof ACTORS = 'officer', b: Record<string, unknown> = scoreBody()) => http().post('/api/sosco/score').set(ACTORS[actor]).send(b);
  const latest = (actor: keyof typeof ACTORS = 'officer', q = 'applicationId=app-s-1&customerId=cust-s-1') => http().get(`/api/sosco/results/latest?${q}`).set(ACTORS[actor]);
  const saveModel = (actor: keyof typeof ACTORS = 'admin', b: Record<string, unknown> = modelBody()) => http().put('/api/sosco/models').set(ACTORS[actor]).send(b);

  describe('authentication and authorization', () => {
    it('401 UNAUTHENTICATED on every endpoint without an identity', async () => {
      const calls = [
        http().post('/api/sosco/score').send(scoreBody()),
        http().get('/api/sosco/results/latest?applicationId=a&customerId=c'),
        http().get('/api/sosco/models'),
        http().get('/api/sosco/models/active'),
        http().put('/api/sosco/models').send(modelBody()),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
        expect(typeof res.body.correlationId).toBe('string');
      }
    });

    it('matrix: score needs application:write (OFFICER only); reads need application:read (everyone); model save needs settings:manage (ADMIN only)', async () => {
      expect((await score('officer')).status).toBe(200);
      for (const actor of ['manager', 'approver', 'admin'] as const) {
        const res = await score(actor);
        expect([res.status, res.body.code], `score ${actor}`).toEqual([403, 'FORBIDDEN']);
      }
      for (const actor of ['officer', 'manager', 'approver', 'admin'] as const) {
        expect((await latest(actor)).status, `latest ${actor}`).toBe(200);
        expect((await http().get('/api/sosco/models').set(ACTORS[actor])).status, `models ${actor}`).toBe(200);
        expect((await http().get('/api/sosco/models/active').set(ACTORS[actor])).status, `active ${actor}`).toBe(200);
      }
      for (const actor of ['officer', 'manager', 'approver'] as const) {
        const res = await saveModel(actor);
        expect([res.status, res.body.code], `save ${actor}`).toEqual([403, 'FORBIDDEN']);
      }
      expect(await db.soscoModel.count()).toBe(1); // зөвхөн анхдагч (DEMO) загвар
      expect((await saveModel('admin')).status).toBe(200);
      expect(await db.soscoModel.count()).toBe(2);
      expect(await db.soscoResult.count()).toBe(1); // татгалзсан score нэмэгдээгүй
    });
  });

  describe('validation', () => {
    it.each([
      ['score: wrong type', () => score('officer', scoreBody({ input: { ...FULL_SOSCO_INPUT, ficoScore: 'zxq-secret' } }))],
      ['score: missing input field', () => score('officer', scoreBody({ input: { ficoScore: 700 } }))],
      ['score: empty customer', () => score('officer', scoreBody({ customerId: '' }))],
      ['latest: missing query', () => latest('officer', 'applicationId=app-s-1')],
      ['latest: empty query', () => latest('officer', 'applicationId=&customerId=')],
      ['models: not an object', () => saveModel('admin', 'zxq-secret' as never)],
      ['models: missing weights', () => saveModel('admin', { gradeThresholds: THRESHOLDS })],
      ['models: weight out of range', () => saveModel('admin', modelBody({ weights: { ...WEIGHTS, fico: 'zxq-secret' } }))],
    ])('%s → 400 VALIDATION_FAILED without echoing values', async (_name, send) => {
      const res = await send();
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(CYRILLIC) });
      expect(JSON.stringify(res.body)).not.toContain('zxq-secret');
    });

    it('domain-invalid models → 422 INVALID_SOSCO_MODEL (Mongolian message, paths only); nothing changes and no event is emitted', async () => {
      await http().get('/api/sosco/models/active').set(ACTORS.admin); // DEMO v1
      const bad = [
        modelBody({ weights: { ...WEIGHTS, fico: 0.1 } }),
        modelBody({ gradeThresholds: { A: 700, B: 700, C: 600, D: 500, E: 0 } }),
        modelBody({ curves: { ...DEFAULT_SOSCO_CURVES, dti: { bestPercent: 80, worstPercent: 20 } } }),
      ];
      for (const b of bad) {
        const res = await saveModel('admin', b);
        expect([res.status, res.body.code]).toEqual([422, 'INVALID_SOSCO_MODEL']);
        expect(res.body.message).toMatch(CYRILLIC);
        expect(res.body.details[0]).toHaveProperty('path');
      }
      expect(await db.soscoModel.count()).toBe(1);
      expect(await db.outbox.count()).toBe(0);
    });
  });

  describe('score and latest', () => {
    it('SCORED: 200 SoscoScoreResponse equal to @los/calc with the DEMO model, stored, and readable via GET latest as a SoscoSummary', async () => {
      const want = soscoScore(FULL_SOSCO_INPUT, DEFAULT_SOSCO_WEIGHTS, DEFAULT_SOSCO_GRADE_THRESHOLDS, DEFAULT_SOSCO_CURVES, 1);
      const res = await score();
      expect(res.status).toBe(200);
      expect(SoscoScoreResponse.safeParse(res.body).success, JSON.stringify(SoscoScoreResponse.safeParse(res.body))).toBe(true);
      expect(res.body).toMatchObject({ status: 'SCORED', score: want.score, grade: want.grade, coverage: want.coverage, modelVersion: 1 });
      expect(res.body.components).toEqual(stableComponents(want.components));
      expect(res.body.resultId).toEqual(expect.any(String));

      const read = await latest();
      expect(read.status).toBe(200);
      expect(SoscoSummary.safeParse(read.body).success, JSON.stringify(SoscoSummary.safeParse(read.body))).toBe(true);
      expect(read.body).toMatchObject({ resultId: res.body.resultId, customerId: 'cust-s-1', status: 'SCORED', score: want.score, grade: want.grade, modelVersion: 1, computedAt: res.body.computedAt });
    });

    it('persist=false: 200 without a stored result; INSUFFICIENT_DATA: 200, score null, NOT stored → GET latest 404 NOT_FOUND', async () => {
      const dry = await score('officer', scoreBody({ persist: false }));
      expect(dry.body).toMatchObject({ status: 'SCORED', resultId: null });
      const none = await score('officer', scoreBody({ input: EMPTY_SOSCO_INPUT }));
      expect(none.status).toBe(200);
      expect(none.body).toMatchObject({ status: 'INSUFFICIENT_DATA', score: null, grade: null, resultId: null });
      expect(SoscoScoreResponse.safeParse(none.body).success).toBe(true);
      expect(await db.soscoResult.count()).toBe(0);
      const missing = await latest();
      expect([missing.status, missing.body.code]).toEqual([404, 'NOT_FOUND']);
      expect(missing.body.message).toMatch(CYRILLIC);
    });

    it('GET latest returns the newest score for (application, customer); organisations are isolated', async () => {
      await score('officer', scoreBody({ input: { ...FULL_SOSCO_INPUT, ficoScore: 400 } }));
      await new Promise((r) => setTimeout(r, 5));
      const newest = await score();
      expect((await latest()).body.resultId).toBe(newest.body.resultId);
      expect((await latest('officer', 'applicationId=app-s-1&customerId=cust-other')).status).toBe(404);
      expect((await latest('otherOrgOfficer')).status).toBe(404);
    });
  });

  describe('models', () => {
    it('GET models/active creates the DEMO v1 on first use; GET models lists versions newest first', async () => {
      const active = await http().get('/api/sosco/models/active').set(ACTORS.approver);
      expect(active.status).toBe(200);
      expect(SoscoModelView.safeParse(active.body).success).toBe(true);
      expect(active.body).toMatchObject({ version: 1, isActive: true, weights: DEFAULT_SOSCO_WEIGHTS, gradeThresholds: DEFAULT_SOSCO_GRADE_THRESHOLDS, curves: DEFAULT_SOSCO_CURVES });
      const same = await http().get('/api/sosco/models/active').set(ACTORS.approver);
      expect(same.body.id).toBe(active.body.id);
      expect((await http().get('/api/sosco/models').set(ACTORS.approver)).body).toHaveLength(1);
    });

    it('PUT models: 200 new version+1 (active), previous deactivated, SettingsChanged outbox; the next score uses the new model', async () => {
      const first = await score();
      expect(first.body.modelVersion).toBe(1);
      const saved = await saveModel('admin', modelBody());
      expect(saved.status).toBe(200);
      expect(SoscoModelView.safeParse(saved.body).success).toBe(true);
      expect(saved.body).toMatchObject({ version: 2, isActive: true, weights: WEIGHTS, gradeThresholds: THRESHOLDS, curves: DEFAULT_SOSCO_CURVES, createdBy: ACTORS.admin['x-user-id'] });

      const list = await http().get('/api/sosco/models').set(ACTORS.officer);
      expect(list.body.map((m: { version: number; isActive: boolean }) => [m.version, m.isActive])).toEqual([[2, true], [1, false]]);

      const events = await db.outbox.findMany({ where: { type: 'SettingsChanged' } });
      expect(events).toHaveLength(1);
      expect(SettingsChanged.parse(DomainEvent.parse(events[0]!.payload))).toMatchObject({ key: 'sosco.model', productId: null, orgId: ORG, actorId: ACTORS.admin['x-user-id'] });

      const second = await score();
      expect(second.body.modelVersion).toBe(2);
      expect(second.body.modelId).toBe(saved.body.id);
      expect((await latest()).body.modelVersion).toBe(2);
    });

    it('omitted curves carry over the active model\'s curves; explicit curves replace them', async () => {
      const curves = { ...DEFAULT_SOSCO_CURVES, minCoverage: 0.7 };
      expect((await saveModel('admin', modelBody({ curves }))).body.curves).toEqual(curves);
      expect((await saveModel('admin', modelBody())).body).toMatchObject({ version: 2, curves });
    });

    it('models are per organisation: another organisation\'s admin neither sees nor changes this organisation\'s model', async () => {
      await http().get('/api/sosco/models/active').set(ACTORS.admin);
      const theirs = await saveModel('otherOrgAdmin');
      expect(theirs.status).toBe(200);
      expect(theirs.body.version).toBe(1); // тэдний эхний загвар
      expect((await db.soscoModel.findMany({ where: { orgId: ORG } })).map((m) => [m.version, m.isActive])).toEqual([[1, true]]);
      expect((await db.soscoModel.findMany({ where: { orgId: OTHER_ORG } })).map((m) => [m.version, m.isActive])).toEqual([[1, true]]);
      expect((await http().get('/api/sosco/models').set(ACTORS.otherOrgAdmin)).body).toHaveLength(1);
    });

    it('concurrent first use over HTTP creates exactly one model', async () => {
      const res = await Promise.all(Array.from({ length: 6 }, () => http().get('/api/sosco/models/active').set(ACTORS.officer)));
      expect(new Set(res.map((r) => r.body.id)).size).toBe(1);
      expect(await db.soscoModel.count()).toBe(1);
    });
  });
});
