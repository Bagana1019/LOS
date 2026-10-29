import { describe, expect, it } from 'vitest';
import { isInternalOnly, requiredPermission } from './route-policy';

describe('requiredPermission (FR-5.5 pricing tiers)', () => {
  const tiers = '/api/origination/loan-terms/pricing/tiers';
  it('changing the rate card needs settings:manage; reading it and asking for a quote do not', () => {
    expect(requiredPermission('PUT', tiers)).toBe('settings:manage');
    expect(requiredPermission('GET', tiers)).toBeNull();
    expect(requiredPermission('POST', '/api/origination/loan-terms/pricing/quote')).toBeNull();
  });
  it('does not match look-alike prefixes', () => {
    expect(requiredPermission('PUT', `${tiers}-x`)).toBeNull();
  });
});

describe('isInternalOnly (staff proxy blocks internal sync paths)', () => {
  it('Module 6/9: documents are created only through origination; collateral valuations are saved only by origination', () => {
    expect(isInternalOnly('/api/dms/documents')).toBe(true);
    expect(isInternalOnly('/api/dms/documents/abc')).toBe(true);
    expect(isInternalOnly('/api/DMS/Documents/abc')).toBe(true);
    expect(isInternalOnly('/api/valuation/valuate/collateral/suggest')).toBe(true);
    expect(isInternalOnly('/api/valuation/valuate/collateral')).toBe(true);
  });
  it('file upload and the existing auto-valuation lookups stay open to staff', () => {
    expect(isInternalOnly('/api/dms/files')).toBe(false);
    expect(isInternalOnly('/api/dms/files/abc/content')).toBe(false);
    expect(isInternalOnly('/api/dms/documents-x')).toBe(false);
    expect(isInternalOnly('/api/valuation/valuate/auto')).toBe(false);
    expect(isInternalOnly('/api/valuation/base-prices')).toBe(false);
  });
});
