import { randomUUID, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CTX_HEADERS, PortalId, type RequestContext } from '@los/contracts';
import { PortalHttpError } from './portal-errors';

type Headers = Record<string, string | string[] | undefined>;

/** portal-bff → origination (docs/05-portal-bff.md §6). Gateway энэ толгойг тавьдаггүй. */
export const ACTOR_TYPE_HEADER = 'x-actor-type';
const PORTAL_ANONYMOUS_KEY = 'los:portal-anonymous';
/** Зөвхөн нэвтрэхээс өмнөх `POST /customers/lookup`: X-Actor-Type=PORTAL_ANONYMOUS, харилцагчийн ID-гүй. */
export const PortalAnonymous = () => SetMetadata(PORTAL_ANONYMOUS_KEY, true);

const SAFE_CORRELATION = /^[A-Za-z0-9._-]{1,128}$/;

const first = (v: string | string[] | undefined): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const unauthenticated = (code = 'UNAUTHENTICATED') => new PortalHttpError(code, 401, 'Дотоод portal хүсэлт баталгаажсангүй');

/**
 * H8: `/api/internal/portal/*`-ийн цорын ганц эрхийн шалгалт (глобал ContextAuthGuard-ыг `@Public()`-оор алгасна — docs/05 §6:
 * ажилтны guard энд хэрэглэгдэхгүй). Дараалал:
 *  1. `INTERNAL_AUTH_SECRET` тохируулсан бол `X-Internal-Token` таарна; production-д нууцгүй бол хаана (fail closed).
 *  2. Ажилтны контекст (`X-User-Id`, `X-Branch-Id`) — 403. Gateway-ээр дамжсан ажилтны хүсэлт энд хэзээ ч хүрэхгүй.
 *  3. `CUSTOMER`: `X-Customer-Id` (PortalId) + `X-Roles` яг `CUSTOMER`. `PORTAL_ANONYMOUS`: зөвхөн lookup, ID/дүргүй.
 * Буцаах контекст нь ЗӨВХӨН харилцагчийнх (userId=null) — доош дуудагдах service-үүд ажилтны эрхээр ажиллахгүй.
 */
export function authorizePortal(headers: Headers, opts: { anonymous: boolean }, env: NodeJS.ProcessEnv = process.env): RequestContext {
  const secret = env.INTERNAL_AUTH_SECRET?.trim();
  if (secret) {
    const token = first(headers[CTX_HEADERS.internalToken]);
    if (!token || !safeEqual(token, secret)) throw unauthenticated('INVALID_INTERNAL_TOKEN');
  } else if (env.NODE_ENV === 'production') {
    throw unauthenticated('INVALID_INTERNAL_TOKEN');
  }

  if (first(headers[CTX_HEADERS.userId]) || first(headers[CTX_HEADERS.branchId])) {
    throw new PortalHttpError('STAFF_CONTEXT_REFUSED', 403, 'Ажилтны хүсэлт portal-ын дотоод маршрутад хориотой');
  }

  const orgId = first(headers[CTX_HEADERS.orgId]) ?? env.DEFAULT_ORG_ID?.trim() ?? '';
  if (!orgId) throw unauthenticated('MISSING_ORG');
  const rawCorrelation = first(headers[CTX_HEADERS.correlationId]);
  const correlationId = rawCorrelation && SAFE_CORRELATION.test(rawCorrelation) ? rawCorrelation : randomUUID();
  const actor = first(headers[ACTOR_TYPE_HEADER]);
  const customerId = first(headers[CTX_HEADERS.customerId]);
  const rawRoles = headers[CTX_HEADERS.roles];
  const roles = (first(rawRoles) ?? '').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);

  if (opts.anonymous) {
    if (actor !== 'PORTAL_ANONYMOUS' || customerId || roles.length) throw unauthenticated();
    return { userId: null, roles: [], branchId: null, orgId, customerId: null, correlationId };
  }
  if (actor !== 'CUSTOMER' || !customerId || !PortalId.safeParse(customerId).success) throw unauthenticated();
  if (rawRoles === undefined || roles.length !== 1 || roles[0] !== 'CUSTOMER') throw new PortalHttpError('FORBIDDEN', 403, 'Зөвхөн харилцагчийн хүсэлт');
  return { userId: null, roles: ['CUSTOMER'], branchId: null, orgId, customerId, correlationId };
}

@Injectable()
export class PortalInternalGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const anonymous = !!this.reflector.getAllAndOverride<boolean>(PORTAL_ANONYMOUS_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<{ headers: Headers; ctx?: RequestContext }>();
    // `@Ctx()` нь req.ctx-ийг буцаана: middleware-ийн толгойноос задалсан контекстыг баталгаажсанаар дарна.
    req.ctx = authorizePortal(req.headers, { anonymous });
    return true;
  }
}
