import { ForbiddenException } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { hasRole } from '../../shared/roles';

/** NFR-3 / docs/01 §3: ADMIN, APPROVER → бүгд; BRANCH_MANAGER → салбар; OFFICER → зөвхөн өөрийн хариуцсан. Олон дүртэй бол хамгийн өргөн нь. */
export interface ApplicationScope { orgId: string; branchId: string | null; officerId: string | null }

export function resolveApplicationScope(ctx: RequestContext): ApplicationScope {
  if (hasRole(ctx, 'ADMIN', 'APPROVER')) return { orgId: ctx.orgId, branchId: null, officerId: null };
  if (hasRole(ctx, 'BRANCH_MANAGER')) {
    if (!ctx.branchId) throw new ForbiddenException({ code: 'BRANCH_REQUIRED', message: 'Салбарын захирлын салбар тодорхойгүй байна' });
    return { orgId: ctx.orgId, branchId: ctx.branchId, officerId: null };
  }
  if (hasRole(ctx, 'OFFICER') && ctx.userId) return { orgId: ctx.orgId, branchId: null, officerId: ctx.userId };
  throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Хүсэлтийн жагсаалт харах эрхгүй' });
}
