import { MerchantRole, UserRole, type AccountRole } from '@los/contracts';

export interface PrincipalSource { roles: readonly string[]; merchantId: string | null; storeId: string | null }
export interface Principal { roles: AccountRole[]; merchantId: string | null; storeId: string | null }

const NONE: Principal = { roles: [], merchantId: null, storeId: null };
const present = (v: string | null) => (v && v.trim() ? v : null);
const isMerchantRole = (r: string): r is MerchantRole => (MerchantRole as readonly string[]).includes(r);
const isUserRole = (r: string): r is UserRole => (UserRole as readonly string[]).includes(r);

/**
 * iam.user → сессийн дүр + мерчантын хүрээ (docs/05-merchant-pos.md §2, §8).
 * Мерчант хэрэглэгч яг НЭГ MERCHANT_* дүртэй, лизингийн дүргүй, merchant_id-тай (STAFF бол store_id-тай) байх ёстой.
 * Буруу тохиргоо (холимог дүр, хүрээ дутуу) → дүр огт өгөхгүй: алдаа нь эрхийг өргөтгөхгүй, бүгдийг хаана.
 */
export function resolvePrincipal(u: PrincipalSource): Principal {
  const merchantRoles = u.roles.filter(isMerchantRole);
  const staffRoles = u.roles.filter(isUserRole);
  if (merchantRoles.length === 0) return { roles: staffRoles, merchantId: null, storeId: null };
  if (merchantRoles.length > 1 || staffRoles.length > 0) return NONE;
  const role = merchantRoles[0]!;
  const merchantId = present(u.merchantId);
  const storeId = role === 'MERCHANT_STAFF' ? present(u.storeId) : null;
  if (!merchantId || (role === 'MERCHANT_STAFF' && !storeId)) return NONE;
  return { roles: [role], merchantId, storeId };
}

export const isMerchantPrincipal = (roles: readonly string[]) => roles.some(isMerchantRole);
