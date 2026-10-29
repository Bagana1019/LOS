import type { MerchantRole } from '@los/contracts';
import type { RequestContext } from '../common/request-context';
import { DomainError } from '../domain/errors';

// Tenant хилийн ЦОРЫН ГАНЦ газар (docs/05 §8, §13). Controller-ийн RolesGuard-аас үл хамааран service бүр энд дахин шалгана.
const MERCHANT_ROLES: readonly string[] = ['MERCHANT_ADMIN', 'MERCHANT_STAFF'];

export const isMerchantPrincipal = (ctx: RequestContext) => ctx.roles.some((r) => MERCHANT_ROLES.includes(r));

export interface MerchantScope {
  merchantId: string;
  /** MERCHANT_STAFF → заавал өөрийн дэлгүүр; MERCHANT_ADMIN → null */
  storeId: string | null;
  role: MerchantRole;
}

/** Мерчант порталын principal: X-Merchant-Id заавал; STAFF бол X-Store-Id заавал. Бусад нь 403. */
export function merchantScope(ctx: RequestContext): MerchantScope {
  const hasLender = ctx.roles.some((r) => !MERCHANT_ROLES.includes(r));
  if (hasLender || !isMerchantPrincipal(ctx) || !ctx.merchantId) throw new DomainError('FORBIDDEN', 'Merchant access required');
  if (ctx.roles.includes('MERCHANT_ADMIN')) return { merchantId: ctx.merchantId, storeId: null, role: 'MERCHANT_ADMIN' };
  if (!ctx.storeId) throw new DomainError('FORBIDDEN', 'Store scope required');
  return { merchantId: ctx.merchantId, storeId: ctx.storeId, role: 'MERCHANT_STAFF' };
}

export interface BackOfficeScope {
  /** null → бүх салбар (ADMIN, APPROVER); BRANCH_MANAGER → өөрийн салбар */
  branchId: string | null;
  isAdmin: boolean;
}

/** Лизингийн байгууллагын principal. Мерчант дүр бол 403. BRANCH_MANAGER салбаргүй бол 403. */
export function backOfficeScope(ctx: RequestContext): BackOfficeScope {
  if (isMerchantPrincipal(ctx)) throw new DomainError('FORBIDDEN', 'Back-office access required');
  const isAdmin = ctx.roles.includes('ADMIN');
  if (isAdmin || ctx.roles.includes('APPROVER')) return { branchId: null, isAdmin };
  if (ctx.roles.includes('BRANCH_MANAGER')) {
    if (!ctx.branchId) throw new DomainError('FORBIDDEN', 'Branch scope required');
    return { branchId: ctx.branchId, isAdmin: false };
  }
  throw new DomainError('FORBIDDEN', 'Insufficient role');
}

/** Бичих эрхтэй (ADMIN) эсэхийг шалгана. */
export function requireAdmin(ctx: RequestContext): BackOfficeScope {
  const scope = backOfficeScope(ctx);
  if (!scope.isAdmin) throw new DomainError('FORBIDDEN', 'Admin role required');
  return scope;
}

/** Back-office хүрээнд тухайн салбарын нөөц харагдах уу. */
export const inBranch = (scope: BackOfficeScope, branchId: string) => scope.branchId === null || scope.branchId === branchId;

export const merchantActor = (ctx: RequestContext) => `MERCHANT:${ctx.userId}`;
export const lenderActor = (ctx: RequestContext) => `LENDER:${ctx.userId}`;
