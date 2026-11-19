// NFR-3 · RBAC хамгаалалт (audit phase-3): (1) gateway route-policy ↔ сервисийн эрхийн шалгалтын зөрүү,
// (2) эрхийн тэмдэглэгээгүй маршрут. Decorator metadata-аас уншина — DB/Redis шаардахгүй.
import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { type RouteInfo, collectRoutes, findPolicyDrift, findPublicRoutes, findUndeclaredRoutes, routeKey } from '@los/nest-common';
import { INTERNAL_ONLY_PREFIXES, ROUTE_POLICIES } from '../../gateway/src/modules/proxy/route-policy';
import { AppModule } from '../src/app.module';

const SERVICE = 'origination';
/** Өөрийн guard + `@Roles` decorator-той модулиудын metadata түлхүүр. */
const MODULE_ROLE_KEYS: readonly string[] = ['blacklist:roles', 'merchant:roles'];

/** Баримтжуулсан зөрүү (DECISIONS-ийн ID-тай). Шинэ зөрүү гарах, эсвэл шийдэгдээд алга болох үед тест унана. */
const KNOWN_DRIFT: readonly string[] = [];

/** "Нэвтэрсэн ажилтан бол хэн ч" — өгөгдлийн хүрээг сервис өөрөө шалгадаг, хянагдсан маршрутууд. Шинэ мөр нэмэх = security review. */
const AUTHENTICATED_ONLY: readonly string[] = [
  // blacklist унших: BlacklistAccessGuard @Roles-гүй үед дурын нэвтэрсэн ажилтан (бичих нь WRITE_ROLES)
  'GET /api/blacklist',
  'GET /api/blacklist/:id',
  // maker-checker: дүр, салбар, maker≠checker-ийг MakerCheckerService шалгана (MC-BR-*)
  'GET /api/maker-checker/policies',
  'GET /api/maker-checker/requests',
  'GET /api/maker-checker/requests/:id',
  'GET /api/maker-checker/requests/summary',
  'POST /api/maker-checker/requests',
  'POST /api/maker-checker/requests/:id/approve',
  'POST /api/maker-checker/requests/:id/cancel',
  'POST /api/maker-checker/requests/:id/reject',
  // notifications: өөрийн хонх/төхөөрөмж; тохиргоо — өөрөө | ADMIN | хариуцсан ЗЭЗ (PreferenceService)
  'DELETE /api/notifications/push-devices/:token',
  'GET /api/notifications',
  'GET /api/notifications/preferences/:recipientType/:recipientId',
  'GET /api/notifications/unread-count',
  'POST /api/notifications/:id/read',
  'POST /api/notifications/push-devices',
  'POST /api/notifications/read-all',
  'PUT /api/notifications/preferences/:recipientType/:recipientId',
  // payments: хүсэлтийн хүрээ access.load(ctx, applicationId, 'read') (PaymentService); харилцагчийн контекст 403 (H8)
  'GET /api/applications/:applicationId/payments',
  'GET /api/applications/:applicationId/repayment-status',
  'GET /api/payments/invoices/:id',
  'GET /api/payments/providers',
  'POST /api/payments/invoices',
  'POST /api/payments/invoices/:id/cancel',
  // settings: унших нээлттэй, бичих нь settings:manage (gateway writeOnly + сервис)
  'GET /api/settings',
  'GET /api/settings/:key',
];

/** `@Public` — ContextAuthGuard (internal token, дүр) бүрэн алгасагдана. Шинэ мөр нэмэх = security review. */
const PUBLIC: readonly string[] = [
  // liveness/readiness — k8s probe, өгөгдөлгүй
  'GET /api/health',
  'GET /api/health/ready',
  // H8: portal-bff → origination дотоод API. Class-level @UseGuards(PortalInternalGuard) — дотоод токен + CUSTOMER/PORTAL_ANONYMOUS, ажилтан 403;
  // gateway INTERNAL_ONLY_PREFIXES '/api/origination/internal' — ажилтны proxy-д хүрэхгүй
  'GET /api/internal/portal/customers/me',
  'GET /api/internal/portal/loans',
  'GET /api/internal/portal/loans/:loanId',
  'GET /api/internal/portal/loans/:loanId/balance',
  'GET /api/internal/portal/loans/:loanId/contract',
  'GET /api/internal/portal/loans/:loanId/contract/content',
  'GET /api/internal/portal/loans/:loanId/payment-methods',
  'GET /api/internal/portal/loans/:loanId/payments',
  'GET /api/internal/portal/loans/:loanId/schedule',
  'GET /api/internal/portal/payments/:paymentId',
  'POST /api/internal/portal/customers/lookup',
  'POST /api/internal/portal/loans/:loanId/payments',
  'POST /api/internal/portal/otp',
  // Төлбөрийн провайдерийн callback: агуулгад итгэхгүй — зөвхөн invoice дугаараар checkInvoice-ээр провайдераас дахин баталгаажуулна
  'GET /api/payments/callbacks/qpay',
  'POST /api/payments/callbacks/qpay',
  'POST /api/payments/callbacks/socialpay',
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
