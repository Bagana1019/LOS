import { randomUUID } from 'node:crypto';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { UserRole } from '@los/contracts';
import { err } from './maker-checker.errors';

/** Gateway-ээс дамжсан хэрэглэгч (CLAUDE.md §3.2.9: X-User-Id, X-Roles, X-Branch-Id, X-Correlation-Id; X-Org-Id нэмэгдсэн — DECISIONS.md) */
export interface Actor {
  userId: string;
  roles: UserRole[];
  branchId: string | null;
  orgId: string;
  correlationId: string;
}

type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

export function parseActor(headers: Headers, defaultOrgId = process.env.DEFAULT_ORG_ID ?? 'default'): Actor {
  const userId = one(headers['x-user-id']);
  if (!userId) throw err('UNAUTHENTICATED');
  const known = new Set<string>(UserRole);
  const roles = [...new Set((one(headers['x-roles']) ?? '').split(',').map((r) => r.trim().toUpperCase()).filter((r) => known.has(r)))] as UserRole[];
  return {
    userId, roles,
    branchId: one(headers['x-branch-id']) ?? null,
    orgId: one(headers['x-org-id']) ?? defaultOrgId,
    correlationId: one(headers['x-correlation-id']) ?? randomUUID(),
  };
}

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor =>
  parseActor(ctx.switchToHttp().getRequest<{ headers: Headers }>().headers));
