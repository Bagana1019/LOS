// Модуль 8 · /api/underwrite — ЖИНХЭНЭ scoring AppModule + main.ts-тэй ижил configureBsaApp (global BsaExceptionFilter) + supertest, gateway-ийн X-* толгойгоор.
// Controller-ийн `@UseFilters(AllExceptionsFilter)` нь BSA-ийн global filter-ээс түрүүлж, foundation хэлбэр ба домэйн кодыг (CALCULATION_STALE …) хадгалахыг шалгана.
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { underwrite } from '@los/calc';
import { CalculationRecord, DomainEvent, ScoringCompleted } from '@los/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma.service';
import { ACTORS, bootApp, businessRequest, noIncomeRequest, ORG, outboxEvents, resetM8Tables, restoreSeed, scoreRequest } from '../src/modules/underwriting/testing/m8';

const CUSTOMER = 'cust-e2e-1';
const body = (over: Record<string, unknown> = {}) => ({ request: scoreRequest(), customerId: CUSTOMER, ...over });
const CYRILLIC = /[Ѐ-ӿ]/;

describe.skipIf(!process.env.TEST_DATABASE_URL)('POST/GET/PUT /api/underwrite on the real scoring AppModule', () => {
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

  const persist = (actor: keyof typeof ACTORS = 'officer', b = body()) => http().post('/api/underwrite').set(ACTORS[actor]).send(b);
  const latest = (actor: keyof typeof ACTORS = 'officer', applicationId = 'app-m8-1') => http().get(`/api/underwrite/applications/${applicationId}/latest`).set(ACTORS[actor]);

  describe('authentication and authorization', () => {
    it('401 UNAUTHENTICATED (foundation error shape with correlationId) on every endpoint without an identity', async () => {
      const calls = [
        http().post('/api/underwrite/preview').send(scoreRequest()),
        http().post('/api/underwrite').send(body()),
        http().get('/api/underwrite/applications/app-m8-1/latest'),
        http().put('/api/underwrite/applications/app-m8-1/selection').send({ method: 'A_SALARY' }),
        http().post('/api/underwrite/applications/app-m8-1/stale').send({ reason: 'x' }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED', message: expect.stringMatching(CYRILLIC) });
        expect(typeof res.body.correlationId).toBe('string');
      }
    });

    it('a request without the organisation header is rejected (MISSING_ORG)', async () => {
      const res = await http().get('/api/underwrite/applications/app-m8-1/latest').set({ 'x-user-id': 'u-1', 'x-roles': 'OFFICER' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MISSING_ORG');
    });

    it('matrix: OFFICER writes; APPROVER, BRANCH_MANAGER and ADMIN read but cannot write (403 FORBIDDEN); nothing is stored by a rejected write', async () => {
      const seeded = await persist('officer');
      expect(seeded.status).toBe(201);
      const readers = ['officer', 'manager', 'approver', 'admin'] as const;
      const nonWriters = ['manager', 'approver', 'admin'] as const;
      for (const actor of readers) {
        expect((await http().post('/api/underwrite/preview').set(ACTORS[actor]).send(scoreRequest())).status, `preview ${actor}`).toBe(200);
        expect((await latest(actor)).status, `latest ${actor}`).toBe(200);
      }
      for (const actor of nonWriters) {
        const writes = [
          persist(actor),
          http().put('/api/underwrite/applications/app-m8-1/selection').set(ACTORS[actor]).send({ method: 'C_COMBINED' }),
          http().post('/api/underwrite/applications/app-m8-1/stale').set(ACTORS[actor]).send({ reason: 'x' }),
        ];
        for (const res of await Promise.all(writes)) {
          expect(res.status, actor).toBe(403);
          expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(CYRILLIC) });
        }
      }
      expect(await db.calculation.count()).toBe(1);
      expect((await latest()).body).toMatchObject({ isStale: false, selectedMethod: 'A_SALARY', selection: 'AUTO' });
      expect(await db.outbox.count()).toBe(1);
    });
  });

  describe('validation (400 VALIDATION_FAILED, values never echoed)', () => {
    it.each([
      ['persist: wrong type', () => persist('officer', body({ request: { ...scoreRequest(), amount: 'zxq-secret' } }))],
      ['persist: missing customerId', () => persist('officer', { request: scoreRequest() } as never)],
      ['persist: unknown method', () => persist('officer', body({ selectedMethod: 'zxq-secret' }))],
      ['persist: policy out of range', () => persist('officer', body({ request: { ...scoreRequest(), policy: { ...scoreRequest().policy, maxDti: 7 } } }))],
      ['preview: negative term', () => http().post('/api/underwrite/preview').set(ACTORS.officer).send({ ...scoreRequest(), termMonths: -1, applicationId: 'zxq-secret' })],
      ['selection: unknown method', () => http().put('/api/underwrite/applications/app-m8-1/selection').set(ACTORS.officer).send({ method: 'zxq-secret' })],
      ['stale: empty reason', () => http().post('/api/underwrite/applications/app-m8-1/stale').set(ACTORS.officer).send({ reason: '   ' })],
      ['latest: over-long application id', () => latest('officer', 'a'.repeat(129))],
    ])('%s', async (_name, send) => {
      const res = await send();
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringMatching(CYRILLIC) });
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('zxq-secret');
      expect(typeof res.body.correlationId).toBe('string');
    });

    it('validation runs after authorization and writes nothing', async () => {
      expect((await persist('approver', { bad: true } as never)).status).toBe(403);
      expect((await persist('officer', { bad: true } as never)).status).toBe(400);
      expect(await db.calculation.count()).toBe(0);
    });
  });

  describe('preview', () => {
    it('returns UnderwriteResult for the policy in the request, with HTTP 200; stores nothing and emits nothing', async () => {
      const res = await http().post('/api/underwrite/preview').set(ACTORS.officer).send(scoreRequest());
      expect(res.status).toBe(200);
      expect(res.body).toEqual(underwrite(scoreRequest()));
      expect(res.body.methods.map((m: { method: string }) => m.method)).toEqual(['A_SALARY', 'B_BUSINESS', 'C_COMBINED']);
      expect(await db.calculation.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
    });

    it('collateralRequired may be omitted (defaults to true); BR limits are taken from the request policy', async () => {
      const { collateralRequired: _omit, ...without } = scoreRequest({ collateralValueTotal: 0 });
      const strict = await http().post('/api/underwrite/preview').set(ACTORS.officer).send(without);
      expect(strict.body.collateral).toMatchObject({ required: true, pass: false });
      const loose = await http().post('/api/underwrite/preview').set(ACTORS.officer).send({ ...without, collateralRequired: false });
      expect(loose.body.collateral).toMatchObject({ required: false, pass: true });
      const tight = await http().post('/api/underwrite/preview').set(ACTORS.officer).send({ ...scoreRequest(), policy: { ...scoreRequest().policy, maxDti: 0.3 } });
      expect(tight.body.methods[0]).toMatchObject({ limit: 0.3, pass: false });
    });
  });

  describe('persist → latest', () => {
    it('201 with a CalculationRecord that round-trips through GET latest and satisfies the contract schema', async () => {
      const created = await persist();
      expect(created.status).toBe(201);
      expect(CalculationRecord.safeParse(created.body).success, JSON.stringify(CalculationRecord.safeParse(created.body))).toBe(true);
      expect(created.body).toMatchObject({ applicationId: 'app-m8-1', customerId: CUSTOMER, selectedMethod: 'A_SALARY', selection: 'AUTO', selectedBy: null, isStale: false });
      expect(created.body.result).toEqual(underwrite(scoreRequest()));
      const read = await latest();
      expect(read.status).toBe(200);
      expect(read.body).toEqual(created.body);
    });

    it('the correlation id travels to the response header, the error body and the event', async () => {
      const res = await http().post('/api/underwrite').set({ ...ACTORS.officer, 'x-correlation-id': 'corr-e2e-uw' }).send(body());
      expect(res.headers['x-correlation-id']).toBe('corr-e2e-uw');
      const err = await http().get('/api/underwrite/applications/none/latest').set({ ...ACTORS.officer, 'x-correlation-id': 'corr-e2e-404' });
      expect(err.body).toMatchObject({ code: 'CALCULATION_NOT_FOUND', correlationId: 'corr-e2e-404' });
      expect((await outboxEvents(db, 'ScoringCompleted'))[0]).toMatchObject({ correlationId: 'corr-e2e-uw' });
    });

    it('AUTO follows BR-4 (B for business income); MANUAL keeps the officer, reason (trimmed) and the auto suggestion', async () => {
      expect((await persist('officer', body({ request: businessRequest({ applicationId: 'app-b' }) }))).body).toMatchObject({ selectedMethod: 'B_BUSINESS', selection: 'AUTO' });
      const manual = await persist('officer', body({ selectedMethod: 'C_COMBINED', selectionReason: '  Хамтарч тооцох  ' }));
      expect(manual.status).toBe(201);
      expect(manual.body).toMatchObject({ selectedMethod: 'C_COMBINED', selection: 'MANUAL', selectedBy: ACTORS.officer['x-user-id'], selectionReason: 'Хамтарч тооцох' });
      expect(manual.body.result.autoSelected).toBe('A_SALARY');
    });

    it('a non-applicable requested method → 422 METHOD_NOT_APPLICABLE (Mongolian message), nothing stored, no event (FR-8.6)', async () => {
      const res = await persist('officer', body({ selectedMethod: 'B_BUSINESS' }));
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'METHOD_NOT_APPLICABLE', message: expect.stringMatching(CYRILLIC), details: { method: 'B_BUSINESS' } });
      expect(await db.calculation.count()).toBe(0);
      expect(await db.outbox.count()).toBe(0);
    });

    it('no income: stored without a selection and without an event; GET latest 404 before any persist', async () => {
      expect((await latest()).body).toMatchObject({ code: 'CALCULATION_NOT_FOUND', message: expect.stringMatching(CYRILLIC) });
      expect((await latest()).status).toBe(404);
      const res = await persist('officer', body({ request: noIncomeRequest() }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ selectedMethod: null, selection: null });
      expect(res.body.result.methods.every((m: { applicable: boolean }) => !m.applicable)).toBe(true);
      expect(await db.outbox.count()).toBe(0);
    });
  });

  describe('ScoringCompleted outbox row', () => {
    it('parses with the DomainEvent schema and carries selectedMethod, dtiPercent (= burdenPercent) and soscoScore (= newest sosco_result)', async () => {
      // Sosco оноо (олон удаа) — хамгийн шинэ нь event-д орно
      const first = await http().post('/api/sosco/score').set(ACTORS.officer).send({ applicationId: 'app-m8-1', customerId: CUSTOMER, input: { ficoScore: 400, dtiPercent: 70, incomeReliability: 30, pendingSuspiciousCount: 3, activeLoanCount: 3, overdueHistoryMonths: 9, ltv: 0.9 } });
      await new Promise((r) => setTimeout(r, 5));
      const second = await http().post('/api/sosco/score').set(ACTORS.officer).send({ applicationId: 'app-m8-1', customerId: CUSTOMER, input: { ficoScore: 780, dtiPercent: 25, incomeReliability: 90, pendingSuspiciousCount: 0, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: 0.4 } });
      expect(first.body.score).not.toBe(second.body.score);

      const created = await persist();
      const rows = await db.outbox.findMany({ where: { type: 'ScoringCompleted' } });
      expect(rows).toHaveLength(1);
      const event = DomainEvent.parse(rows[0]!.payload);
      expect(ScoringCompleted.parse(event)).toMatchObject({
        orgId: ORG, applicationId: 'app-m8-1', selectedMethod: 'A_SALARY', soscoScore: second.body.score, dtiPercent: created.body.result.methods[0].burdenPercent, actorId: ACTORS.officer['x-user-id'], version: 1,
      });
      expect(rows[0]).toMatchObject({ id: event.eventId, publishedAt: null });
    });

    it('selection and re-selection each emit an event; a rejected selection emits none', async () => {
      await persist();
      const sel = await http().put('/api/underwrite/applications/app-m8-1/selection').set(ACTORS.officer).send({ method: 'C_COMBINED', reason: 'Хамтарсан' });
      expect(sel.status).toBe(200);
      expect((await http().put('/api/underwrite/applications/app-m8-1/selection').set(ACTORS.officer).send({ method: 'B_BUSINESS' })).status).toBe(422);
      const events = await outboxEvents(db, 'ScoringCompleted');
      expect(events.map((e) => e.selectedMethod)).toEqual(['A_SALARY', 'C_COMBINED']);
    });
  });

  describe('selection and stale (FR-8.2, FR-7.3)', () => {
    it('PUT selection → 200 CalculationRecord (MANUAL) that GET latest returns', async () => {
      await persist();
      const res = await http().put('/api/underwrite/applications/app-m8-1/selection').set(ACTORS.officer).send({ method: 'C_COMBINED', reason: 'Бизнесийн орлого нэмэгдсэн' });
      expect(res.status).toBe(200);
      expect(CalculationRecord.safeParse(res.body).success).toBe(true);
      expect(res.body).toMatchObject({ selectedMethod: 'C_COMBINED', selection: 'MANUAL', selectedBy: ACTORS.officer['x-user-id'], selectionReason: 'Бизнесийн орлого нэмэгдсэн' });
      expect((await latest()).body).toEqual(res.body);
    });

    it('404 CALCULATION_NOT_FOUND; 422 METHOD_NOT_APPLICABLE; stale → 409 CALCULATION_STALE (domain code survives the global BSA filter)', async () => {
      const put = (method: string) => http().put('/api/underwrite/applications/app-m8-1/selection').set(ACTORS.officer).send({ method });
      expect((await put('A_SALARY')).body.code).toBe('CALCULATION_NOT_FOUND');
      await persist();
      const notApplicable = await put('B_BUSINESS');
      expect([notApplicable.status, notApplicable.body.code]).toEqual([422, 'METHOD_NOT_APPLICABLE']);
      const stale = await http().post('/api/underwrite/applications/app-m8-1/stale').set(ACTORS.officer).send({ reason: 'Хүү өөрчлөгдсөн' });
      expect(stale.status).toBe(200);
      expect(stale.body).toMatchObject({ isStale: true, staleReason: 'Хүү өөрчлөгдсөн' });
      const blocked = await put('C_COMBINED');
      expect([blocked.status, blocked.body.code]).toEqual([409, 'CALCULATION_STALE']);
      expect(blocked.body.message).toMatch(CYRILLIC);
    });

    it('POST stale is idempotent: 200 both times, the first reason is kept, 404 when no calculation exists', async () => {
      const stale = (reason: string) => http().post('/api/underwrite/applications/app-m8-1/stale').set(ACTORS.officer).send({ reason });
      expect([(await stale('x')).status, (await stale('x')).body.code]).toEqual([404, 'CALCULATION_NOT_FOUND']);
      await persist();
      const one = await stale('Эхний шалтгаан');
      const two = await stale('Хоёр дахь шалтгаан');
      expect([one.status, two.status]).toEqual([200, 200]);
      expect(two.body).toEqual(one.body);
      expect(two.body.staleReason).toBe('Эхний шалтгаан');
      // шинэ тооцоолол хуучирсныг арилгана
      expect((await persist('officer', body({ request: scoreRequest({ amount: 18_000_000 }) }))).body.isStale).toBe(false);
      expect((await latest()).body.isStale).toBe(false);
    });
  });

  describe('organisation isolation (X-Org-Id)', () => {
    it('another organisation cannot read, select or stale this organisation\'s calculation; both organisations can use the same application id', async () => {
      const mine = await persist('officer');
      const other = ACTORS.otherOrgOfficer;
      expect((await latest('otherOrgOfficer')).body.code).toBe('CALCULATION_NOT_FOUND');
      expect((await http().put('/api/underwrite/applications/app-m8-1/selection').set(other).send({ method: 'A_SALARY' })).status).toBe(404);
      expect((await http().post('/api/underwrite/applications/app-m8-1/stale').set(other).send({ reason: 'x' })).status).toBe(404);
      const theirs = await persist('otherOrgOfficer', body({ request: scoreRequest({ amount: 9_000_000 }) }));
      expect(theirs.status).toBe(201);
      expect((await latest('officer')).body).toEqual(mine.body);
      expect((await latest('otherOrgOfficer')).body.id).toBe(theirs.body.id);
    });
  });

  describe('concurrency', () => {
    it('parallel persists for one application via HTTP all return 201 and GET latest is stable', async () => {
      const results = await Promise.all([10, 11, 12, 13, 14, 15].map((m) => persist('officer', body({ request: scoreRequest({ amount: m * 1_000_000 }) }))));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      const newest = [...results].sort((a, b) => Date.parse(b.body.computedAt) - Date.parse(a.body.computedAt))[0]!;
      for (const read of await Promise.all([latest(), latest(), latest()])) expect(read.body.id).toBe(newest.body.id);
    });
  });
});
