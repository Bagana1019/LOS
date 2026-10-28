// Модулийн бодит wiring + plug-in гэрээ (docs/05 §8): домэйн модуль MakerCheckerModule-ийг import хийж, өөрийн контроллероос
// makerChecker.submit()-ийг дуудахад алдаа HTTP статус болж хөрвөх ёстой (filter-ийг контроллер бүрт залгахгүй).
import { Body, Controller, Inject, Injectable, Module, Param, Patch, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CurrentActor, type Actor } from './actor';
import { ChangeHandlerRegistry, ChangeValidationError, type ApplyContext, type ChangeHandler } from './change-handler';
import { CHANGE_REQUEST_STORE } from './change-request.store';
import { MAKER_CHECKER_PRISMA } from './infra/prisma-client.provider';
import { MakerCheckerModule } from './maker-checker.module';
import { MakerCheckerService } from './maker-checker.service';
import { InMemoryChangeRequestStore } from './testing/in-memory.store';

const Rename = z.object({ name: z.string().min(1) });

/** docs/05 §8-ын жишээ handler: домэйн модуль өөрийн handler-ээ бүртгэнэ */
@Injectable()
class RenameHandler implements ChangeHandler<z.infer<typeof Rename>> {
  readonly targetType = 'DEMO_ENTRY';
  readonly action = 'RENAME';
  readonly payloadSchema = Rename;
  readonly makerRoles = ['OFFICER'] as const;
  readonly defaultPolicy = { enabled: true, checkerRoles: ['APPROVER'], expiresInHours: 24 } as const;
  applied: string[] = [];
  constructor(@Inject(ChangeHandlerRegistry) registry: ChangeHandlerRegistry) { registry.register(this); }
  validate({ payload }: { payload: z.infer<typeof Rename> }) { if (payload.name === 'taken') throw new ChangeValidationError('Нэр давхардсан'); }
  async apply({ payload }: ApplyContext<z.infer<typeof Rename>>) { this.applied.push(payload.name); }
}

@Controller('demo')
class DemoController {
  constructor(@Inject(MakerCheckerService) private readonly makerChecker: MakerCheckerService) {}
  @Patch(':id')
  rename(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: { name: unknown; reason: string }) {
    return this.makerChecker.submit(actor, { targetType: 'DEMO_ENTRY', action: 'RENAME', targetId: id, payload: { name: body.name }, reason: body.reason });
  }
}

@Module({ imports: [MakerCheckerModule], controllers: [DemoController], providers: [RenameHandler] })
class DemoModule {}

let app: INestApplication;
let handler: RenameHandler;
const H = (userId: string, roles: string) => ({ 'X-User-Id': userId, 'X-Roles': roles, 'X-Org-Id': 'org1', 'X-Branch-Id': 'B1' });
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  process.env.MAKER_CHECKER_SWEEP_SECONDS = '0'; // sweeper-ийг ажиллуулахгүй
  const mod = await Test.createTestingModule({ imports: [DemoModule] })
    .overrideProvider(CHANGE_REQUEST_STORE).useValue(new InMemoryChangeRequestStore())
    .overrideProvider(MAKER_CHECKER_PRISMA).useValue({})
    .compile();
  app = mod.createNestApplication();
  app.useLogger(false);
  await app.init();
  handler = mod.get(RenameHandler);
});
afterAll(async () => { await app.close(); delete process.env.MAKER_CHECKER_SWEEP_SECONDS; });

describe('MakerCheckerModule wiring', () => {
  it('registers the built-in policy handler and exports the service + registry to domain modules', () => {
    const registry = app.get(ChangeHandlerRegistry);
    expect(registry.list().map((h) => `${h.targetType}:${h.action}`).sort()).toEqual(['DEMO_ENTRY:RENAME', 'MAKER_CHECKER_POLICY:UPDATE']);
  });

  it('the built-in REST API is mounted and lists the registered policies', async () => {
    const res = await http().get('/maker-checker/policies').set(H('adm', 'ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.map((p: { targetType: string }) => p.targetType)).toEqual(['DEMO_ENTRY', 'MAKER_CHECKER_POLICY']);
  });
});

describe('plug-in contract: a domain controller calling submit() gets proper HTTP errors without extra wiring', () => {
  const patch = (id: string, who: [string, string] | null, body: Record<string, unknown>) => {
    const r = http().patch(`/demo/${id}`);
    return (who ? r.set(H(...who)) : r).send(body);
  };

  it('happy path: PENDING, then a different checker approves through the built-in API and the handler runs once', async () => {
    const res = await patch('E1', ['o1', 'OFFICER'], { name: 'New', reason: 'Засвар хийв' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'PENDING', request: { targetType: 'DEMO_ENTRY', targetId: 'E1' } });
    expect(handler.applied).toEqual([]);
    const done = await http().post(`/maker-checker/requests/${res.body.request.id}/approve`).set(H('a1', 'APPROVER')).send({});
    expect(done.status).toBe(200);
    expect(handler.applied).toEqual(['New']);
  });

  it.each([
    ['401 UNAUTHENTICATED (no identity header)', 'E2', null, { name: 'x', reason: 'Шалтгаан' }, 401, 'UNAUTHENTICATED'],
    ['403 MAKER_ROLE_FORBIDDEN (wrong maker role)', 'E2', ['a1', 'APPROVER'] as [string, string], { name: 'x', reason: 'Шалтгаан' }, 403, 'MAKER_ROLE_FORBIDDEN'],
    ['400 VALIDATION_FAILED (reason too short)', 'E2', ['o1', 'OFFICER'] as [string, string], { name: 'x', reason: 'a' }, 400, 'VALIDATION_FAILED'],
    ['422 PAYLOAD_INVALID (schema)', 'E2', ['o1', 'OFFICER'] as [string, string], { name: '', reason: 'Шалтгаан' }, 422, 'PAYLOAD_INVALID'],
    ['422 PAYLOAD_INVALID (business validate hook, message shown)', 'E2', ['o1', 'OFFICER'] as [string, string], { name: 'taken', reason: 'Шалтгаан' }, 422, 'PAYLOAD_INVALID'],
  ])('%s', async (_title, id, who, body, status, errCode) => {
    const res = await patch(id, who, body);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ statusCode: status, code: errCode });
    expect(typeof res.body.message).toBe('string');
  });

  it('409 TARGET_HAS_PENDING_CHANGE for a second change on the same target', async () => {
    expect((await patch('E3', ['o1', 'OFFICER'], { name: 'A', reason: 'Шалтгаан' })).status).toBe(200);
    const res = await patch('E3', ['o2', 'OFFICER'], { name: 'B', reason: 'Шалтгаан' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TARGET_HAS_PENDING_CHANGE' });
  });

  it('the business-validation message of a ChangeValidationError reaches the maker', async () => {
    const res = await patch('E4', ['o1', 'OFFICER'], { name: 'taken', reason: 'Шалтгаан' });
    expect(res.body.message).toBe('Нэр давхардсан');
  });
});
