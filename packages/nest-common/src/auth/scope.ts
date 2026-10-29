import { ForbiddenException } from '@nestjs/common';
import { resolveDataScope, type RequestContext } from '@los/contracts';

export interface ScopeFields { ownerField: string; branchField: string }
const DEFAULT_FIELDS: ScopeFields = { ownerField: 'officerId', branchField: 'branchId' };
/** Prisma `where`-д юу ч таарахгүй гэсэн нөхцөл. */
const NO_MATCH = { id: { in: [] as string[] } };

/**
 * NFR-3: ЗЭЗ → зөвхөн өөрийн хүсэлт, Салбарын захирал → салбараа, Батлагч/Админ → бүгд.
 * Жагсаалт/хайлтын `where`-д ҮРГЭЛЖ нэм: `where: { orgId: ctx.orgId, ...scopeWhere(ctx) }`.
 */
export function scopeWhere(ctx: RequestContext, fields: Partial<ScopeFields> = {}): Record<string, unknown> {
  const f = { ...DEFAULT_FIELDS, ...fields };
  const scope = resolveDataScope(ctx.roles);
  if (scope === 'ALL') return {};
  if (scope === 'OWN') return ctx.userId ? { [f.ownerField]: ctx.userId } : NO_MATCH;
  if (scope === 'BRANCH') return ctx.branchId ? { [f.branchField]: ctx.branchId } : NO_MATCH;
  return NO_MATCH;
}

/** Нэг бичлэгийг id-аар авсны дараа: хүрээнээс гадуур бол 403 (docs/04 M2 AC). */
export function assertInScope(ctx: RequestContext, record: { orgId?: string | null; officerId?: string | null; branchId?: string | null }, fields: Partial<ScopeFields> = {}): void {
  const f = { ...DEFAULT_FIELDS, ...fields };
  const r = record as Record<string, unknown>;
  const scope = resolveDataScope(ctx.roles);
  const ok =
    (record.orgId === undefined || record.orgId === null || record.orgId === ctx.orgId) &&
    (scope === 'ALL' ||
      (scope === 'OWN' && !!ctx.userId && r[f.ownerField] === ctx.userId) ||
      (scope === 'BRANCH' && !!ctx.branchId && r[f.branchField] === ctx.branchId));
  if (!ok) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'Энэ бичлэгийг харах эрхгүй' });
}
