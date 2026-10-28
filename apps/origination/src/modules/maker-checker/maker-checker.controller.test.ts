import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MakerCheckerController } from './maker-checker.controller';
import { MakerCheckerService } from './maker-checker.service';
import { build } from './testing/fixtures';

const H = (userId: string, roles: string, extra: Record<string, string> = {}) => ({ 'X-User-Id': userId, 'X-Roles': roles, 'X-Branch-Id': 'B1', 'X-Org-Id': 'org1', ...extra });
const body = (over: Record<string, unknown> = {}) => ({ targetType: 'BLACKLIST_ENTRY', action: 'UPDATE', targetId: 'REG1', payload: { name: 'N' }, reason: 'Шалтгаан', ...over });

let app: INestApplication;
let ctx: ReturnType<typeof build>;

beforeAll(async () => {
  ctx = build();
  const mod = await Test.createTestingModule({ controllers: [MakerCheckerController], providers: [{ provide: MakerCheckerService, useFactory: () => ctx.svc }] }).compile();
  app = mod.createNestApplication();
  app.useLogger(false);
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(() => app.close());
beforeEach(() => { ctx.store.state = build().store.state; });

const http = () => request(app.getHttpServer());

describe('maker-checker REST', () => {
  it('401 without identity', async () => {
    const res = await http().get('/api/maker-checker/requests');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('POST /requests → 202 PENDING; validation errors → 400; unknown handler → 422; wrong maker role → 403', async () => {
    const ok = await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body());
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ outcome: 'PENDING', request: { status: 'PENDING', makerId: 'officerA', canCancel: true } });

    const bad = await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body({ reason: 'a', targetId: '' }));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect(bad.body.details.length).toBeGreaterThan(0);

    expect((await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body({ targetType: 'NOPE' }))).status).toBe(422);
    expect((await http().post('/api/maker-checker/requests').set(H('x', 'APPROVER')).send(body({ targetId: 'REG7' }))).status).toBe(403);
    expect((await http().post('/api/maker-checker/requests').set(H('officerB', 'OFFICER')).send(body())).body.code).toBe('TARGET_HAS_PENDING_CHANGE');
  });

  it('the full flow over HTTP: submit → inbox → approve; maker is blocked; second approval is 409', async () => {
    const created = (await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body())).body.request;
    const id = created.id as string;

    const self = await http().post(`/api/maker-checker/requests/${id}/approve`).set(H('officerA', 'OFFICER,BRANCH_MANAGER')).send({});
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const summary = await http().get('/api/maker-checker/requests/summary').set(H('managerB1', 'BRANCH_MANAGER'));
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual({ inbox: 1, mine: 0 });

    const inbox = await http().get('/api/maker-checker/requests?scope=inbox&pageSize=10').set(H('managerB1', 'branch_manager'));
    expect(inbox.status).toBe(200);
    expect(inbox.body).toMatchObject({ total: 1, page: 1, pageSize: 10, items: [{ id, canDecide: true }] });

    const approved = await http().post(`/api/maker-checker/requests/${id}/approve`).set(H('managerB1', 'BRANCH_MANAGER')).send({ comment: 'ok' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPLIED', checkerId: 'managerB1', history: [{ event: 'SUBMITTED' }, { event: 'APPLIED' }] });

    const again = await http().post(`/api/maker-checker/requests/${id}/approve`).set(H('approver', 'APPROVER')).send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_DECIDED');
    expect((await http().get(`/api/maker-checker/requests/${id}`).set(H('officerA', 'OFFICER'))).body.status).toBe('APPLIED');
  });

  it('reject requires a comment; cancel is maker-only', async () => {
    const id = (await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body())).body.request.id as string;
    const noComment = await http().post(`/api/maker-checker/requests/${id}/reject`).set(H('managerB1', 'BRANCH_MANAGER')).send({});
    expect(noComment.status).toBe(400);
    const rejected = await http().post(`/api/maker-checker/requests/${id}/reject`).set(H('managerB1', 'BRANCH_MANAGER')).send({ comment: 'Дутуу баримт' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', checkerComment: 'Дутуу баримт' });

    const id2 = (await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body({ targetId: 'REG2' }))).body.request.id as string;
    expect((await http().post(`/api/maker-checker/requests/${id2}/cancel`).set(H('managerB1', 'BRANCH_MANAGER')).send({})).body.code).toBe('ONLY_MAKER_CAN_CANCEL');
    expect((await http().post(`/api/maker-checker/requests/${id2}/cancel`).set(H('officerA', 'OFFICER')).send({ comment: 'буруу' })).body.status).toBe('CANCELLED');
  });

  it('path/query validation: bad uuid → 400, bad pageSize → 400, scope=all needs ADMIN', async () => {
    expect((await http().get('/api/maker-checker/requests/not-a-uuid').set(H('a', 'ADMIN'))).status).toBe(400);
    expect((await http().get('/api/maker-checker/requests?pageSize=7').set(H('a', 'ADMIN'))).status).toBe(400);
    expect((await http().get('/api/maker-checker/requests/00000000-0000-4000-8000-000000000000').set(H('a', 'ADMIN'))).status).toBe(404);
    expect((await http().get('/api/maker-checker/requests?scope=all').set(H('m', 'BRANCH_MANAGER'))).status).toBe(403);
    expect((await http().get('/api/maker-checker/requests?scope=all').set(H('a', 'ADMIN'))).status).toBe(200);
  });

  it('policies: GET for ADMIN/APPROVER, PUT is a four-eyes request (202) another admin approves', async () => {
    expect((await http().get('/api/maker-checker/policies').set(H('o', 'OFFICER'))).status).toBe(403);
    const list = await http().get('/api/maker-checker/policies').set(H('adminA', 'ADMIN'));
    expect(list.status).toBe(200);
    expect(list.body.map((p: { targetType: string }) => p.targetType)).toEqual(['BLACKLIST_ENTRY', 'MAKER_CHECKER_POLICY']);

    const put = await http().put('/api/maker-checker/policies/BLACKLIST_ENTRY/UPDATE').set(H('adminA', 'ADMIN'))
      .send({ enabled: false, checkerRoles: ['APPROVER'], expiresInHours: 12, reason: 'Түр' });
    expect(put.status).toBe(202);
    expect(put.body.outcome).toBe('PENDING');
    expect((await http().post(`/api/maker-checker/requests/${put.body.request.id}/approve`).set(H('adminA', 'ADMIN')).send({})).body.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await http().post(`/api/maker-checker/requests/${put.body.request.id}/approve`).set(H('adminB', 'ADMIN')).send({})).status).toBe(200);

    // policy disabled → DIRECT → HTTP 201
    const direct = await http().post('/api/maker-checker/requests').set(H('officerA', 'OFFICER')).send(body({ targetId: 'REG5' }));
    expect(direct.status).toBe(201);
    expect(direct.body).toMatchObject({ outcome: 'APPLIED_DIRECT', request: { mode: 'DIRECT' } });

    expect((await http().put('/api/maker-checker/policies/BLACKLIST_ENTRY/UPDATE').set(H('adminA', 'ADMIN')).send({ enabled: true, checkerRoles: [], expiresInHours: 12, reason: 'abc' })).status).toBe(400);
    expect((await http().put('/api/maker-checker/policies/lower/UPDATE').set(H('adminA', 'ADMIN')).send({ enabled: true, checkerRoles: ['ADMIN'], expiresInHours: 12, reason: 'abc' })).status).toBe(400);
  });

  it('unexpected errors become a generic 500 without leaking internals', async () => {
    const original = ctx.svc.summary.bind(ctx.svc);
    ctx.svc.summary = async () => { throw new Error('connection string postgres://secret'); };
    const res = await http().get('/api/maker-checker/requests/summary').set(H('a', 'ADMIN'));
    ctx.svc.summary = original;
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, code: 'INTERNAL', message: 'Системийн алдаа гарлаа' });
  });
});
