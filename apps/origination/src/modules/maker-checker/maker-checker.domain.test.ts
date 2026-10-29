import { describe, expect, it } from 'vitest';
import type { ChangeRequestRow } from './change-request.store';
import {
  canCancelNow, canDecideNow, canView, decideDenial, effectivePolicy, expiryFrom, inboxCriteria, isEligibleChecker, isOverdue, isTerminal, roleDenial,
} from './maker-checker.domain';
import { actor, adminA, approver, managerB1, managerB2, NoteUpdateHandler, officerA } from './testing/fixtures';

const req = (over: Partial<ChangeRequestRow> = {}): ChangeRequestRow => ({
  id: 'i', orgId: 'org1', branchId: 'B1', targetType: 'T', targetId: '1', action: 'A', applicationId: null, mode: 'FOUR_EYES', status: 'PENDING',
  payload: {}, before: null, baseVersion: null, reason: 'r', makerId: 'officerA', makerRoles: ['OFFICER'], requiredCheckerRoles: ['BRANCH_MANAGER', 'APPROVER'],
  checkerId: null, checkerRoles: [], checkerComment: null, failureReason: null, correlationId: 'c',
  expiresAt: new Date('2026-10-29T00:00:00Z'), decidedAt: null, version: 0, createdAt: new Date('2026-10-28T00:00:00Z'), updatedAt: new Date('2026-10-28T00:00:00Z'), ...over,
});
const now = new Date('2026-10-28T12:00:00Z');

describe('decideDenial', () => {
  it('self-approval beats every role rule', () => {
    expect(decideDenial(actor('officerA', ['ADMIN', 'APPROVER', 'BRANCH_MANAGER']), req())).toBe('SELF_APPROVAL_FORBIDDEN');
  });
  it('requires a listed role', () => {
    expect(decideDenial(adminA, req())).toBe('CHECKER_ROLE_FORBIDDEN');
    expect(decideDenial(actor('x', []), req())).toBe('CHECKER_ROLE_FORBIDDEN');
    expect(decideDenial(approver, req())).toBeNull();
  });
  it('branch-scoped role needs the same branch; a request without a branch is NOT open to it (fail closed)', () => {
    expect(decideDenial(managerB2, req())).toBe('CHECKER_BRANCH_FORBIDDEN');
    expect(decideDenial(managerB1, req())).toBeNull();
    expect(decideDenial(managerB2, req({ branchId: null }))).toBe('CHECKER_BRANCH_FORBIDDEN');
    expect(decideDenial(actor('m', ['BRANCH_MANAGER'], null), req({ branchId: null }))).toBe('CHECKER_BRANCH_FORBIDDEN');
    expect(decideDenial(actor('m', ['BRANCH_MANAGER'], null), req())).toBe('CHECKER_BRANCH_FORBIDDEN');
  });
  it('a branchless request is decided by org-level roles only', () => {
    expect(decideDenial(approver, req({ branchId: null }))).toBeNull();
    expect(canView(managerB1, req({ branchId: null }))).toBe(false);
    expect(canView(approver, req({ branchId: null }))).toBe(true);
  });
  it('an unscoped role wins over a scoped one the user also holds', () => {
    expect(decideDenial(actor('m', ['BRANCH_MANAGER', 'APPROVER'], 'B9'), req())).toBeNull();
    expect(decideDenial(actor('m', ['BRANCH_MANAGER', 'APPROVER'], 'B9'), req({ branchId: null }))).toBeNull();
  });
  it('roleDenial / isEligibleChecker agree', () => {
    expect(roleDenial(officerA, req())).toBe('CHECKER_ROLE_FORBIDDEN');
    expect(isEligibleChecker(managerB1, req())).toBe(true);
    expect(isEligibleChecker(officerA, req())).toBe(false);
  });
});

describe('visibility and state helpers', () => {
  it('canView', () => {
    expect(canView(officerA, req())).toBe(true); // maker
    expect(canView(adminA, req())).toBe(true);
    expect(canView(managerB1, req())).toBe(true);
    expect(canView(managerB2, req())).toBe(false);
    expect(canView(actor('c', ['OFFICER']), req({ checkerId: 'c' }))).toBe(true); // deciding checker keeps access
    expect(canView(actor('z', ['OFFICER']), req())).toBe(false);
  });
  it('overdue / canDecideNow / canCancelNow', () => {
    expect(isOverdue(req(), now)).toBe(false);
    expect(isOverdue(req({ expiresAt: now }), now)).toBe(true);
    expect(canDecideNow(managerB1, req(), now)).toBe(true);
    expect(canDecideNow(managerB1, req({ status: 'APPLIED' }), now)).toBe(false);
    expect(canDecideNow(managerB1, req({ expiresAt: now }), now)).toBe(false);
    expect(canCancelNow(officerA, req())).toBe(true);
    expect(canCancelNow(managerB1, req())).toBe(false);
    expect(canCancelNow(officerA, req({ status: 'REJECTED' }))).toBe(false);
  });
  it('terminal statuses', () => {
    expect(['PENDING'].some((s) => isTerminal(s as never))).toBe(false);
    expect(['APPLIED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'].every((s) => isTerminal(s as never))).toBe(true);
  });
  it('expiryFrom', () => { expect(expiryFrom(now, 2).toISOString()).toBe('2026-10-28T14:00:00.000Z'); });
});

describe('effectivePolicy', () => {
  const h = new NoteUpdateHandler();
  const row = { orgId: 'o', targetType: 'T', action: 'A', enabled: false, checkerRoles: ['ADMIN'], expiresInHours: 3, updatedAt: now, updatedBy: 'u' };
  it('defaults when not configured', () => {
    expect(effectivePolicy(h, null)).toEqual({ enabled: true, checkerRoles: ['BRANCH_MANAGER', 'APPROVER'], expiresInHours: 24, configured: false, locked: false });
  });
  it('configured row overrides', () => {
    expect(effectivePolicy(h, row)).toEqual({ enabled: false, checkerRoles: ['ADMIN'], expiresInHours: 3, configured: true, locked: false });
  });
  it('alwaysFourEyes handlers cannot be disabled', () => {
    expect(effectivePolicy(Object.assign(new NoteUpdateHandler(), { alwaysFourEyes: true }), row).enabled).toBe(true);
  });
});

describe('inboxCriteria', () => {
  it('splits scoped and unscoped roles', () => {
    expect(inboxCriteria(actor('u', ['BRANCH_MANAGER', 'APPROVER'], 'B1'))).toEqual({ userId: 'u', branchId: 'B1', unscopedRoles: ['APPROVER'], scopedRoles: ['BRANCH_MANAGER'] });
  });
});
