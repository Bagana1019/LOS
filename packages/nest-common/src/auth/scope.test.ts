import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@los/contracts';
import { assertInScope, scopeWhere } from './scope';

const ctx = (roles: string[], over: Partial<RequestContext> = {}): RequestContext => ({ userId: 'u1', roles, branchId: 'b1', orgId: 'o1', customerId: null, correlationId: 'c', ...over });

describe('scopeWhere (NFR-3)', () => {
  it('officer → own, manager → branch, approver/admin → all', () => {
    expect(scopeWhere(ctx(['OFFICER']))).toEqual({ officerId: 'u1' });
    expect(scopeWhere(ctx(['BRANCH_MANAGER']))).toEqual({ branchId: 'b1' });
    expect(scopeWhere(ctx(['APPROVER']))).toEqual({});
    expect(scopeWhere(ctx(['ADMIN']))).toEqual({});
  });
  it('matches nothing when role is unknown or required id is missing', () => {
    const none = { id: { in: [] } };
    expect(scopeWhere(ctx([]))).toEqual(none);
    expect(scopeWhere(ctx(['OFFICER'], { userId: null }))).toEqual(none);
    expect(scopeWhere(ctx(['BRANCH_MANAGER'], { branchId: null }))).toEqual(none);
  });
  it('supports custom field names', () => {
    expect(scopeWhere(ctx(['OFFICER']), { ownerField: 'createdBy' })).toEqual({ createdBy: 'u1' });
  });
});

describe('assertInScope', () => {
  it('officer A cannot read officer B record (403)', () => {
    expect(() => assertInScope(ctx(['OFFICER']), { officerId: 'u2', branchId: 'b1', orgId: 'o1' })).toThrow(/эрхгүй/);
    expect(() => assertInScope(ctx(['OFFICER']), { officerId: 'u1', branchId: 'b1', orgId: 'o1' })).not.toThrow();
  });
  it('manager sees own branch only; approver sees all in the same org', () => {
    expect(() => assertInScope(ctx(['BRANCH_MANAGER']), { officerId: 'u9', branchId: 'b2' })).toThrow();
    expect(() => assertInScope(ctx(['BRANCH_MANAGER']), { officerId: 'u9', branchId: 'b1' })).not.toThrow();
    expect(() => assertInScope(ctx(['APPROVER']), { officerId: 'u9', branchId: 'b2', orgId: 'o1' })).not.toThrow();
  });
  it('rejects a record from another org even for ALL scope', () => {
    expect(() => assertInScope(ctx(['ADMIN']), { orgId: 'other' })).toThrow();
  });
});
