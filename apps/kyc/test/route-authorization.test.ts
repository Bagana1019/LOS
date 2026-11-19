// NFR-3 · RBAC хамгаалалт (audit phase-3): (1) gateway route-policy ↔ сервисийн эрхийн шалгалтын зөрүү,
// (2) эрхийн тэмдэглэгээгүй маршрут. Decorator metadata-аас уншина — DB/Redis шаардахгүй.
import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { type RouteInfo, collectRoutes, findPolicyDrift, findPublicRoutes, findUndeclaredRoutes, routeKey } from '@los/nest-common';
import { INTERNAL_ONLY_PREFIXES, ROUTE_POLICIES } from '../../gateway/src/modules/proxy/route-policy';
import { AppModule } from '../src/app.module';

const SERVICE = 'kyc';
/** Өөрийн guard + `@Roles` decorator-той модулиудын metadata түлхүүр. */
const MODULE_ROLE_KEYS: readonly string[] = ['aml:roles'];

/** Баримтжуулсан зөрүү (DECISIONS-ийн ID-тай). Шинэ зөрүү гарах, эсвэл шийдэгдээд алга болох үед тест унана. */
const KNOWN_DRIFT: readonly string[] = [
  // P4C-1 / Q-137: gateway — зөвхөн COMPLIANCE (aml:review); kyc AmlAccessGuard — ADMIN, APPROVER, COMPLIANCE (docs/05 §7 гэрээ)
  'SERVICE_DOES_NOT_ENFORCE aml:review GET /api/aml/hits',
  'SERVICE_DOES_NOT_ENFORCE aml:review POST /api/aml/hits/:id/review',
];

/** "Нэвтэрсэн ажилтан бол хэн ч" — өгөгдлийн хүрээг сервис өөрөө шалгадаг, хянагдсан маршрутууд. Шинэ мөр нэмэх = security review. */
const AUTHENTICATED_ONLY: readonly string[] = [
  // AML скрининг: AmlAccessGuard @Roles-гүй үед fail-open — docs/05-compliance-aml.md "дурын нэвтэрсэн" гэрээ
  'GET /api/aml/customers/:customerId/latest',
  'GET /api/aml/screenings/:id',
  'POST /api/aml/screen',
];

/** `@Public` — ContextAuthGuard (internal token, дүр) бүрэн алгасагдана. Шинэ мөр нэмэх = security review. */
const PUBLIC: readonly string[] = [
  // liveness/readiness — k8s probe, өгөгдөлгүй
  'GET /api/health',
  'GET /api/health/ready',
];

let routes: RouteInfo[] = [];
beforeAll(async () => { routes = await collectRoutes(AppModule, MODULE_ROLE_KEYS); });

describe(`${SERVICE} route authorization`, () => {
  it('discovers the service routes from AppModule', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('enforces every gateway route-policy permission inside the service as well', () => {
    const drift = findPolicyDrift(SERVICE, routes, ROUTE_POLICIES, INTERNAL_ONLY_PREFIXES)
      .map((d) => `${d.reason} ${d.policy.permission} ${d.route ? routeKey(d.route) : d.policy.prefix}`);
    expect(drift).toEqual(KNOWN_DRIFT);
  });

  it('declares authorization on every route, except reviewed authenticated-only routes', () => {
    expect(findUndeclaredRoutes(routes).map(routeKey).sort()).toEqual([...AUTHENTICATED_ONLY].sort());
  });

  it('lists every @Public route explicitly (Public skips the internal-token and role checks)', () => {
    expect(findPublicRoutes(routes).map(routeKey).sort()).toEqual([...PUBLIC].sort());
  });
});
