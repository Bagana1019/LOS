import { incompatibleRolePair, PRIVILEGED_ROLES } from '@los/contracts';
import { ApiError } from '../../lib/api';

// F9-19 · Хэрэглэгчийн дүр сонгох хамгаалалт. Дүрмийн эх сурвалж: `@los/contracts` role-rules (gateway мөн үүнийг хэрэглэнэ) — web-д хос хуулбарлахгүй.

export type RoleGuardCtx = {
  /** Маягтад одоо сонгогдсон дүрүүд */
  selected: readonly string[];
  /** Хадгалагдсан дүрүүд (шинэ хэрэглэгч бол хоосон) */
  original: readonly string[];
  /** Админ өөрийн бүртгэлийг засаж байна */
  isSelf: boolean;
};

export type RoleDisabledReason = { kind: 'self' } | { kind: 'pair'; partner: string };

/** gateway-ийн 422 кодууд: маягтыг нээлттэй үлдээж, мессежийг маягт дотор харуулна. */
export const ROLE_GUARD_ERROR_CODES: readonly string[] = ['ROLE_COMBINATION_FORBIDDEN', 'SELF_ROLE_GRANT'];

/**
 * Дүрийг сонгох боломжгүй болгох шалтгаан (null = сонгож болно). Gateway-тэй яг ижил:
 * - өөрийн бүртгэл: өөрт байхгүй дүрийг нэмэхгүй (`SELF_ROLE_GRANT`); байгаа дүрийг хасаж болно;
 * - хориглосон хос: зөвхөн ШИНЭЭР бий болгохыг хаана — хуучин хослолтой хэрэглэгч нэгийг нь хасаж болно (`ROLE_COMBINATION_FORBIDDEN`).
 * Сонгосон дүр өөрөө хаагдахгүй (хасах боломж үлдэнэ).
 */
export function roleDisabledReason(role: string, { selected, original, isSelf }: RoleGuardCtx): RoleDisabledReason | null {
  if (isSelf && !original.includes(role)) return { kind: 'self' };
  if (selected.includes(role) || incompatibleRolePair(original)) return null;
  const pair = incompatibleRolePair([...selected, role]);
  if (!pair) return null;
  return { kind: 'pair', partner: pair[0] === role ? pair[1] : pair[0] };
}

/** Шинээр нэмэгдэж буй эрх өсгөх дүрүүд (PRIVILEGED_ROLES-ийн дарааллаар). Хоосон бол баталгаажуулах цонх гарахгүй. */
export function addedPrivilegedRoles(before: readonly string[], after: readonly string[]): string[] {
  return PRIVILEGED_ROLES.filter((r) => after.includes(r) && !before.includes(r));
}

export const isRoleGuardError = (e: unknown): e is ApiError => e instanceof ApiError && e.code !== null && ROLE_GUARD_ERROR_CODES.includes(e.code);
