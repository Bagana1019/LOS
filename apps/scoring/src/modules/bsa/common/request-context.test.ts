// parseRequestContext, Nest glue (@Ctx / RequestContextGuard — бодит HTTP-ээр), хандалтын матриц. Бүх id хуурмаг.
import type { UserRole } from '@los/contracts';
import { Controller, ForbiddenException, Get, HttpException, NotFoundException, UnauthorizedException, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from './infra.ports';
import {
  analysisListScope,
  analysisNotFound,
  assertCanAccessAnalysis,
  Ctx,
  decideAnalysisAccess,
  FALLBACK_ORG_ID,
  parseRequestContext,
  REQUEST_CONTEXT_MESSAGES,
  RequestContextGuard,
  type AccessDecision,
  type AnalysisAccessTarget,
} from './request-context';

const gen = () => 'gen-corr-1';
const base = { 'x-user-id': 'u-1', 'x-roles': 'OFFICER', 'x-branch-id': 'br-1', 'x-org-id': 'org-1', 'x-correlation-id': 'corr-1' };

function failure(fn: () => unknown): HttpException {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return e as HttpException;
  }
  throw new Error('expected an HttpException');
}

describe('parseRequestContext', () => {
  it('parses a full set of gateway headers', () => {
    expect(parseRequestContext(base, {})).toEqual({ orgId: 'org-1', userId: 'u-1', roles: ['OFFICER'], branchId: 'br-1', correlationId: 'corr-1' });
  });

  it('header names are case-insensitive (Node lower-cases them; tests/other callers may not)', () => {
    const ctx = parseRequestContext({ 'X-User-Id': 'u-2', 'X-Roles': 'ADMIN', 'X-Branch-Id': 'br-9', 'X-Org-Id': 'o-9', 'X-Correlation-Id': 'c-9' }, {});
    expect(ctx).toEqual({ orgId: 'o-9', userId: 'u-2', roles: ['ADMIN'], branchId: 'br-9', correlationId: 'c-9' });
  });

  it('parses a comma-separated role list (spaces, repeats, empty members tolerated) in order', () => {
    const roles = parseRequestContext({ ...base, 'x-roles': ' OFFICER , BRANCH_MANAGER,, OFFICER,APPROVER ' }, {}).roles;
    expect(roles).toEqual(['OFFICER', 'BRANCH_MANAGER', 'APPROVER']);
  });

  it('X-Branch-Id is optional (null)', () => {
    const { 'x-branch-id': _b, ...noBranch } = base;
    expect(parseRequestContext(noBranch, {}).branchId).toBeNull();
    expect(parseRequestContext({ ...base, 'x-branch-id': '  ' }, {}).branchId).toBeNull();
  });

  it('X-Org-Id falls back to env DEFAULT_ORG_ID, then to "org-default"', () => {
    const { 'x-org-id': _o, ...noOrg } = base;
    expect(parseRequestContext(noOrg, { DEFAULT_ORG_ID: 'env-org' }).orgId).toBe('env-org');
    expect(parseRequestContext(noOrg, {}).orgId).toBe(FALLBACK_ORG_ID);
    expect(FALLBACK_ORG_ID).toBe('org-default');
    expect(parseRequestContext({ ...noOrg, 'x-org-id': '' }, { DEFAULT_ORG_ID: ' ' }).orgId).toBe('org-default');
    expect(parseRequestContext(base, { DEFAULT_ORG_ID: 'env-org' }).orgId).toBe('org-1'); // толгой env-ээс давуу
  });

  it('generates a correlation id when absent or malformed (injectable generator)', () => {
    const { 'x-correlation-id': _c, ...noCorr } = base;
    expect(parseRequestContext(noCorr, {}, { generateCorrelationId: gen }).correlationId).toBe('gen-corr-1');
    expect(parseRequestContext({ ...base, 'x-correlation-id': 'bad id\nwith newline' }, {}, { generateCorrelationId: gen }).correlationId).toBe('gen-corr-1');
    expect(parseRequestContext({ ...base, 'x-correlation-id': 'x'.repeat(129) }, {}, { generateCorrelationId: gen }).correlationId).toBe('gen-corr-1');
    expect(parseRequestContext(noCorr, {}).correlationId).toMatch(/^[0-9a-f-]{36}$/); // анхдагч: uuid
  });

  describe('401 Unauthorized (identity)', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['blank', '   '],
      ['contains space', 'u 1'],
      ['contains newline', 'u-1\nX-Roles: ADMIN'],
      ['cyrillic', 'хэрэглэгч'],
      ['too long', 'u'.repeat(129)],
      ['duplicate header values', ['u-1', 'u-2']],
      ['empty array', []],
    ])('X-User-Id %s', (_n, value) => {
      const e = failure(() => parseRequestContext({ ...base, 'x-user-id': value as string }, {}));
      expect(e).toBeInstanceOf(UnauthorizedException);
      expect(e.getStatus()).toBe(401);
      expect(e.message).toBe(REQUEST_CONTEXT_MESSAGES.missingUser);
      expect(e.message).toMatch(/[Хх]эрэглэгч/); // монгол мессеж
    });
    it('all headers absent -> 401 (not 403)', () => {
      expect(failure(() => parseRequestContext({}, {})).getStatus()).toBe(401);
    });
    it('does not echo the submitted value', () => {
      expect(failure(() => parseRequestContext({ ...base, 'x-user-id': 'bad user\u0000' }, {})).message).not.toContain('bad user');
    });
  });

  describe('403 Forbidden (roles and scope)', () => {
    it.each([
      ['unknown role', 'OFFICER,SUPERUSER', REQUEST_CONTEXT_MESSAGES.unknownRole],
      ['only unknown', 'root', REQUEST_CONTEXT_MESSAGES.unknownRole],
      ['wrong case', 'officer', REQUEST_CONTEXT_MESSAGES.unknownRole],
      ['role with extra token', 'ADMIN;OFFICER', REQUEST_CONTEXT_MESSAGES.unknownRole],
      ['missing', undefined, REQUEST_CONTEXT_MESSAGES.noRoles],
      ['empty', '', REQUEST_CONTEXT_MESSAGES.noRoles],
      ['only commas', ' , ,', REQUEST_CONTEXT_MESSAGES.noRoles],
    ])('X-Roles %s', (_n, value, message) => {
      const e = failure(() => parseRequestContext({ ...base, 'x-roles': value }, {}));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getStatus()).toBe(403);
      expect(e.message).toBe(message);
    });

    it('a valid user with a bad role is 403 even though identity is fine; bad identity wins over bad roles', () => {
      expect(failure(() => parseRequestContext({ ...base, 'x-roles': 'nope' }, {})).getStatus()).toBe(403);
      expect(failure(() => parseRequestContext({ 'x-roles': 'nope' }, {})).getStatus()).toBe(401);
    });

    it('does not echo the unknown role back', () => {
      expect(failure(() => parseRequestContext({ ...base, 'x-roles': 'SUPERUSER' }, {})).message).not.toContain('SUPERUSER');
    });

    it.each([
      ['org with space', { 'x-org-id': 'org 1' }],
      ['org duplicate', { 'x-org-id': ['a', 'b'] }],
      ['branch with newline', { 'x-branch-id': 'b\n1' }],
      ['branch too long', { 'x-branch-id': 'b'.repeat(200) }],
    ])('malformed scope header (%s) -> 403', (_n, over) => {
      const e = failure(() => parseRequestContext({ ...base, ...over }, {}));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.message).toBe(REQUEST_CONTEXT_MESSAGES.badScope);
    });

    it('a malformed server-side DEFAULT_ORG_ID is a configuration error, not a client error', () => {
      const { 'x-org-id': _o, ...noOrg } = base;
      expect(() => parseRequestContext(noOrg, { DEFAULT_ORG_ID: 'bad org' })).toThrow(/DEFAULT_ORG_ID/);
    });
  });
});

