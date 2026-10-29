// Цэвэр дүрмүүд (I/O байхгүй) — MC-BR-1…10. Service болон store-ын шүүлтүүр энд тодорхойлсон дүрмийг дагана.
import type { ChangeRequestStatus, UserRole } from '@los/contracts';
import type { Actor } from './actor';
import type { ChangeRequestRow, PolicyRow } from './change-request.store';
import type { ChangeHandler } from './change-handler';
import type { MakerCheckerErrorCode } from './maker-checker.errors';

/**
 * Салбарын хязгаарлалттай дүр (NFR-3): ЗӨВХӨН өөрийн салбарын хүсэлтийг баталж чадна. Бусад дүр байгууллагын хэмжээнд.
 * Салбаргүй (branchId = null) хүсэлтийг салбарын дүр баталж/харж чадахгүй — fail-closed; тэдгээрийг APPROVER/ADMIN шийднэ.
 */
export const BRANCH_SCOPED_ROLES: readonly UserRole[] = ['BRANCH_MANAGER'];
export const HOUR_MS = 3_600_000;

type Req = Pick<ChangeRequestRow, 'makerId' | 'requiredCheckerRoles' | 'branchId'>;

/** Checker-ийн дүр + салбарын нөхцөл (maker өөр хүн эсэхийг ЭНД шалгахгүй) */
export function roleDenial(actor: Actor, req: Pick<Req, 'requiredCheckerRoles' | 'branchId'>): MakerCheckerErrorCode | null {
  const matching = actor.roles.filter((r) => req.requiredCheckerRoles.includes(r));
  if (matching.length === 0) return 'CHECKER_ROLE_FORBIDDEN';
  const ok = matching.some((r) => !BRANCH_SCOPED_ROLES.includes(r) || (req.branchId !== null && req.branchId === actor.branchId));
  return ok ? null : 'CHECKER_BRANCH_FORBIDDEN';
}

/** MC-BR-1, MC-BR-2: батлах/татгалзахыг хориглох шалтгаан; null бол зөвшөөрнө. Self-approval нь дүрээс хамаарахгүй, эхэнд шалгагдана. */
export function decideDenial(actor: Actor, req: Req): MakerCheckerErrorCode | null {
  if (actor.userId === req.makerId) return 'SELF_APPROVAL_FORBIDDEN';
  return roleDenial(actor, req);
}

export function isEligibleChecker(actor: Actor, req: Req): boolean { return decideDenial(actor, req) === null; }

export function isOverdue(req: Pick<ChangeRequestRow, 'expiresAt'>, now: Date): boolean { return req.expiresAt.getTime() <= now.getTime(); }

/** Хүсэлтийг хэн харж болох: ADMIN, maker, шийдсэн checker, эсвэл дүр/салбараараа checker болох хүн */
export function canView(actor: Actor, req: Req & Pick<ChangeRequestRow, 'checkerId'>): boolean {
  return actor.roles.includes('ADMIN') || actor.userId === req.makerId || actor.userId === req.checkerId || roleDenial(actor, req) === null;
}

export function canDecideNow(actor: Actor, req: Req & Pick<ChangeRequestRow, 'status' | 'expiresAt'>, now: Date): boolean {
  return req.status === 'PENDING' && !isOverdue(req, now) && decideDenial(actor, req) === null;
}
export function canCancelNow(actor: Actor, req: Pick<ChangeRequestRow, 'status' | 'makerId'>): boolean {
  return req.status === 'PENDING' && actor.userId === req.makerId;
}

export const TERMINAL: readonly ChangeRequestStatus[] = ['APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'];
export const isTerminal = (s: ChangeRequestStatus) => TERMINAL.includes(s);

export interface EffectivePolicy {
  enabled: boolean; checkerRoles: UserRole[]; expiresInHours: number; configured: boolean; locked: boolean;
}
/** Handler-ийн анхдагч + admin-ы тохиргооны мөр. alwaysFourEyes бол enabled үргэлж true (MC-BR-8). */
export function effectivePolicy(handler: ChangeHandler<any>, row: PolicyRow | null): EffectivePolicy { // eslint-disable-line @typescript-eslint/no-explicit-any
  const locked = handler.alwaysFourEyes === true;
  const d = handler.defaultPolicy;
  return {
    enabled: locked ? true : row ? row.enabled : d.enabled,
    checkerRoles: (row ? row.checkerRoles : [...d.checkerRoles]) as UserRole[],
    expiresInHours: row ? row.expiresInHours : d.expiresInHours,
    configured: row !== null,
    locked,
  };
}

export const expiryFrom = (now: Date, hours: number) => new Date(now.getTime() + hours * HOUR_MS);

/** Inbox шүүлтүүрийн нөхцөл — Prisma болон санах ойн store хоёр ижил утгаар тайлбарлана */
export interface InboxCriteria { userId: string; branchId: string | null; unscopedRoles: UserRole[]; scopedRoles: UserRole[] }
export function inboxCriteria(actor: Actor): InboxCriteria {
  return {
    userId: actor.userId, branchId: actor.branchId,
    unscopedRoles: actor.roles.filter((r) => !BRANCH_SCOPED_ROLES.includes(r)),
    scopedRoles: actor.roles.filter((r) => BRANCH_SCOPED_ROLES.includes(r)),
  };
}
/** inboxCriteria-тай тэнцүү санах ойн predicate (store-уудын parity тестэд) */
export function matchesInbox(actor: Actor, req: Req & Pick<ChangeRequestRow, 'status' | 'expiresAt'>, now: Date): boolean {
  return canDecideNow(actor, req, now);
}
