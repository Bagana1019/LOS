import { describe, expect, it } from 'vitest';
import { requiredPermission } from './route-policy';

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
