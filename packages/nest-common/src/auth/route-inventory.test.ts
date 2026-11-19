import 'reflect-metadata';
import { type CanActivate, Controller, Delete, Get, Module, Post, Put, SetMetadata, UseGuards, forwardRef } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { AllowCustomerContext, Permissions, Public, Roles } from './guards';
import { type GatewayPolicy, type RouteInfo, collectRoutes, findPolicyDrift, findPublicRoutes, findUndeclaredRoutes, routeKey } from './route-inventory';

class CustomGuard implements CanActivate { canActivate() { return true; } }

@Controller('settings')
@Permissions('settings:manage')
class SettingsController {
  @Get() list() { return []; }
  @Put(':key') update() { return {}; }
  @Get('public') @Public() open() { return {}; }
}

@Controller('applications')
class ApplicationsController {
  @Get() list() { return []; }
  @Post() @Roles('OFFICER') create() { return {}; }
  @Delete(':id') @UseGuards(CustomGuard) remove() { return {}; }
  @Get(':id/portal') @AllowCustomerContext() @Permissions('application:read') portal() { return {}; }
  helper() { return 'not a route'; }
}

@Controller()
class RootController { @Get(['ping', 'pong']) ping() { return 'ok'; } }

@Module({ controllers: [ApplicationsController] })
class ApplicationsModule {}
@Module({ imports: [forwardRef(() => ApplicationsModule)] })
class CircularModule {}
@Module({})
class DynamicHost {}
@Module({ imports: [CircularModule, { module: DynamicHost, controllers: [SettingsController] }, ApplicationsModule], controllers: [RootController] })
class AppModule {}

let routes: RouteInfo[] = [];
beforeAll(async () => { routes = await collectRoutes(AppModule); });
const byKey = (key: string): RouteInfo => {
  const r = routes.find((x) => routeKey(x) === key);
  if (!r) throw new Error(`route not found: ${key}`);
  return r;
};

describe('collectRoutes', () => {
  it('walks static imports, dynamic modules and forwardRef exactly once', () => {
    expect(routes.map(routeKey)).toEqual([
      'DELETE /api/applications/:id',
      'GET /api/applications',
      'GET /api/applications/:id/portal',
      'GET /api/ping',
      'GET /api/pong',
      'GET /api/settings',
      'GET /api/settings/public',
      'POST /api/applications',
      'PUT /api/settings/:key',
    ]);
  });

  it('applies class-level decorators and lets handler-level metadata override', () => {
    expect(byKey('PUT /api/settings/:key').permissions).toEqual(['settings:manage']);
    expect(byKey('GET /api/settings/public').isPublic).toBe(true);
  });

  it('records roles, custom guards, customer context and handler names', () => {
    expect(byKey('POST /api/applications').roles).toEqual(['OFFICER']);
    expect(byKey('DELETE /api/applications/:id').guards).toEqual(['CustomGuard']);
    expect(byKey('GET /api/applications/:id/portal')).toMatchObject({ customerContext: true, handler: 'ApplicationsController.portal' });
  });

  it('returns no routes for a module without controllers', async () => {
    expect(await collectRoutes(DynamicHost)).toEqual([]);
  });

  it('includes handlers inherited from a base controller', async () => {
    class BaseCtrl { @Get('health') health() { return 'ok'; } }
    @Controller('child')
    class ChildCtrl extends BaseCtrl { @Post() @Roles('ADMIN') create() { return {}; } }
    @Module({ controllers: [ChildCtrl] })
    class ChildModule {}
    expect((await collectRoutes(ChildModule)).map(routeKey)).toEqual(['GET /api/child/health', 'POST /api/child']);
  });

  it('awaits async (Promise) imports such as ConfigModule.forRoot() instead of silently skipping them', async () => {
    @Module({ imports: [Promise.resolve({ module: DynamicHost, controllers: [SettingsController] }) as never] })
    class AsyncHost {}
    expect((await collectRoutes(AsyncHost)).map(routeKey)).toEqual(['GET /api/settings', 'GET /api/settings/public', 'PUT /api/settings/:key']);
  });
});

describe('findUndeclaredRoutes', () => {
  it('lists routes without Public/Roles/Permissions; a bare @UseGuards does not count as declared', () => {
    expect(findUndeclaredRoutes(routes).map(routeKey)).toEqual(['DELETE /api/applications/:id', 'GET /api/applications', 'GET /api/ping', 'GET /api/pong']);
  });

  it('findPublicRoutes lists exactly the @Public routes', () => {
    expect(findPublicRoutes(routes).map(routeKey)).toEqual(['GET /api/settings/public']);
  });

  it('returns empty for an empty inventory', () => {
    expect(findUndeclaredRoutes([])).toEqual([]);
  });
});