describe('Nest glue over real HTTP (@Ctx, RequestContextGuard)', () => {
  @Controller('guarded')
  @UseGuards(RequestContextGuard)
  class GuardedController {
    @Get('me')
    me(@Ctx() ctx: RequestContext): RequestContext {
      return ctx;
    }
    @Get('twice')
    twice(@Ctx() a: RequestContext, @Ctx() b: RequestContext): { same: boolean } {
      return { same: a === b };
    }
  }
  @Controller('open')
  class UnguardedController {
    @Get('me')
    me(@Ctx() ctx: RequestContext): RequestContext {
      return ctx;
    }
  }

  let app: INestApplication;
  beforeAll(async () => {
    process.env.DEFAULT_ORG_ID = 'env-default-org';
    const moduleRef = await Test.createTestingModule({ controllers: [GuardedController, UnguardedController] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    delete process.env.DEFAULT_ORG_ID;
    await app.close();
  });

  const hdr = (over: Record<string, string> = {}) => ({
    'X-User-Id': 'u-5', 'X-Roles': 'OFFICER,BRANCH_MANAGER', 'X-Branch-Id': 'br-5', 'X-Correlation-Id': 'c-5', ...over,
  });

  it.each(['guarded', 'open'])('/%s/me injects the parsed context (org from env default)', async (path) => {
    const res = await request(app.getHttpServer()).get(`/${path}/me`).set(hdr()).expect(200);
    expect(res.body).toEqual({ orgId: 'env-default-org', userId: 'u-5', roles: ['OFFICER', 'BRANCH_MANAGER'], branchId: 'br-5', correlationId: 'c-5' });
  });

  it.each(['guarded', 'open'])('/%s/me answers 401 with a Mongolian message when X-User-Id is missing', async (path) => {
    const res = await request(app.getHttpServer()).get(`/${path}/me`).set('X-Roles', 'ADMIN').expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, message: REQUEST_CONTEXT_MESSAGES.missingUser });
  });

  it.each(['guarded', 'open'])('/%s/me answers 403 for an unknown role', async (path) => {
    const res = await request(app.getHttpServer()).get(`/${path}/me`).set(hdr({ 'X-Roles': 'GOD' })).expect(403);
    expect(res.body).toMatchObject({ statusCode: 403, message: REQUEST_CONTEXT_MESSAGES.unknownRole });
  });

  it('generates a correlation id once per request (guard and decorator share it)', async () => {
    const res = await request(app.getHttpServer()).get('/guarded/me').set({ 'X-User-Id': 'u-5', 'X-Roles': 'ADMIN' }).expect(200);
    expect(res.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    await request(app.getHttpServer()).get('/guarded/twice').set({ 'X-User-Id': 'u-5', 'X-Roles': 'ADMIN' }).expect(200, { same: true });
  });

  it('a different request gets a fresh context (no cross-request caching)', async () => {
    const a = await request(app.getHttpServer()).get('/open/me').set(hdr({ 'X-User-Id': 'u-a' })).expect(200);
    const b = await request(app.getHttpServer()).get('/open/me').set(hdr({ 'X-User-Id': 'u-b' })).expect(200);
    expect([a.body.userId, b.body.userId]).toEqual(['u-a', 'u-b']);
  });
});

// ───────────────────────── хандалтын матриц ─────────────────────────

const ctxOf = (roles: UserRole[], over: Partial<RequestContext> = {}): RequestContext => ({
  orgId: 'org-1', userId: 'u-me', roles, branchId: 'br-1', correlationId: 'c', ...over,
});
const target = (over: Partial<AnalysisAccessTarget> = {}): AnalysisAccessTarget => ({ orgId: 'org-1', branchId: 'br-1', createdBy: 'u-me', ...over });

describe('decideAnalysisAccess / assertCanAccessAnalysis: matrix', () => {
  // [тайлбар, үүргүүд, ctx-ийн өөрчлөлт, target-ийн өөрчлөлт, хүлээгдэх шийдвэр]
  const cases: Array<[string, UserRole[], Partial<RequestContext>, Partial<AnalysisAccessTarget>, AccessDecision]> = [
    // ADMIN: байгууллагын дотор бүгд
    ['ADMIN own', ['ADMIN'], {}, {}, 'ALLOW'],
    ['ADMIN other branch', ['ADMIN'], {}, { branchId: 'br-2' }, 'ALLOW'],
    ['ADMIN other creator', ['ADMIN'], {}, { createdBy: 'u-other' }, 'ALLOW'],
    ['ADMIN no branch on target', ['ADMIN'], {}, { branchId: null, createdBy: null }, 'ALLOW'],
    ['ADMIN without own branch', ['ADMIN'], { branchId: null }, { branchId: 'br-9' }, 'ALLOW'],
    // APPROVER: адил
    ['APPROVER other branch', ['APPROVER'], {}, { branchId: 'br-2', createdBy: 'u-x' }, 'ALLOW'],
    ['APPROVER without own branch', ['APPROVER'], { branchId: null }, {}, 'ALLOW'],
    // BRANCH_MANAGER: өөрийн салбар
    ['BM same branch, own', ['BRANCH_MANAGER'], {}, {}, 'ALLOW'],
    ['BM same branch, other creator', ['BRANCH_MANAGER'], {}, { createdBy: 'u-other' }, 'ALLOW'],
    ['BM same branch, null creator', ['BRANCH_MANAGER'], {}, { createdBy: null }, 'ALLOW'],
    ['BM other branch', ['BRANCH_MANAGER'], {}, { branchId: 'br-2' }, 'FORBIDDEN'],
    ['BM target without branch', ['BRANCH_MANAGER'], {}, { branchId: null }, 'FORBIDDEN'],
    ['BM without branch vs null-branch target (null !== null)', ['BRANCH_MANAGER'], { branchId: null }, { branchId: null }, 'FORBIDDEN'],
    ['BM without branch', ['BRANCH_MANAGER'], { branchId: null }, {}, 'FORBIDDEN'],
    // OFFICER: өөрийн салбар БА өөрийн үүсгэсэн
    ['OFFICER same branch, own', ['OFFICER'], {}, {}, 'ALLOW'],
    ['OFFICER same branch, other creator', ['OFFICER'], {}, { createdBy: 'u-other' }, 'FORBIDDEN'],
    ['OFFICER same branch, null creator', ['OFFICER'], {}, { createdBy: null }, 'FORBIDDEN'],
    ['OFFICER other branch, own', ['OFFICER'], {}, { branchId: 'br-2' }, 'FORBIDDEN'],
    ['OFFICER target without branch, own', ['OFFICER'], {}, { branchId: null }, 'FORBIDDEN'],
    ['OFFICER without branch', ['OFFICER'], { branchId: null }, { branchId: null }, 'FORBIDDEN'],
    // олон үүрэг: хамгийн өргөн нь
    ['OFFICER+BM same branch, other creator', ['OFFICER', 'BRANCH_MANAGER'], {}, { createdBy: 'u-other' }, 'ALLOW'],
    ['OFFICER+BM other branch', ['OFFICER', 'BRANCH_MANAGER'], {}, { branchId: 'br-2' }, 'FORBIDDEN'],
    ['OFFICER+APPROVER other branch', ['OFFICER', 'APPROVER'], {}, { branchId: 'br-2', createdBy: 'u-x' }, 'ALLOW'],
    // үүргүй
    ['no roles', [], {}, {}, 'FORBIDDEN'],
    // өөр байгууллага: ямар ч үүрэг → NOT_FOUND
    ['ADMIN other org', ['ADMIN'], {}, { orgId: 'org-2' }, 'NOT_FOUND'],
    ['APPROVER other org', ['APPROVER'], {}, { orgId: 'org-2' }, 'NOT_FOUND'],
    ['BM other org, same branch id', ['BRANCH_MANAGER'], {}, { orgId: 'org-2' }, 'NOT_FOUND'],
    ['OFFICER other org, same branch id and creator', ['OFFICER'], {}, { orgId: 'org-2' }, 'NOT_FOUND'],
    ['no roles other org', [], {}, { orgId: 'org-2' }, 'NOT_FOUND'],
  ];

  it.each(cases)('%s -> %s', (_name, roles, ctxOver, targetOver, expected) => {
    const ctx = ctxOf(roles, ctxOver);
    const t = target(targetOver);
    expect(decideAnalysisAccess(ctx, t)).toBe(expected);
    if (expected === 'ALLOW') {
      expect(() => assertCanAccessAnalysis(ctx, t)).not.toThrow();
    } else if (expected === 'FORBIDDEN') {
      const e = failure(() => assertCanAccessAnalysis(ctx, t));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.getStatus()).toBe(403);
      expect(e.message).toBe(REQUEST_CONTEXT_MESSAGES.forbidden);
    } else {
      const e = failure(() => assertCanAccessAnalysis(ctx, t));
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.getStatus()).toBe(404);
    }
  });

  it('another organisation is indistinguishable from a missing analysis (same status, body and message)', () => {
    const otherOrg = failure(() => assertCanAccessAnalysis(ctxOf(['ADMIN']), target({ orgId: 'org-2' })));
    const missing = analysisNotFound();
    expect(otherOrg.getStatus()).toBe(missing.getStatus());
    expect(otherOrg.getResponse()).toEqual(missing.getResponse());
    expect(otherOrg.message).toBe(REQUEST_CONTEXT_MESSAGES.analysisNotFound);
  });

  it('all denial messages are Mongolian Cyrillic', () => {
    for (const m of Object.values(REQUEST_CONTEXT_MESSAGES)) expect(m).toMatch(/[А-Яа-яӨөҮү]/);
  });
});

