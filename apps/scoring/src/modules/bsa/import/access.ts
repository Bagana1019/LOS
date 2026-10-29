// Application service-үүдийн нийтлэг хандалтын шалгалт. Тенант/салбар/үүргийн шийдвэрийг common/request-context.ts-ийн
// `assertCanAccessAnalysis` гаргана (өөр байгууллага ⇒ NotFound, бусад ⇒ Forbidden); энд зөвхөн унших/бичих ялгаа, үүргийн шалгалт.
import { ForbiddenException } from '@nestjs/common';
import type { UserRole } from '@los/contracts';
import { analysisNotFound, assertCanAccessAnalysis, REQUEST_CONTEXT_MESSAGES } from '../common/request-context';
import type { RequestContext } from '../common/infra.ports';
import type { BsaAnalysisRecord, BsaRepository } from '../common/persistence';

export type AccessMode = 'read' | 'write';

/** docs/01 §3: APPROVER зөвхөн харна (шинжилгээнд өөрчлөлт хийхгүй) */
export const WRITE_ROLES: readonly UserRole[] = ['OFFICER', 'BRANCH_MANAGER', 'ADMIN'];

const forbidden = (): ForbiddenException => new ForbiddenException(REQUEST_CONTEXT_MESSAGES.forbidden);

export const hasAnyRole = (ctx: RequestContext, roles: readonly UserRole[]): boolean => ctx.roles.some((r) => roles.includes(r));

/** Үүрэг шаардсан үйлдэл (жишээ нь дүрэм үүсгэх = ADMIN) */
export function assertRole(ctx: RequestContext, roles: readonly UserRole[]): void {
  if (!hasAnyRole(ctx, roles)) throw forbidden();
}

/** Бичих эрх: APPROVER-ийн үүргийг хасаж шалгана (APPROVER + OFFICER хоёр үүрэгтэй бол OFFICER-ийн хүрээнд) */
export function assertCanWriteAnalysis(ctx: RequestContext, target: BsaAnalysisRecord): void {
  assertCanAccessAnalysis({ ...ctx, roles: ctx.roles.filter((r) => WRITE_ROLES.includes(r)) }, target);
}

/**
 * Шинжилгээг тенантын хүрээнд ачаалж, хандалтыг шалгана. Байхгүй / өөр байгууллагынх ⇒ ИЖИЛ NotFound (оршихыг задруулахгүй).
 * `repo` нь transaction дотор transaction-ийн repo байж болно.
 */
export async function loadAnalysis(repo: BsaRepository, ctx: RequestContext, analysisId: string, mode: AccessMode): Promise<BsaAnalysisRecord> {
  const record = await repo.analyses.getById(analysisId, { orgId: ctx.orgId });
  if (!record) throw analysisNotFound();
  if (mode === 'write') assertCanWriteAnalysis(ctx, record);
  else assertCanAccessAnalysis(ctx, record);
  return record;
}
