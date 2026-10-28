import { describe, expect, it } from 'vitest';
import { parseActor } from './actor';

describe('parseActor', () => {
  it('requires X-User-Id', () => {
    expect(() => parseActor({})).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED', httpStatus: 401 }));
    expect(() => parseActor({ 'x-user-id': '  ' })).toThrow();
  });
  it('parses roles case-insensitively, drops unknown/duplicate roles', () => {
    const a = parseActor({ 'x-user-id': 'u1', 'x-roles': 'officer, Approver ,GOD,officer', 'x-branch-id': 'B1', 'x-org-id': 'o1', 'x-correlation-id': 'c1' });
    expect(a).toEqual({ userId: 'u1', roles: ['OFFICER', 'APPROVER'], branchId: 'B1', orgId: 'o1', correlationId: 'c1' });
  });
  it('defaults: no roles, no branch, default org, generated correlation id', () => {
    const a = parseActor({ 'x-user-id': 'u1' }, 'acme');
    expect(a).toMatchObject({ roles: [], branchId: null, orgId: 'acme' });
    expect(a.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('takes the first value of repeated headers', () => {
    expect(parseActor({ 'x-user-id': ['a', 'b'] }).userId).toBe('a');
  });
});
