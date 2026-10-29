import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@los/contracts';
import { actorFrom } from './actor';

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({
  userId: 'u1', roles: ['OFFICER'], branchId: 'B1', orgId: 'org1', customerId: null, correlationId: 'c1', ...over,
});

describe('actorFrom', () => {
  it('maps the gateway context to an actor', () => {
    expect(actorFrom(ctx())).toEqual({ userId: 'u1', roles: ['OFFICER'], branchId: 'B1', orgId: 'org1', correlationId: 'c1' });
  });
  it('requires a staff user (no userId → 401, also for customer self-service contexts)', () => {
    expect(() => actorFrom(ctx({ userId: null }))).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(() => actorFrom(ctx({ userId: null, customerId: 'cust1' }))).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });
  it('drops unknown roles and keeps a null branch', () => {
    expect(actorFrom(ctx({ roles: ['APPROVER', 'GOD', 'CUSTOMER'], branchId: null }))).toMatchObject({ roles: ['APPROVER'], branchId: null });
  });
});
