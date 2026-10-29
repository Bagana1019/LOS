import { GATEWAY_HEADERS } from '@los/contracts';
import type { RequestContext } from '../common/request-context';

export const TEST_ORG_ID = 'org-test';
export type HeaderMap = Record<string, string>;

const base = (userId: string, roles: string, orgId: string): HeaderMap => ({ [GATEWAY_HEADERS.userId]: userId, [GATEWAY_HEADERS.orgId]: orgId, [GATEWAY_HEADERS.roles]: roles });

/** Gateway-ийн толгойг дууриах persona-ууд (тест + demo). */
export function personasFor(merchantId: string, orgId: string = TEST_ORG_ID) {
  return {
    staff: (storeId: string, userId = 'staff-1'): HeaderMap => ({ ...base(userId, 'MERCHANT_STAFF', orgId), [GATEWAY_HEADERS.merchantId]: merchantId, [GATEWAY_HEADERS.storeId]: storeId }),
    merchantAdmin: (userId = 'merchant-admin-1'): HeaderMap => ({ ...base(userId, 'MERCHANT_ADMIN', orgId), [GATEWAY_HEADERS.merchantId]: merchantId }),
    lenderAdmin: (userId = 'lender-admin-1'): HeaderMap => ({ ...base(userId, 'ADMIN', orgId), [GATEWAY_HEADERS.branchId]: 'BR-HQ' }),
    approver: (userId = 'approver-1'): HeaderMap => ({ ...base(userId, 'APPROVER', orgId), [GATEWAY_HEADERS.branchId]: 'BR-HQ' }),
    branchManager: (branchId: string, userId = 'branch-manager-1'): HeaderMap => ({ ...base(userId, 'BRANCH_MANAGER', orgId), [GATEWAY_HEADERS.branchId]: branchId }),
  };
}
export type Personas = ReturnType<typeof personasFor>;

/** Merchant-тэй холбоогүй back-office persona-ууд. */
export const lender = personasFor('-');

/** persona толгойг service-д шууд дамжуулах RequestContext болгоно. */
export function toContext(headers: HeaderMap, correlationId = 'test-corr'): RequestContext {
  return {
    userId: headers[GATEWAY_HEADERS.userId], orgId: headers[GATEWAY_HEADERS.orgId], roles: (headers[GATEWAY_HEADERS.roles] ?? '').split(',').filter(Boolean),
    branchId: headers[GATEWAY_HEADERS.branchId] ?? null, merchantId: headers[GATEWAY_HEADERS.merchantId] ?? null, storeId: headers[GATEWAY_HEADERS.storeId] ?? null, correlationId,
  };
}
