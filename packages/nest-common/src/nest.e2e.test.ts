import 'reflect-metadata';
import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CommonModule } from './common.module';
import { Public, Permissions, Roles } from './auth/guards';
import { assertInScope } from './auth/scope';
import { Ctx } from './context/request-context';
import { DomainError } from './http/errors';
import { ZodValidationPipe } from './http/zod.pipe';
import { HealthModule } from './health/health.module';
import type { RequestContext } from '@los/contracts';

const Body1 = z.object({ amount: z.number().positive() });
@Controller('t')
class TestController {
  @Public() @Get('open') open() { return { ok: true }; }
  @Get('me') me(@Ctx() ctx: RequestContext) { return ctx; }
  @Roles('ADMIN') @Get('admin') admin() { return { ok: true }; }
  @Permissions('approval:vote') @Get('vote') vote() { return { ok: true }; }
  @Post('echo') echo(@Body(new ZodValidationPipe(Body1)) b: z.infer<typeof Body1>) { return b; }
  @Get('domain') domain() { throw new DomainError('LTV_EXCEEDED', 'LTV хэтэрсэн', 422, { ltv: 0.8 }); }
  @Get('boom') boom() { throw new Error('secret db password leaked'); }
  @Get('app/:officer') app(@Ctx() ctx: RequestContext) { assertInScope(ctx, { officerId: 'someone-else', branchId: 'b1', orgId: ctx.orgId }); return {}; }
  @Get('prisma') prisma() { throw Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P2002', meta: { target: ['register_no_hash'] } }); }
}
@Module({ imports: [CommonModule.forRoot(), HealthModule.forService('test', { db: async () => {}, redis: async () => { throw new Error('down'); } })], controllers: [TestController] })
class TestAppModule {}

const as = (roles: string, extra: Record<string, string> = {}) => ({ 'x-user-id': 'u1', 'x-roles': roles, 'x-org-id': 'o1', 'x-branch-id': 'b1', ...extra });
let app: INestApplication;
beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
});
afterAll(async () => { delete process.env.INTERNAL_AUTH_SECRET; await app.close(); });

describe('CommonModule (guard, filter, context)', () => {
  it('public endpoints need no identity and echo a correlation id', async () => {
    const res = await request(app.getHttpServer()).get('/api/t/open').set('x-correlation-id', 'abc-1');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('abc-1');
  });
  it('401 without identity, 401 without org', async () => {
    expect((await request(app.getHttpServer()).get('/api/t/me')).body).toMatchObject({ code: 'UNAUTHENTICATED' });
    const r = await request(app.getHttpServer()).get('/api/t/me').set({ 'x-user-id': 'u1' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('MISSING_ORG');
  });
  it('injects the parsed context via @Ctx()', async () => {
    const res = await request(app.getHttpServer()).get('/api/t/me').set(as('OFFICER'));
    expect(res.body).toMatchObject({ userId: 'u1', roles: ['OFFICER'], orgId: 'o1', branchId: 'b1' });
  });
  it('@Roles and @Permissions enforce RBAC', async () => {
    expect((await request(app.getHttpServer()).get('/api/t/admin').set(as('OFFICER'))).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/api/t/admin').set(as('ADMIN'))).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/api/t/vote').set(as('OFFICER'))).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/api/t/vote').set(as('APPROVER'))).status).toBe(200);
  });
  it('validates bodies with zod → 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer()).post('/api/t/echo').set(as('OFFICER')).send({ amount: -1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details[0].path).toBe('amount');
    expect((await request(app.getHttpServer()).post('/api/t/echo').set(as('OFFICER')).send({ amount: 5 })).body).toEqual({ amount: 5 });
  });
  it('maps domain, prisma and unknown errors without leaking internals', async () => {
    const d = await request(app.getHttpServer()).get('/api/t/domain').set(as('OFFICER'));
    expect(d.status).toBe(422);
    expect(d.body).toMatchObject({ code: 'LTV_EXCEEDED', message: 'LTV хэтэрсэн', details: { ltv: 0.8 } });
    const p = await request(app.getHttpServer()).get('/api/t/prisma').set(as('OFFICER'));
    expect(p.status).toBe(409);
    const b = await request(app.getHttpServer()).get('/api/t/boom').set(as('OFFICER'));
    expect(b.status).toBe(500);
    expect(JSON.stringify(b.body)).not.toContain('password');
    expect(b.body.code).toBe('INTERNAL');
  });
  it('officer cannot read another officer\'s record → 403 OUT_OF_SCOPE', async () => {
    const res = await request(app.getHttpServer()).get('/api/t/app/x').set(as('OFFICER'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
    expect((await request(app.getHttpServer()).get('/api/t/app/x').set(as('APPROVER'))).status).toBe(200);
  });
  it('health: liveness is 200, readiness is 503 when a dependency is down', async () => {
    const h = await request(app.getHttpServer()).get('/api/health');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ service: 'test', ok: true });
    const r = await request(app.getHttpServer()).get('/api/health/ready');
    expect(r.status).toBe(503);
    expect(r.body.details.checks).toEqual({ db: 'up', redis: 'down' });
  });
  it('INTERNAL_AUTH_SECRET blocks calls that bypass the gateway', async () => {
    process.env.INTERNAL_AUTH_SECRET = 'topsecret';
    expect((await request(app.getHttpServer()).get('/api/t/me').set(as('OFFICER'))).body.code).toBe('INVALID_INTERNAL_TOKEN');
    expect((await request(app.getHttpServer()).get('/api/t/me').set(as('OFFICER', { 'x-internal-token': 'wrong' }))).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/t/me').set(as('OFFICER', { 'x-internal-token': 'topsecret' }))).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/api/health')).status).toBe(200);
    delete process.env.INTERNAL_AUTH_SECRET;
  });
});
