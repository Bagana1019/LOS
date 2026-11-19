import { describe, expect, it } from 'vitest';
import { resolvePrincipal } from './merchant-principal';

// docs/05-merchant-pos.md §2, §8: merchant users carry merchant/store scope from iam.user; misconfiguration must never widen access.
describe('resolvePrincipal (iam.user → session roles + merchant scope)', () => {
  const M = 'merchant-1';
  const S = 'store-1';

  it('staff user: known staff roles kept, no merchant scope', () => {
    expect(resolvePrincipal({ roles: ['OFFICER', 'BOGUS'], merchantId: null, storeId: null })).toEqual({ roles: ['OFFICER'], merchantId: null, storeId: null });
  });

  it('staff user with a stray merchant_id: merchant scope is ignored', () => {
    expect(resolvePrincipal({ roles: ['ADMIN'], merchantId: M, storeId: S })).toEqual({ roles: ['ADMIN'], merchantId: null, storeId: null });
  });

  it('MERCHANT_ADMIN with merchant_id: merchant scope, no store', () => {
    expect(resolvePrincipal({ roles: ['MERCHANT_ADMIN'], merchantId: M, storeId: S })).toEqual({ roles: ['MERCHANT_ADMIN'], merchantId: M, storeId: null });
  });

  it('MERCHANT_STAFF with merchant_id and store_id: both scopes', () => {
    expect(resolvePrincipal({ roles: ['MERCHANT_STAFF'], merchantId: M, storeId: S })).toEqual({ roles: ['MERCHANT_STAFF'], merchantId: M, storeId: S });
  });

  it.each([
    ['MERCHANT_ADMIN without merchant_id', { roles: ['MERCHANT_ADMIN'], merchantId: null, storeId: null }],
    ['MERCHANT_STAFF without store_id', { roles: ['MERCHANT_STAFF'], merchantId: M, storeId: null }],
    ['MERCHANT_STAFF without merchant_id', { roles: ['MERCHANT_STAFF'], merchantId: null, storeId: S }],
    ['merchant role mixed with a lender role', { roles: ['MERCHANT_STAFF', 'ADMIN'], merchantId: M, storeId: S }],
    ['both merchant roles at once', { roles: ['MERCHANT_STAFF', 'MERCHANT_ADMIN'], merchantId: M, storeId: S }],
  ])('%s → no roles at all (deny everything)', (_name, input) => {
    expect(resolvePrincipal(input)).toEqual({ roles: [], merchantId: null, storeId: null });
  });

  it('empty and blank ids count as missing', () => {
    expect(resolvePrincipal({ roles: ['MERCHANT_ADMIN'], merchantId: '  ', storeId: null }).roles).toEqual([]);
  });
});
