import { describe, expect, it } from 'vitest';
import { AuthResponse, MENU, menuFor, permissionsFor, resolveDataScope, ROLE_PERMISSIONS, Permission, UserRole } from './index';

describe('RBAC (docs/01 §3)', () => {
  it('every role only holds known permissions', () => {
    for (const r of UserRole) for (const p of ROLE_PERMISSIONS[r]) expect(Permission).toContain(p);
  });
  it('approver cannot edit terms; only officer writes applications (FR-10.3)', () => {
    expect(permissionsFor(['APPROVER'])).not.toContain('application:write');
    expect(permissionsFor(['BRANCH_MANAGER'])).not.toContain('application:write');
    expect(permissionsFor(['OFFICER'])).toContain('application:submit');
  });
  it('data scope: officer own, manager branch, approver/admin all, unknown none (NFR-3)', () => {
    expect(resolveDataScope(['OFFICER'])).toBe('OWN');
    expect(resolveDataScope(['BRANCH_MANAGER'])).toBe('BRANCH');
    expect(resolveDataScope(['APPROVER'])).toBe('ALL');
    expect(resolveDataScope(['ADMIN'])).toBe('ALL');
    expect(resolveDataScope(['OFFICER', 'BRANCH_MANAGER'])).toBe('BRANCH');
    expect(resolveDataScope(['HACKER'])).toBe('NONE');
    expect(resolveDataScope([])).toBe('NONE');
  });
  it('menu: settings only for admin; every role sees customer/application/loan', () => {
    const ids = (roles: string[]) => menuFor(roles).map((m) => m.id);
    expect(ids(['ADMIN'])).toContain('settings');
    for (const r of ['OFFICER', 'BRANCH_MANAGER', 'APPROVER']) expect(ids([r])).not.toContain('settings');
    for (const r of UserRole) expect(ids([r])).toEqual(expect.arrayContaining(['customer', 'application', 'loan', 'report']));
    expect(menuFor([])).toEqual([]);
  });
  it('menu children are filtered by permission and MENU is not mutated', () => {
    const before = JSON.stringify(MENU);
    expect(menuFor(['OFFICER']).find((m) => m.id === 'application')?.children?.map((c) => c.id)).toEqual(['blacklist']);
    expect(JSON.stringify(MENU)).toBe(before);
  });
  it('AuthResponse schema accepts a menu built by menuFor', () => {
    const roles = ['ADMIN'] as const;
    const parsed = AuthResponse.safeParse({
      accessToken: 'x', expiresIn: 900, permissions: permissionsFor(roles), menu: menuFor(roles),
      user: { id: 'u1', orgId: 'o1', branchId: null, username: 'admin', fullName: 'Админ', roles },
    });
    expect(parsed.success).toBe(true);
  });

  it('only ADMIN may manage the ERP sync', () => {
    for (const r of UserRole) expect(ROLE_PERMISSIONS[r].includes('erp-sync:manage'), r).toBe(r === 'ADMIN');
  });
});
