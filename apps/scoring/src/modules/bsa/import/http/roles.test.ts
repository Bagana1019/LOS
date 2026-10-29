// RolesGuard: deny-by-default. Мөн БҮХ controller-ийн БҮХ маршрут үүрэгтэй, guard-тай эсэх + үүргийн хүснэгт README-тэй тулгана (шинэ маршрут
// нэмэхдээ эрхээ мартвал энэ тест унана).
import 'reflect-metadata';
import { ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { BsaAdminController } from './admin.controller';
import { BsaAnalysesController } from './analyses.controller';
import { BsaCatalogController } from './catalog.controller';
import { BsaJobsController } from './jobs.controller';
import { ADMIN_ONLY, READ_ROLES, ROLES_KEY, Roles, RolesGuard, WRITE_ONLY_ROLES } from './roles';

const CONTROLLERS = [BsaAnalysesController, BsaJobsController, BsaCatalogController, BsaAdminController] as const;
const ALL = [...READ_ROLES].sort().join(',');
const WRITE = [...WRITE_ONLY_ROLES].sort().join(',');
const ADMIN = 'ADMIN';

/** "METHOD /api-less path" -> зөвшөөрөгдсөн үүргүүд (README «Маршрут ба үүргийн хүснэгт»-тэй ижил) */
const EXPECTED: Readonly<Record<string, string>> = {
  'POST bsa/analyses': WRITE,
  'GET bsa/analyses': ALL,
  'GET bsa/analyses/:id': ALL,
  'DELETE bsa/analyses/:id': WRITE,
  'GET bsa/analyses/:id/history': ALL,
  'POST bsa/analyses/:id/imports': WRITE,
  'GET bsa/analyses/:id/imports': ALL,
  'POST bsa/analyses/:id/recalculate': WRITE,
  'GET bsa/analyses/:id/transactions': ALL,
  'GET bsa/analyses/:id/breakdown': ALL,
  'POST bsa/analyses/:id/reclassify': WRITE,
  'POST bsa/analyses/:id/finalize': WRITE,
  'GET bsa/analyses/:id/summary': ALL,
  'GET bsa/analyses/:id/scoring-input': ALL,
  'GET bsa/jobs': ALL,
  'GET bsa/jobs/:id': ALL,
  'POST bsa/jobs/:id/retry': WRITE,
  'GET bsa/categories': ALL,
  'GET bsa/rules': ADMIN,
  'POST bsa/rules': ADMIN,
  'POST bsa/admin/retention/run': ADMIN,
};

function routes() {
  const found: Array<{ key: string; handler: (...args: never[]) => unknown; controller: (typeof CONTROLLERS)[number] }> = [];
  for (const controller of CONTROLLERS) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller));
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as unknown as Record<string, (...args: never[]) => unknown>)[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = String(Reflect.getMetadata(PATH_METADATA, handler));
      found.push({ key: `${RequestMethod[method]} ${[base, sub === '/' ? '' : sub].filter(Boolean).join('/')}`, handler, controller });
    }
  }
  return found;
}

describe('route inventory', () => {
  it('every handler has an explicit @Roles and the table matches the documented one', () => {
    const actual = Object.fromEntries(
      routes().map(({ key, handler, controller }) => {
        const roles = (Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller)) as string[] | undefined;
        return [key, roles ? [...roles].sort().join(',') : '(none)'];
      }),
    );
    expect(actual).toEqual(EXPECTED);
  });

  it('every controller runs RequestContextGuard then RolesGuard', () => {
    for (const controller of CONTROLLERS) {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) as Array<{ name: string }>).map((g) => g.name);
      expect(guards, controller.name).toEqual(['RequestContextGuard', 'RolesGuard']);
    }
  });

  it('APPROVER can only call read routes and only ADMIN can call admin routes', () => {
    for (const [route, roles] of Object.entries(EXPECTED)) {
      const list = roles.split(',');
      if (list.includes('APPROVER')) expect(route.startsWith('GET '), route).toBe(true);
      if (roles === ADMIN) expect(/rules|retention/.test(route), route).toBe(true);
      expect(list.includes('ADMIN'), route).toBe(true); // ADMIN бүх маршрутыг дуудна
    }
  });
});

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  function context(roles: string | undefined, handlerRoles?: readonly string[], classRoles?: readonly string[]): ExecutionContext {
    class Target {
      handle(): void {}
    }
    if (handlerRoles) Roles(...(handlerRoles as never[]))(Target.prototype, 'handle', Object.getOwnPropertyDescriptor(Target.prototype, 'handle')!);
    if (classRoles) Roles(...(classRoles as never[]))(Target);
    const headers: Record<string, string> = { 'x-user-id': 'u1' };
    if (roles !== undefined) headers['x-roles'] = roles;
    return {
      getHandler: () => Target.prototype.handle,
      getClass: () => Target,
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
  }

  it('denies by default when a handler has no @Roles', () => {
    expect(() => guard.canActivate(context('ADMIN'))).toThrowError(ForbiddenException);
    expect(() => guard.canActivate(context('ADMIN', []))).toThrowError(ForbiddenException);
  });

  it('allows a listed role (also when the user has several) and denies the others', () => {
    expect(guard.canActivate(context('OFFICER', ['OFFICER', 'ADMIN']))).toBe(true);
    expect(guard.canActivate(context('APPROVER,OFFICER', ['OFFICER']))).toBe(true);
    expect(() => guard.canActivate(context('APPROVER', ['OFFICER', 'ADMIN']))).toThrowError(ForbiddenException);
    expect(() => guard.canActivate(context('BRANCH_MANAGER', [...ADMIN_ONLY]))).toThrowError(ForbiddenException);
  });

  it('a handler-level @Roles overrides the class-level one', () => {
    expect(guard.canActivate(context('ADMIN', ['ADMIN'], ['OFFICER']))).toBe(true);
    expect(() => guard.canActivate(context('OFFICER', ['ADMIN'], ['OFFICER']))).toThrowError(ForbiddenException);
    expect(guard.canActivate(context('OFFICER', undefined, ['OFFICER']))).toBe(true);
  });

  it('rejects invalid identity headers with the request-context error', () => {
    expect(() => guard.canActivate(context(undefined, ['ADMIN']))).toThrowError(ForbiddenException);
    expect(() => guard.canActivate(context('NOT_A_ROLE', ['ADMIN']))).toThrowError(ForbiddenException);
  });
});
