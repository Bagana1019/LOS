// NFR-3 · RBAC хамгаалалт (audit phase-3): (1) gateway route-policy ↔ сервисийн эрхийн шалгалтын зөрүү,
// (2) эрхийн тэмдэглэгээгүй маршрут. Decorator metadata-аас уншина — DB/Redis шаардахгүй.
import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { type RouteInfo, collectRoutes, findPolicyDrift, findPublicRoutes, findUndeclaredRoutes, routeKey } from '@los/nest-common';
import { INTERNAL_ONLY_PREFIXES, ROUTE_POLICIES } from '../../gateway/src/modules/proxy/route-policy';
import { AppModule } from '../src/app.module';

const SERVICE = 'dms';
/** Өөрийн guard + `@Roles` decorator-той модулиудын metadata түлхүүр. */
const MODULE_ROLE_KEYS: readonly string[] = [];

/** Баримтжуулсан зөрүү (DECISIONS-ийн ID-тай). Шинэ зөрүү гарах, эсвэл шийдэгдээд алга болох үед тест унана. */
const KNOWN_DRIFT: readonly string[] = [];

/** "Нэвтэрсэн ажилтан бол хэн ч" — өгөгдлийн хүрээг сервис өөрөө шалгадаг, хянагдсан маршрутууд. Шинэ мөр нэмэх = security review. */
const AUTHENTICATED_ONLY: readonly string[] = [
  // files: org-оор хязгаарлагдсан (өөр org → 404); контент татах нь зөвхөн `svc:` дотоод хэрэглэгчид (canReadFileContent) — ажилтан origination-оор (хүсэлтийн хүрээ + файлын холбоос)
  'GET /api/files/:id',
  'GET /api/files/:id/content',
  'POST /api/files',
  // ocr: баримтын төрөл/health/extract — нэвтэрсэн ажилтан
  'GET /api/ocr/doc-types',
  'GET /api/ocr/health',
  'POST /api/ocr/extract',
];

/** `@Public` — ContextAuthGuard (internal token, дүр) бүрэн алгасагдана. Шинэ мөр нэмэх = security review. */
const PUBLIC: readonly string[] = [
  // liveness/readiness — k8s probe, өгөгдөлгүй
  'GET /api/health',
  'GET /api/health/ready',
  // FR-11.4 зээлдэгчийн JWT-гүй e-sign: эрх = линкийн bearer токен (service шалгана); webhook-ийг provider adapter гарын үсгээр шалгана
  'GET /api/public/esign/:token',
  'GET /api/public/esign/:token/document',
  'GET /api/public/esign/:token/signed-document',
  'GET /api/public/esign/:token/status',
  'GET /api/public/esign/verify/:code',
  'POST /api/public/esign/:token/decline',
  'POST /api/public/esign/:token/start',
  'POST /api/public/esign/callback/:provider',
  // DEV-only: IntegrationsModule.register() зөвхөн INTEGRATION_MODE=mock && NODE_ENV!=production үед бүртгэнэ (тест env-д харагдана)
  'POST /api/dev/esign/mock/:providerRef/approve',
  'POST /api/dev/esign/mock/:providerRef/decline',
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
