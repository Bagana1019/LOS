// CLAUDE.md §3.2(9): авторизаци gateway-д шийдэгдэнэ; scoring нь X-User-Id, X-Roles, X-Branch-Id, X-Org-Id, X-Correlation-Id толгойд итгэнэ.
// Энд: толгой → RequestContext (parseRequestContext), Nest glue (@Ctx(), RequestContextGuard), доменийн хандалтын шалгалт (салбар/ЗЭЗ).
// Зөвхөн ID, үүрэг энд орно — PII үгүй. Хэрэглэгчид харагдах мессеж монгол.
import { UserRole } from '@los/contracts';
import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EnvConfigError, envString, splitList, type EnvLike } from './env';
import type { RequestContext } from './infra.ports';

/** X-Org-Id болон env DEFAULT_ORG_ID хоёулаа байхгүй үед (нэг байгууллагатай суурилуулалт) */
export const FALLBACK_ORG_ID = 'org-default';

export const REQUEST_CONTEXT_MESSAGES = {
  missingUser: 'Хэрэглэгч тодорхойлогдоогүй байна: X-User-Id толгой байхгүй эсвэл буруу байна.',
  noRoles: 'Хэрэглэгчид үүрэг оноогдоогүй байна (X-Roles хоосон).',
  unknownRole: 'Хэрэглэгчийн үүрэг тодорхойгүй байна (X-Roles буруу утгатай).',
  badScope: 'Байгууллага эсвэл салбарын толгой буруу байна (X-Org-Id / X-Branch-Id).',
  forbidden: 'Энэ шинжилгээнд хандах эрхгүй байна.',
  analysisNotFound: 'Хуулгын шинжилгээ олдсонгүй.',
} as const;

/** Node `IncomingHttpHeaders` (жижиг үсэг) ба гараар бичсэн тестийн объект (X-User-Id) хоёуланг дэмжинэ */
export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface ParseRequestContextOptions {
  /** Тестэд тогтмол correlation id. Анхдагч: crypto.randomUUID */
  generateCorrelationId?: () => string;
}

/** gateway-ийн id-ууд (uuid, тоон id, `user:42`, и-мэйл хэлбэр). Control тэмдэгт/хоосон зай/кирилл татгалзана (log, header injection) */
const ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

type HeaderValue = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'value'; value: string };

function readHeader(headers: Record<string, string | readonly string[] | undefined>, name: string): HeaderValue {
  const raw = headers[name];
  if (raw === undefined) return { kind: 'absent' };
  if (typeof raw !== 'string' && raw.length !== 1) return { kind: 'invalid' }; // давхар толгой — тодорхойгүй
  const value = (typeof raw === 'string' ? raw : raw[0]).trim();
  return value === '' ? { kind: 'absent' } : { kind: 'value', value };
}

/**
 * Толгойноос RequestContext үүсгэнэ. Алдаа нь Nest HttpException:
 *  - 401: X-User-Id байхгүй/буруу · 403: X-Roles хоосон/үл мэдэгдэх үүрэгтэй, X-Org-Id/X-Branch-Id буруу.
 * X-Correlation-Id байхгүй/буруу бол шинээр үүсгэнэ (буруу утгыг логт хуулахгүй).
 */
export function parseRequestContext(
  headers: HeaderBag,
  env: EnvLike = process.env,
  options: ParseRequestContextOptions = {},
): RequestContext {
  const h: Record<string, string | readonly string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers ?? {})) h[k.toLowerCase()] = v;

  const user = readHeader(h, 'x-user-id');
  if (user.kind !== 'value' || !ID_RE.test(user.value)) throw new UnauthorizedException(REQUEST_CONTEXT_MESSAGES.missingUser);

  const rolesHeader = h['x-roles'];
  const roles = parseRoles(Array.isArray(rolesHeader) ? rolesHeader.join(',') : (rolesHeader as string | undefined) ?? '');

  const org = readHeader(h, 'x-org-id');
  const orgId = org.kind === 'value' ? org.value : (envString(env, 'DEFAULT_ORG_ID') ?? FALLBACK_ORG_ID);
  if (isBadScope(org)) throw new ForbiddenException(REQUEST_CONTEXT_MESSAGES.badScope);
  if (!ID_RE.test(orgId)) throw new EnvConfigError('DEFAULT_ORG_ID', 'must match [A-Za-z0-9_.:@-]{1,128}');

  const branch = readHeader(h, 'x-branch-id');
  if (isBadScope(branch)) throw new ForbiddenException(REQUEST_CONTEXT_MESSAGES.badScope);

  const corr = readHeader(h, 'x-correlation-id');
  const correlationId = corr.kind === 'value' && ID_RE.test(corr.value) ? corr.value : (options.generateCorrelationId ?? randomUUID)();

  return { orgId, userId: user.value, roles, branchId: branch.kind === 'value' ? branch.value : null, correlationId };
}

const isBadScope = (h: HeaderValue): boolean => h.kind === 'invalid' || (h.kind === 'value' && !ID_RE.test(h.value));

function parseRoles(raw: string): UserRole[] {
  const names = [...new Set(splitList(raw))];
  if (names.length === 0) throw new ForbiddenException(REQUEST_CONTEXT_MESSAGES.noRoles);
  const known = new Set<string>(UserRole);
  if (names.some((n) => !known.has(n))) throw new ForbiddenException(REQUEST_CONTEXT_MESSAGES.unknownRole);
  return names as UserRole[];
}

