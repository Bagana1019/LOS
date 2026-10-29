import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@los/contracts';
import { effectiveScope, resolveReportScope } from './report-scope';

const ctx = (o: Partial<RequestContext>): RequestContext => ({ userId: 'u1', roles: [], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'c', ...o });

describe('report-scope (NFR-3)', () => {
  it('ADMIN / APPROVER → бүгд', () => {
    expect(resolveReportScope(ctx({ roles: ['ADMIN'] }))).toEqual({ orgId: 'org-1', branchId: null, officerId: null });
    expect(resolveReportScope(ctx({ roles: ['APPROVER'], branchId: 'b1' }))).toEqual({ orgId: 'org-1', branchId: null, officerId: null });
  });

  it('BRANCH_MANAGER → өөрийн салбар; салбаргүй бол 403 BRANCH_REQUIRED', () => {
    expect(resolveReportScope(ctx({ roles: ['BRANCH_MANAGER'], branchId: 'b1' }))).toEqual({ orgId: 'org-1', branchId: 'b1', officerId: null });
    expect(() => resolveReportScope(ctx({ roles: ['BRANCH_MANAGER'] }))).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'BRANCH_REQUIRED' }) }));
  });

  it('OFFICER → өөрийн хариуцсан; хэрэглэгчийн ID-гүй бол 403', () => {
    expect(resolveReportScope(ctx({ roles: ['OFFICER'], branchId: 'b1' }))).toEqual({ orgId: 'org-1', branchId: null, officerId: 'u1' });
    expect(() => resolveReportScope(ctx({ roles: ['OFFICER'], userId: null }))).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'FORBIDDEN' }) }));
  });

  it('олон дүр: хамгийн өргөн нь', () => {
    expect(resolveReportScope(ctx({ roles: ['OFFICER', 'ADMIN'] })).officerId).toBeNull();
    expect(resolveReportScope(ctx({ roles: ['OFFICER', 'BRANCH_MANAGER'], branchId: 'b1' }))).toMatchObject({ branchId: 'b1', officerId: null });
  });

  it('CUSTOMER болон дүргүй → 403', () => {
    for (const roles of [['CUSTOMER'], [], ['GUEST']]) {
      expect(() => resolveReportScope(ctx({ roles })), roles.join()).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 'FORBIDDEN' }) }));
    }
  });

  it('effectiveScope: хүрээ давуу, хүрээгүй талбарыг query нарийсгана, хоосон string үл тооно', () => {
    const all = { orgId: 'o', branchId: null, officerId: null };
    expect(effectiveScope(all, { branchId: 'b2', officerId: 'x' })).toEqual({ branchId: 'b2', officerId: 'x' });
    expect(effectiveScope(all, { branchId: '', officerId: undefined })).toEqual({ branchId: null, officerId: null });
    expect(effectiveScope({ orgId: 'o', branchId: 'b1', officerId: null }, { branchId: 'b2', officerId: 'x' })).toEqual({ branchId: 'b1', officerId: 'x' });
    expect(effectiveScope({ orgId: 'o', branchId: null, officerId: 'u1' }, { branchId: 'b2', officerId: 'other' })).toEqual({ branchId: 'b2', officerId: 'u1' });
  });
});
