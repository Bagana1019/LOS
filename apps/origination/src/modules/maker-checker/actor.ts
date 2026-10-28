import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { UserRole, type RequestContext } from '@los/contracts';
import { contextOf } from '@los/nest-common';
import { err } from './maker-checker.errors';

/** Хүсэлт гаргагч/батлагч: gateway-ийн баталгаажуулсан `RequestContext`-ээс (CLAUDE.md §3.2.9; parse хийх нь @los/nest-common-ийн ажил). */
export interface Actor {
  userId: string;
  roles: UserRole[];
  branchId: string | null;
  orgId: string;
  correlationId: string;
}

const KNOWN_ROLES = new Set<string>(UserRole);

/** Зөвхөн нэвтэрсэн ажилтан (userId) — зээлдэгчийн self-service (customerId) maker/checker болохгүй. Мэдэгдэхгүй дүрийг хаяна. */
export function actorFrom(ctx: RequestContext): Actor {
  if (!ctx.userId) throw err('UNAUTHENTICATED');
  return {
    userId: ctx.userId,
    roles: ctx.roles.filter((r): r is UserRole => KNOWN_ROLES.has(r)),
    branchId: ctx.branchId,
    orgId: ctx.orgId,
    correlationId: ctx.correlationId,
  };
}

export const CurrentActor = createParamDecorator((_data: unknown, ex: ExecutionContext): Actor =>
  actorFrom(contextOf(ex.switchToHttp().getRequest())));
