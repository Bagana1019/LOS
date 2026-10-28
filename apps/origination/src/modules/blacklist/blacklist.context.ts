import {
  BadRequestException, type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata,
  UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { UserRole } from '@los/contracts';

/** Gateway-ийн дамжуулсан толгойд итгэнэ (CLAUDE.md §3.2.9): X-User-Id, X-Roles, X-Branch-Id, X-Correlation-Id (+ X-Org-Id). */
export interface RequestContext {
  userId: string;
  roles: UserRole[];
  branchId: string | null;
  correlationId: string;
  orgId: string;
}

/** FR-13.1: бичих, импортлох эрх. Унших — нэвтэрсэн дурын дүр. */
export const WRITE_ROLES: UserRole[] = ['ADMIN', 'BRANCH_MANAGER'];

type Headers = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

function readContext(headers: Headers, env: Record<string, string | undefined> = process.env): RequestContext {
  const userId = first(headers['x-user-id']);
  if (!userId) throw new UnauthorizedException('X-User-Id header is required');
  const orgId = first(headers['x-org-id']) ?? env.DEFAULT_ORG_ID;
  if (!orgId) throw new BadRequestException('X-Org-Id header is required (or set DEFAULT_ORG_ID)');
  const known = new Set<string>(UserRole);
  const roles = (first(headers['x-roles']) ?? '').split(',').map((r) => r.trim().toUpperCase()).filter((r): r is UserRole => known.has(r));
  return { userId, roles, branchId: first(headers['x-branch-id']) ?? null, correlationId: first(headers['x-correlation-id']) ?? randomUUID(), orgId };
}

const ROLES_KEY = 'blacklist:roles';
/** Заасан дүрүүдийн аль нэг нь байх ёстой. Дүр заагаагүй route нь зөвхөн нэвтэрсэн (X-User-Id) байхыг шаарддаг. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Толгой + дүрийн шалгалт (401 X-User-Id, 400 X-Org-Id, 403 дүр). Guard болон csv-body.middleware хоёул үүнийг дуудна —
 * middleware нь guard-аас өмнө ажилладаг тул body-г уншихаас өмнө эрхийг энд шалгана (дүрийн нэрийг давтахгүй).
 */
export function authorize(headers: Headers, allowed?: readonly UserRole[]): RequestContext {
  const ctx = readContext(headers);
  if (allowed?.length && !ctx.roles.some((r) => allowed.includes(r))) throw new ForbiddenException('Insufficient role');
  return ctx;
}

const CTX = Symbol('blacklistContext');

@Injectable()
export class BlacklistAccessGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ec: ExecutionContext): boolean {
    const req = ec.switchToHttp().getRequest<{ headers: Headers; [CTX]?: RequestContext }>();
    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [ec.getHandler(), ec.getClass()]);
    req[CTX] = authorize(req.headers, allowed);
    return true;
  }
}

export const Ctx = createParamDecorator((_data: unknown, ec: ExecutionContext): RequestContext =>
  ec.switchToHttp().getRequest<{ [CTX]: RequestContext }>()[CTX]);