describe('findPolicyDrift', () => {
  const policy = (p: Partial<GatewayPolicy> & Pick<GatewayPolicy, 'prefix' | 'permission'>): GatewayPolicy => ({ service: 'svc', ...p });

  it('passes when every matching route enforces the permission', () => {
    expect(findPolicyDrift('svc', routes, [policy({ prefix: '/api/svc/settings', writeOnly: true, permission: 'settings:manage' })])).toEqual([]);
  });

  it('flags a @Public route under a policy prefix (Public bypasses the service guard entirely)', () => {
    const drift = findPolicyDrift('svc', routes, [policy({ prefix: '/api/svc/settings', permission: 'settings:manage' })]);
    expect(drift.map((d) => d.route && routeKey(d.route))).toEqual(['GET /api/settings/public']);
  });

  it('flags matching routes that do not enforce the gateway permission', () => {
    const drift = findPolicyDrift('svc', routes, [policy({ prefix: '/api/svc/applications', permission: 'application:write' })]);
    expect(drift.map((d) => [d.reason, d.route && routeKey(d.route)])).toEqual([
      ['SERVICE_DOES_NOT_ENFORCE', 'DELETE /api/applications/:id'],
      ['SERVICE_DOES_NOT_ENFORCE', 'GET /api/applications'],
      ['SERVICE_DOES_NOT_ENFORCE', 'GET /api/applications/:id/portal'],
    ]);
  });

  it('accepts @Roles only when every listed role holds the permission', () => {
    const write = findPolicyDrift('svc', routes, [policy({ prefix: '/api/svc/applications', writeOnly: true, permission: 'application:write' })]);
    expect(write.map((d) => d.route && routeKey(d.route))).toEqual(['DELETE /api/applications/:id']);
    const manage = findPolicyDrift('svc', routes, [policy({ prefix: '/api/svc/applications', writeOnly: true, permission: 'settings:manage' })]);
    expect(manage.map((d) => d.route && routeKey(d.route))).toEqual(['DELETE /api/applications/:id', 'POST /api/applications']);
  });

  it('merges module-local role keys so custom-guard routes are checked by role, not trusted blindly', async () => {
    const LocalRoles = (...r: string[]) => SetMetadata('mod:roles', r);
    @Controller('aml')
    class AmlController {
      @Get('hits') @UseGuards(CustomGuard) @LocalRoles('COMPLIANCE') hits() { return []; }
      @Post('hits/:id/review') @UseGuards(CustomGuard) @LocalRoles('ADMIN', 'COMPLIANCE') review() { return {}; }
    }
    @Module({ controllers: [AmlController] })
    class AmlModule {}
    const amlPolicy = [policy({ prefix: '/api/svc/aml/hits', permission: 'aml:review' })];

    const withoutKey = await collectRoutes(AmlModule);
    expect(withoutKey.every((r) => r.roles.length === 0)).toBe(true);
    expect(findPolicyDrift('svc', withoutKey, amlPolicy)).toHaveLength(2);

    const withKey = await collectRoutes(AmlModule, ['mod:roles']);
    expect(withKey.map((r) => r.roles)).toEqual([['COMPLIANCE'], ['ADMIN', 'COMPLIANCE']]);
    expect(findPolicyDrift('svc', withKey, amlPolicy).map((d) => d.route && routeKey(d.route))).toEqual(['POST /api/aml/hits/:id/review']);
  });

  it('does not count a module-local role key on a route without any guard (nothing reads that metadata)', async () => {
    const LocalRoles = (...r: string[]) => SetMetadata('mod:roles', r);
    @Controller('unguarded')
    class UnguardedController { @Post() @LocalRoles('COMPLIANCE') act() { return {}; } }
    @Module({ controllers: [UnguardedController] })
    class UnguardedModule {}
    const [route] = await collectRoutes(UnguardedModule, ['mod:roles']);
    expect(route.roles).toEqual([]);
    expect(findUndeclaredRoutes([route]).map(routeKey)).toEqual(['POST /api/unguarded']);
    expect(findPolicyDrift('svc', [route], [policy({ prefix: '/api/svc/unguarded', permission: 'aml:review' })])).toHaveLength(1);
  });

  it('ignores routes the gateway never proxies (internal-only prefixes of this service only)', () => {
    const p = [policy({ prefix: '/api/svc/applications', permission: 'settings:manage' })];
    const keys = (internal: string[]) => findPolicyDrift('svc', routes, p, internal).map((d) => d.route && routeKey(d.route));
    expect(keys([])).toEqual(['DELETE /api/applications/:id', 'GET /api/applications', 'GET /api/applications/:id/portal', 'POST /api/applications']);
    expect(keys(['/api/svc/applications/:id/portal', '/api/other/applications'])).toEqual(['DELETE /api/applications/:id', 'GET /api/applications', 'POST /api/applications']);
    expect(findPolicyDrift('svc', routes, p, ['/api/svc/applications']).map((d) => d.reason)).toEqual(['NO_MATCHING_ROUTE']);
  });

  it('reports a stale policy whose prefix matches no route, and does not match partial segments', () => {
    const drift = findPolicyDrift('svc', routes, [policy({ prefix: '/api/svc/setting', permission: 'settings:manage' })]);
    expect(drift).toEqual([{ policy: expect.objectContaining({ prefix: '/api/svc/setting' }), reason: 'NO_MATCHING_ROUTE' }]);
  });

  it('matches case-insensitively and ignores policies of other services', () => {
    expect(findPolicyDrift('svc', routes, [policy({ prefix: '/API/SVC/Settings', writeOnly: true, permission: 'settings:manage' })])).toEqual([]);
    expect(findPolicyDrift('svc', routes, [{ service: 'other', prefix: '/api/other/x', permission: 'audit:read' }])).toEqual([]);
  });
});