describe('analysisListScope is consistent with decideAnalysisAccess', () => {
  const roleSets: UserRole[][] = [[], ['OFFICER'], ['BRANCH_MANAGER'], ['APPROVER'], ['ADMIN'], ['OFFICER', 'BRANCH_MANAGER'], ['OFFICER', 'APPROVER']];
  const ctxBranches: Array<string | null> = ['br-1', null];
  const targets: AnalysisAccessTarget[] = [];
  for (const orgId of ['org-1', 'org-2']) {
    for (const branchId of ['br-1', 'br-2', null]) {
      for (const createdBy of ['u-me', 'u-other', null]) targets.push({ orgId, branchId, createdBy });
    }
  }
  const matches = (scope: NonNullable<ReturnType<typeof analysisListScope>>, t: AnalysisAccessTarget): boolean =>
    t.orgId === scope.orgId && (scope.branchId === undefined || t.branchId === scope.branchId) && (scope.createdBy === undefined || t.createdBy === scope.createdBy);

  it('a row is listed exactly when direct access would be allowed (full cartesian check)', () => {
    let checked = 0;
    for (const roles of roleSets) {
      for (const branchId of ctxBranches) {
        const ctx = ctxOf(roles, { branchId });
        const scope = analysisListScope(ctx);
        for (const t of targets) {
          const allowed = decideAnalysisAccess(ctx, t) === 'ALLOW';
          expect(scope !== null && matches(scope, t), `${roles.join('+') || 'no-role'} branch=${branchId} target=${JSON.stringify(t)}`).toBe(allowed);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(roleSets.length * ctxBranches.length * targets.length);
  });

  it('returns the expected filters', () => {
    expect(analysisListScope(ctxOf(['ADMIN']))).toEqual({ orgId: 'org-1' });
    expect(analysisListScope(ctxOf(['APPROVER'], { branchId: null }))).toEqual({ orgId: 'org-1' });
    expect(analysisListScope(ctxOf(['BRANCH_MANAGER']))).toEqual({ orgId: 'org-1', branchId: 'br-1' });
    expect(analysisListScope(ctxOf(['OFFICER']))).toEqual({ orgId: 'org-1', branchId: 'br-1', createdBy: 'u-me' });
    expect(analysisListScope(ctxOf(['OFFICER', 'BRANCH_MANAGER']))).toEqual({ orgId: 'org-1', branchId: 'br-1' });
    expect(analysisListScope(ctxOf(['OFFICER'], { branchId: null }))).toBeNull();
    expect(analysisListScope(ctxOf([]))).toBeNull();
  });
});
