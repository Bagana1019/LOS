import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createParamDecorator, Inject, Injectable, Optional, type ExecutionContext, type NestMiddleware } from '@nestjs/common';
import { CTX_HEADERS, type RequestContext } from '@los/contracts';

// CLAUDE.md §3.2.9, §3.2.10: gateway-ээс ирсэн X-User-Id / X-Roles / X-Branch-Id / X-Org-Id / X-Correlation-Id толгойд итгэнэ.
type Headers = Record<string, string | string[] | undefined>;
const store = new AsyncLocalStorage<RequestContext>();
const SAFE_CORRELATION = /^[A-Za-z0-9._-]{1,128}$/;

const first = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

export function parseRequestContext(headers: Headers, env: NodeJS.ProcessEnv = process.env): RequestContext {
  const rawCorrelation = first(headers[CTX_HEADERS.correlationId]);
  return {
    userId: first(headers[CTX_HEADERS.userId]),
    roles: [...new Set((first(headers[CTX_HEADERS.roles]) ?? '').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean))],
    branchId: first(headers[CTX_HEADERS.branchId]),
    orgId: first(headers[CTX_HEADERS.orgId]) ?? env.DEFAULT_ORG_ID ?? '',
    customerId: first(headers[CTX_HEADERS.customerId]),
    // лог-д орох тул хэлбэрийг хязгаарлана (log injection)
    correlationId: rawCorrelation && SAFE_CORRELATION.test(rawCorrelation) ? rawCorrelation : randomUUID(),
  };
}

/** Тухайн async хүрээнд ажиллаж буй контекст (HTTP хүсэлт, consumer, job). Байхгүй бол null. */
export const getRequestContext = (): RequestContext | null => store.getStore() ?? null;
export function requireRequestContext(): RequestContext {
  const ctx = store.getStore();
  if (!ctx) throw new Error('No request context: call inside an HTTP request or runWithContext()');
  return ctx;
}
/** Consumer / BullMQ job / seed-д контекст тавьж ажиллуулна (correlationId event-ээс). */
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => store.run(ctx, fn);
export const systemContext = (orgId: string, correlationId: string = randomUUID()): RequestContext => ({ userId: null, roles: [], branchId: null, orgId, customerId: null, correlationId });

interface CtxRequest { headers: Headers; ctx?: RequestContext }
export function contextOf(req: CtxRequest): RequestContext {
  return (req.ctx ??= parseRequestContext(req.headers));
}

/** `@Ctx() ctx: RequestContext` */
export const Ctx = createParamDecorator((_d: unknown, ex: ExecutionContext): RequestContext => contextOf(ex.switchToHttp().getRequest<CtxRequest>()));

export const REQUEST_CONTEXT_OPTIONS = Symbol('REQUEST_CONTEXT_OPTIONS');
export interface RequestContextOptions {
  /** `false` (gateway): клиентээс ирсэн X-User-Id / X-Roles / … толгойг ХҮЛЭЭН АВАХГҮЙ — guard нь JWT-ээс баталгаажуулж өөрөө тавина. */
  trustIdentityHeaders: boolean;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Optional() @Inject(REQUEST_CONTEXT_OPTIONS) private readonly opts?: RequestContextOptions) {}

  use(req: CtxRequest, res: { setHeader(k: string, v: string): void }, next: () => void): void {
    if (this.opts?.trustIdentityHeaders === false) {
      const parsed = parseRequestContext({ [CTX_HEADERS.correlationId]: req.headers[CTX_HEADERS.correlationId] });
      req.ctx = { ...systemContext(process.env.DEFAULT_ORG_ID ?? '', parsed.correlationId) };
    }
    const ctx = contextOf(req);
    res.setHeader(CTX_HEADERS.correlationId, ctx.correlationId);
    store.run(ctx, next);
  }
}