// ───────────────────────── Nest glue ─────────────────────────

interface HttpRequestLike {
  headers: HeaderBag;
}
const resolved = new WeakMap<object, RequestContext>();

/** Хүсэлт тутамд нэг л удаа parse хийнэ (guard + @Ctx() хоёр дуудахад ижил correlationId хадгална). Энд process.env уншина */
export function resolveRequestContext(req: HttpRequestLike): RequestContext {
  let ctx = resolved.get(req);
  if (!ctx) {
    ctx = parseRequestContext(req.headers, process.env);
    resolved.set(req, ctx);
  }
  return ctx;
}

/** Controller-ийн параметр: `@Ctx() ctx: RequestContext`. Толгой буруу бол 401/403 шидэнэ */
export const Ctx = createParamDecorator(
  (_data: unknown, host: ExecutionContext): RequestContext => resolveRequestContext(host.switchToHttp().getRequest<HttpRequestLike>()),
);

/** Handler ажиллахаас өмнө 401/403-ыг гаргана (`@UseGuards(RequestContextGuard)`); дараа нь @Ctx() cache-ээс авна */
@Injectable()
export class RequestContextGuard implements CanActivate {
  canActivate(host: ExecutionContext): boolean {
    resolveRequestContext(host.switchToHttp().getRequest<HttpRequestLike>());
    return true;
  }
}

// ───────────────────────── Хандалтын шалгалт ─────────────────────────

/** bsa_analysis-ийн хандалтад хамаарах талбарууд (BsaAnalysisRecord-д таарна) */
export interface AnalysisAccessTarget {
  orgId: string;
  branchId: string | null;
  createdBy: string | null;
}

/** NOT_FOUND = өөр байгууллагын шинжилгээ: оршихыг ил гаргахгүйн тулд «олдсонгүй» шиг харагдана */
export type AccessDecision = 'ALLOW' | 'FORBIDDEN' | 'NOT_FOUND';

const hasRole = (ctx: RequestContext, role: UserRole): boolean => ctx.roles.includes(role);
const isSameBranch = (ctx: RequestContext, branchId: string | null): boolean =>
  ctx.branchId !== null && branchId !== null && ctx.branchId === branchId;

/**
 * docs/01 §3 «Харах хүрээ»:
 *  - өөр байгууллага → ҮРГЭЛЖ NOT_FOUND (ямар ч үүрэг) · ADMIN, APPROVER → байгууллагын бүх салбар
 *  - BRANCH_MANAGER → өөрийн салбар · OFFICER → өөрийн салбар БА өөрөө үүсгэсэн (createdBy === userId)
 * Олон үүрэгтэй бол хамгийн өргөн нь. Салбар/үүсгэгч null бол таарахгүй (null === null гэж тооцохгүй).
 */
export function decideAnalysisAccess(ctx: RequestContext, target: AnalysisAccessTarget): AccessDecision {
  if (target.orgId !== ctx.orgId) return 'NOT_FOUND';
  if (hasRole(ctx, 'ADMIN') || hasRole(ctx, 'APPROVER')) return 'ALLOW';
  if (hasRole(ctx, 'BRANCH_MANAGER') && isSameBranch(ctx, target.branchId)) return 'ALLOW';
  const createdByMe = target.createdBy !== null && target.createdBy === ctx.userId;
  if (hasRole(ctx, 'OFFICER') && isSameBranch(ctx, target.branchId) && createdByMe) return 'ALLOW';
  return 'FORBIDDEN';
}

/** Олдсонгүй: бодит «байхгүй» болон «өөр байгууллагынх» хоёрт ИЖИЛ хариу (оршихыг задруулахгүй) */
export const analysisNotFound = (): NotFoundException => new NotFoundException(REQUEST_CONTEXT_MESSAGES.analysisNotFound);

/** Pipeline-ийн нэгдсэн шалгалт: ALLOW бол юу ч үгүй; өөр байгууллага → NotFoundException; бусад → ForbiddenException */
export function assertCanAccessAnalysis(ctx: RequestContext, target: AnalysisAccessTarget): void {
  const decision = decideAnalysisAccess(ctx, target);
  if (decision === 'NOT_FOUND') throw analysisNotFound();
  if (decision === 'FORBIDDEN') throw new ForbiddenException(REQUEST_CONTEXT_MESSAGES.forbidden);
}

/** Жагсаалтын шүүлт (BsaAnalysisFilter-д шууд тавина). null = ямар ч шинжилгээ харах эрхгүй. `decideAnalysisAccess`-тэй ижил дүрэм */
export interface AnalysisListScope {
  orgId: string;
  branchId?: string;
  createdBy?: string;
}
export function analysisListScope(ctx: RequestContext): AnalysisListScope | null {
  if (hasRole(ctx, 'ADMIN') || hasRole(ctx, 'APPROVER')) return { orgId: ctx.orgId };
  if (ctx.branchId === null) return null;
  if (hasRole(ctx, 'BRANCH_MANAGER')) return { orgId: ctx.orgId, branchId: ctx.branchId };
  if (hasRole(ctx, 'OFFICER')) return { orgId: ctx.orgId, branchId: ctx.branchId, createdBy: ctx.userId };
  return null;
}
