import { APPROVAL_VOTER_ROLES, ApplicationStatus } from '@los/contracts';

/** FR-1.1: "Миний батлах" нь төлөв биш — `GET /approvals/mine`-ийн жагсаалт. URL-д `?status=MINE`. */
export const MY_APPROVALS_TAB = 'MINE' as const;
export type ListTab = ApplicationStatus | typeof MY_APPROVALS_TAB;

const VOTER_ROLES: readonly string[] = APPROVAL_VOTER_ROLES;

/** FR-1.1: табыг санал өгөх дүрүүдэд л харуулна (серверийн `GET /approvals/mine`-ийн @Roles-той ижил). Түвшний гишүүнчлэлийг сервер шалгана. */
export const canSeeMyApprovals = (roles: readonly string[] | undefined): boolean => !!roles?.some((r) => VOTER_ROLES.includes(r));

/** Төлвийн 9 таб (docs/01 §4) өмнөх дарааллаараа; санал өгөгчид "Батлах явцад"-ын дараа "Миний батлах" нэмэгдэнэ. */
export function listTabs(canVote: boolean): ListTab[] {
  if (!canVote) return [...ApplicationStatus];
  const at = ApplicationStatus.indexOf('IN_APPROVAL') + 1;
  return [...ApplicationStatus.slice(0, at), MY_APPROVALS_TAB, ...ApplicationStatus.slice(at)];
}

/** `?status=` → идэвхтэй таб. Мэдэгдэхгүй утга, эсвэл эрхгүй хэрэглэгчийн `MINE` нь ноорог (DRAFT) руу буцна. */
export function resolveListTab(raw: string | null, canVote: boolean): ListTab {
  if (raw === MY_APPROVALS_TAB) return canVote ? MY_APPROVALS_TAB : 'DRAFT';
  return raw !== null && (ApplicationStatus as readonly string[]).includes(raw) ? (raw as ApplicationStatus) : 'DRAFT';
}

/**
 * "Миний батлах" тоолуур. Тухайн таб дээр байхад шууд ачаалсан жагсаалтын нийт (санал өгсний дараа хамгийн шинэ);
 * бусад табан дээр эсвэл хараахан ирээгүй бол жагсаалтын хариуны `myApprovalCount`. 0 нь үнэн зөв утга.
 */
export function pendingVoteCount(i: { onMineTab: boolean; mineTotal: number | undefined; listCount: number | undefined }): number {
  if (i.onMineTab && i.mineTotal !== undefined) return i.mineTotal;
  return i.listCount ?? 0;
}
