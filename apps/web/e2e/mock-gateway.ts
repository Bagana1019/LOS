import type { Page, Route } from '@playwright/test';
import { menuFor, permissionsFor, type AuthResponse, type NotificationFeed, type UserRole } from '@los/contracts';

export const PASSWORD = 'correct horse';

export function authResponse(role: UserRole = 'OFFICER', username = 'officer.a'): AuthResponse {
  return {
    accessToken: `token-${username}`,
    expiresIn: 900,
    user: { id: `id-${username}`, orgId: 'org', branchId: 'branch', username, fullName: `${username} Бат`, roles: [role] },
    permissions: permissionsFor([role]),
    menu: menuFor([role]),
  };
}

export interface Gateway {
  /** Cookie `los_rt`-ийг дууриана: true бол /auth/refresh амжилттай. */
  signedIn: boolean;
  role: UserRole;
  /** `null` = endpoint байхгүй (404, M13 хүртэл). */
  notifications: NotificationFeed | null;
  /** /auth/refresh сүлжээний алдаа өгөх (gateway унасан). */
  down: boolean;
  /** Access token хүчингүй болсон: хамгаалагдсан endpoint бүр 401 (бодит gateway-н SESSION_ENDED). */
  rejectAccess: boolean;
  requests: string[];
}

const cors = (route: Route) => ({
  'access-control-allow-origin': route.request().headers().origin ?? '*',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'authorization,content-type,x-correlation-id',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
});

/** Gateway-г Playwright-ийн route-аар дуурайна (CORS-той, бодит хэлбэр — `@los/contracts`-аас). */
export async function mockGateway(page: Page, init: Partial<Gateway> = {}): Promise<Gateway> {
  const gw: Gateway = { signedIn: false, role: 'OFFICER', notifications: null, down: false, rejectAccess: false, requests: [], ...init };
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^\/api/, '');
      const headers = cors(route);
      const reply = (status: number, body?: unknown) =>
        route.fulfill({ status, headers, ...(body === undefined ? {} : { contentType: 'application/json', body: JSON.stringify(body) }) });
      if (req.method() === 'OPTIONS') return reply(204);
      gw.requests.push(`${req.method()} ${path}`);

      // Бодит gateway-н JwtAuthGuard: /auth/{login,refresh,logout}-оос бусад бүгд bearer token шаардана
      const open = path === '/auth/login' || path === '/auth/refresh' || path === '/auth/logout';
      if (!open && (gw.rejectAccess || !(req.headers().authorization ?? '').startsWith('Bearer token-'))) {
        return reply(401, { code: 'SESSION_ENDED', message: 'Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү' });
      }

      if (path === '/auth/refresh') {
        if (gw.down) return route.abort('failed');
        return gw.signedIn ? reply(200, authResponse(gw.role)) : reply(401, { code: 'INVALID_REFRESH_TOKEN', message: 'Дахин нэвтэрнэ үү' });
      }
      if (path === '/auth/login') {
        const body = req.postDataJSON() as { username: string; password: string };
        if (body.username === 'throttled') return reply(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
        if (body.password !== PASSWORD) return reply(401, { code: 'INVALID_CREDENTIALS', message: 'Нэвтрэх нэр эсвэл нууц үг буруу' });
        gw.signedIn = true;
        return reply(200, authResponse(gw.role, body.username));
      }
      if (path === '/auth/logout') {
        gw.signedIn = false;
        return reply(204);
      }
      if (path === '/auth/me') {
        const { accessToken: _t, expiresIn: _e, ...me } = authResponse(gw.role);
        return reply(200, me);
      }
      if (path === '/origination/notifications') return gw.notifications ? reply(200, gw.notifications) : reply(404, { code: 'NOT_FOUND', message: 'Not Found' });
      return reply(404, { code: 'NOT_FOUND', message: 'Not Found' });
    },
  );
  return gw;
}
