import type { UserRole } from './enums';

/**
 * F9-19: нэг хүнд ЗЭРЭГ олгохыг хориглосон дүрийн хос (хуваарилсан үүрэг: бэлтгэгч ≠ батлагч).
 * Хүсэлт/олголт тус бүрт өөрийнхийгөө батлахыг origination (`SELF_APPROVAL_FORBIDDEN`) аль хэдийн хаадаг; энэ нь дүрийн түвшний нэмэлт хамгаалалт.
 * Зөвхөн ШИНЭЭР бий болгохыг хаана (хуучин хослол байсан хэрэглэгчийн профайл засахад саад болохгүй). Сулруулах бол энэ нэг жагсаалтыг л өөрчилнө.
 */
export const INCOMPATIBLE_ROLE_PAIRS: ReadonlyArray<readonly [UserRole, UserRole]> = [['OFFICER', 'APPROVER']];

/** Эрх өсгөх дүрүүд: олгохдоо web баталгаажуулах цонх гаргана. */
export const PRIVILEGED_ROLES: readonly UserRole[] = ['ADMIN', 'APPROVER', 'COMPLIANCE'];

/** Дүрийн жагсаалт дахь хориглосон хосыг буцаана (байхгүй бол null). */
export function incompatibleRolePair(roles: readonly string[]): readonly [UserRole, UserRole] | null {
  return INCOMPATIBLE_ROLE_PAIRS.find(([a, b]) => roles.includes(a) && roles.includes(b)) ?? null;
}
