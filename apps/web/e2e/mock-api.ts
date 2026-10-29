import type { Page, Route } from '@playwright/test';
import { MerchantErrorBody, type MerchantErrorCode, type UserRole } from '@los/contracts';
import { mockGateway } from './mock-gateway';

// e2e: gateway-ийн БҮХ дуудлагыг `page.route`-аар тосож fixture буцаана (backend шаардлагагүй).
// Бүх хуудас нэвтрэлтийн хаалгатай (AppShell) тул `install` нь `/auth/*`-ийг (mock-gateway.ts, authOnly) нэмж, нэвтэрсэн ажилтныг дуурайна.

export interface MockRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
  params: Record<string, string>;
}
export interface MockReply {
  status?: number;
  json?: unknown;
  /** Хариуг удаашруулах (loading төлөв харуулахад). */
  delayMs?: number;
  /** HTTP-ийн оронд сүлжээний алдаа. */
  abort?: boolean;
}
export type MockHandler = (req: MockRequest) => MockReply | Promise<MockReply>;

interface RouteEntry { method: string; keys: string[]; re: RegExp; handler: MockHandler }

const compile = (path: string): { keys: string[]; re: RegExp } => {
  const keys: string[] = [];
  const src = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; });
  return { keys, re: new RegExp(`^${src}$`) };
};

export const apiError = (status: number, code: MerchantErrorCode, details?: Record<string, unknown>): MockReply => ({
  status,
  json: MerchantErrorBody.parse({ code, message: `mock ${code}`, ...(details ? { details } : {}) }),
});

export class MockApi {
  readonly calls: MockRequest[] = [];
  readonly unhandled: string[] = [];
  private readonly routes: RouteEntry[] = [];

  /** `role`: `/auth/me`-ийн дүр. Анхдагч ADMIN — `/settings/*` (settings:manage) хуудсууд хаагдахгүй. */
  constructor(private readonly role: UserRole = 'ADMIN') {}

  /** `path` нь `/api`-аас хойших, жишээ `/merchant-portal/leases/:id`. Сүүлд бүртгэсэн нь түрүүлж таарна. */
  on(method: string, path: string, handler: MockHandler | MockReply): this {
    const { keys, re } = compile(path);
    this.routes.unshift({ method: method.toUpperCase(), keys, re, handler: typeof handler === 'function' ? handler : () => handler });
    return this;
  }
  get(path: string, h: MockHandler | MockReply) { return this.on('GET', path, h); }
  post(path: string, h: MockHandler | MockReply) { return this.on('POST', path, h); }
  patch(path: string, h: MockHandler | MockReply) { return this.on('PATCH', path, h); }

  callsTo(method: string, path: string): MockRequest[] {
    const { re } = compile(path);
    return this.calls.filter((c) => c.method === method.toUpperCase() && re.test(c.path));
  }
  lastCall(method: string, path: string): MockRequest | undefined {
    return this.callsTo(method, path).at(-1);
  }

  async install(page: Page): Promise<void> {
    await mockGateway(page, { signedIn: true, role: this.role, authOnly: true });
    // Ажилтны shell-ийн хонх (FR-13.2) уншаагүй тоог асууна — тест бүрд "mock-гүй дуудлага" болохгүйн тулд анхдагч хариу.
    this.get('/notifications/unread-count', { json: { unreadCount: 0 } });
    await page.route('**/api/**', (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const origin = request.headers()['origin'] ?? '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', vary: 'origin' };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*?\/api(?=\/)/, '').replace(/^\/origination(?=\/)/, ''); // gateway: /api/origination/<зам>
    let body: unknown;
    const raw = request.postData();
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const method = request.method();
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ''); });
      const req: MockRequest = { method, path, search: url.searchParams, body, headers: request.headers(), params };
      this.calls.push(req);
      const reply = await r.handler(req);
      if (reply.delayMs) await new Promise((res) => setTimeout(res, reply.delayMs));
      if (reply.abort) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: reply.status ?? 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(reply.json ?? {}) });
      return;
    }
    if (path.startsWith('/auth/')) {
      await route.fallback(); // mock-gateway.ts (authOnly)
      return;
    }
    this.unhandled.push(`${method} ${path}`);
    await route.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'NOT_FOUND', message: `no mock for ${method} ${path}` }) });
  }
}

/** Консолын алдаа, шийдэгдээгүй promise, React key/hydration анхааруулгыг цуглуулна. Тест төгсгөлд `expect(guard.problems).toEqual([])`. */
export function guardConsole(page: Page): { problems: string[] } {
  const problems: string[] = [];
  // Браузерийн "Failed to load resource" мөр нь зөвхөн mock-оос ирсэн 4xx/5xx/abort хариу (тестийн зориудын алдаа). Mock-гүй дуудлагыг `api.unhandled` барина.
  const ignore = (text: string) => /favicon|Download the React DevTools|\[Fast Refresh\]|webpack-hmr|_next\/static|ERR_FAILED.*\/api\/|Failed to load resource: (the server responded with a status of [45]\d\d|net::ERR_FAILED)/.test(text);
  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = msg.text();
    if (!ignore(text)) problems.push(`[${type}] ${text}`);
  });
  page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}`));
  return { problems };
}
