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
  it('menu: settings only for admin; every role sees customer/report, every role but COMPLIANCE sees application/loan (N2)', () => {
    const ids = (roles: string[]) => menuFor(roles).map((m) => m.id);
    expect(ids(['ADMIN'])).toContain('settings');
    for (const r of ['OFFICER', 'BRANCH_MANAGER', 'APPROVER']) expect(ids([r])).not.toContain('settings');
    for (const r of UserRole) expect(ids([r])).toEqual(expect.arrayContaining(['customer', 'report']));
    for (const r of UserRole.filter((x) => x !== 'COMPLIANCE')) expect(ids([r])).toEqual(expect.arrayContaining(['application', 'loan']));
    expect(menuFor([])).toEqual([]);
  });
  it('blacklist is a top-level item right above settings (not a sub-menu); menuFor does not mutate MENU', () => {
    const before = JSON.stringify(MENU);
    const admin = menuFor(['ADMIN']).map((m) => m.id);
    expect(admin.indexOf('blacklist')).toBe(admin.indexOf('settings') - 1);
    expect(menuFor(['ADMIN']).find((m) => m.id === 'blacklist')?.children).toBeUndefined();
    expect(menuFor(['ADMIN']).find((m) => m.id === 'application')?.children).toBeUndefined();
    for (const r of UserRole) expect(menuFor([r]).map((m) => m.id)).toContain('blacklist');
    expect(JSON.stringify(MENU)).toBe(before);
  });
  it('Q-081: blacklist:manage is held only by ADMIN, COMPLIANCE and BRANCH_MANAGER, and BRANCH_MANAGER gains no other write right', () => {
    const holders = UserRole.filter((r) => ROLE_PERMISSIONS[r].includes('blacklist:manage'));
    expect([...holders].sort()).toEqual(['ADMIN', 'BRANCH_MANAGER', 'COMPLIANCE']);
    const bm = permissionsFor(['BRANCH_MANAGER']);
    for (const p of ['settings:manage', 'user:manage', 'audit:read', 'customer:write', 'application:write', 'disbursement:approve', 'erp-sync:manage'] as const) expect(bm).not.toContain(p);
  });
  // N2 (phase 7): origination-ийн `READERS` (OFFICER, BRANCH_MANAGER, APPROVER, ADMIN) л хүсэлт/зээлийн жагсаалтыг уншдаг. Цэс/эрх үүнээс өргөн бол цэс харагдаад API 403 өгнө.
  it('N2: application:read is held only by the roles origination lets read applications, so COMPLIANCE gets neither the Хүсэлт nor the Зээл menu', () => {
    const holders = UserRole.filter((r) => ROLE_PERMISSIONS[r].includes('application:read'));
    expect([...holders].sort()).toEqual(['ADMIN', 'APPROVER', 'BRANCH_MANAGER', 'OFFICER']);
    const ids = menuFor(['COMPLIANCE']).map((m) => m.id);
    expect(ids).not.toContain('application');
    expect(ids).not.toContain('loan');
    expect(ids).toEqual(expect.arrayContaining(['aml-review', 'blacklist', 'report', 'maker-checker']));
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
  // docs/05-compliance-aml.md §5, §7: AML hit-ийг шийдвэрлэх дараалал — цэс ба gateway-н эрх зөвхөн COMPLIANCE-д (DECISIONS P4C-1).
  it('aml:review is held only by COMPLIANCE, and only COMPLIANCE sees the AML review menu item', () => {
    for (const r of UserRole) expect(ROLE_PERMISSIONS[r].includes('aml:review'), r).toBe(r === 'COMPLIANCE');
    const item = MENU.find((m) => m.id === 'aml-review');
    expect(item).toMatchObject({ href: '/los/compliance/aml', permission: 'aml:review', labelKey: 'nav.aml_review' });
    for (const r of UserRole) expect(menuFor([r]).map((m) => m.id).includes('aml-review'), r).toBe(r === 'COMPLIANCE');
  });
});
