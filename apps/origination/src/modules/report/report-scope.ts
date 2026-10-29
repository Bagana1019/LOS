import { ForbiddenException } from '@nestjs/common';
import { hasRole } from '../../shared/roles';
import type { RequestContext } from '@los/contracts';

/**
 * NFR-3: тайлангийн харагдах хүрээ. null талбар = хязгаарлаагүй.
 *  · ADMIN / APPROVER → бүгд;  · BRANCH_MANAGER → өөрийн салбар;  · OFFICER → зөвхөн өөрийн хариуцсан (officerId = userId).
 * Олон дүртэй бол хамгийн өргөн нь (ADMIN/APPROVER > BRANCH_MANAGER > OFFICER).
 */
export interface ReportScope {
  orgId: string;
  branchId: string | null;
  officerId: string | null;
}

export function resolveReportScope(ctx: RequestContext): ReportScope {
  if (hasRole(ctx, 'ADMIN', 'APPROVER')) return { orgId: ctx.orgId, branchId: null, officerId: null };
  if (hasRole(ctx, 'BRANCH_MANAGER')) {
    if (!ctx.branchId) throw new ForbiddenException({ code: 'BRANCH_REQUIRED', message: 'Салбарын захирлын салбар тодорхойгүй тул тайлан харах боломжгүй' });
    return { orgId: ctx.orgId, branchId: ctx.branchId, officerId: null };
  }
  if (hasRole(ctx, 'OFFICER')) {
    if (!ctx.userId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй' });
    return { orgId: ctx.orgId, branchId: null, officerId: ctx.userId };
  }
  throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Тайлан харах эрхгүй' });
}

/** Хүрээгээр тогтоогдсон утга нь query-н шүүлтээс давуу (хүрээнээс гадуур шүүлтийг үл тооно); хүрээгүй талбарыг query нарийсгана. */
export function effectiveScope(scope: ReportScope, query: { branchId?: string | null; officerId?: string | null }): { branchId: string | null; officerId: string | null } {
  return { branchId: scope.branchId ?? (query.branchId || null), officerId: scope.officerId ?? (query.officerId || null) };
}
