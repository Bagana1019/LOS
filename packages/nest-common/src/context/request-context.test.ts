import { describe, expect, it } from 'vitest';
import { getRequestContext, parseRequestContext, requireRequestContext, runWithContext, systemContext } from './request-context';

describe('parseRequestContext', () => {
  it('reads the trusted gateway headers', () => {
    const ctx = parseRequestContext({ 'x-user-id': 'u1', 'x-roles': 'officer, approver,OFFICER', 'x-branch-id': 'b1', 'x-org-id': 'o1', 'x-correlation-id': 'corr-1' }, {});
    expect(ctx).toEqual({ userId: 'u1', roles: ['OFFICER', 'APPROVER'], branchId: 'b1', orgId: 'o1', customerId: null, correlationId: 'corr-1' });
  });
  it('falls back to DEFAULT_ORG_ID and generates a correlation id', () => {
    const ctx = parseRequestContext({}, { DEFAULT_ORG_ID: 'org-x' });
    expect(ctx.orgId).toBe('org-x');
    expect(ctx.userId).toBeNull();
    expect(ctx.roles).toEqual([]);
    expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('replaces unsafe correlation ids (log injection)', () => {
    const ctx = parseRequestContext({ 'x-correlation-id': 'a\nb"c' }, {});
    expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('takes the first value of repeated headers and ignores blanks', () => {
    expect(parseRequestContext({ 'x-user-id': ['u1', 'u2'], 'x-branch-id': '  ' }, {}).userId).toBe('u1');
    expect(parseRequestContext({ 'x-branch-id': '  ' }, {}).branchId).toBeNull();
  });
});

describe('async context', () => {
  it('is available inside runWithContext, also across awaits, and absent outside', async () => {
    expect(getRequestContext()).toBeNull();
    expect(() => requireRequestContext()).toThrow();
    const ctx = systemContext('o1', 'c1');
    await runWithContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(requireRequestContext().correlationId).toBe('c1');
    });
    expect(getRequestContext()).toBeNull();
  });
});
