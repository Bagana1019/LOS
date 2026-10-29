import { describe, expect, it } from 'vitest';
import { MENU, menuFor, permissionsFor } from '@los/contracts';
import { activeHref, canAccess, contractSearchHref, flattenMenu, hasOwnShell, isPublicPath, isStandalonePath, looksLikeContractNo, requiredPermission, safeNext, searchMenu } from './access';

describe('safeNext (open redirect)', () => {
  it.each([
    [null, '/'],
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['/los/report', '/los/report'],
    ['/los/loan-application?q=A1&page=2#top', '/los/loan-application?q=A1&page=2#top'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['/\t/evil.com', '/'],
    ['https://evil.com/x', '/'],
    ['javascript:alert(1)', '/'],
    ['/login', '/'],
    ['/login?next=/x', '/'],
    // dot-segment-ийн дараа `//` үлддэг хэлбэрүүд (protocol-relative)
    ['/.//evil.com', '/'],
    ['/..//evil.com', '/'],
    ['/a/..//evil.com/p?q=1', '/'],
    ['/a/./b', '/a/b'],
  ])('%j → %j', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});

describe('sidebar active item', () => {
  const menu = menuFor(['ADMIN']);
  it('picks the longest matching prefix', () => {
    expect(activeHref('/los/loan-application/blacklist', menu)).toBe('/los/loan-application/blacklist');
    expect(activeHref('/los/loan-application/abc/3', menu)).toBe('/los/loan-application');
    expect(activeHref('/customer/42', menu)).toBe('/customer');
  });
  it('does not match a sibling that only shares a string prefix', () => {
    expect(activeHref('/settings-old', menu)).toBeNull();
    expect(activeHref('/', menu)).toBeNull();
  });
});

describe('route access (UX guard; gateway and services enforce for real)', () => {
  it('settings need settings:manage', () => {
    expect(canAccess('/settings', permissionsFor(['ADMIN']))).toBe(true);
    expect(canAccess('/settings', permissionsFor(['OFFICER']))).toBe(false);
    expect(requiredPermission('/settings/products')).toBe('settings:manage');
  });
  it('blacklist is gated by its own permission, not the parent list', () => {
    expect(requiredPermission('/los/loan-application/blacklist')).toBe('blacklist:read');
    expect(requiredPermission('/los/loan-application/abc/2')).toBe('application:read');
  });
  it('bsa pages need bsa:review (not in the menu)', () => {
    expect(canAccess('/los/bsa/123', permissionsFor(['OFFICER']))).toBe(true);
    expect(canAccess('/los/bsa/123', permissionsFor(['ADMIN']))).toBe(false);
  });
  it('unknown and home paths are open once signed in', () => {
    expect(requiredPermission('/')).toBeNull();
    expect(canAccess('/whatever', [])).toBe(true);
  });
  it('every role can open every page its own menu lists', () => {
    for (const role of ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'] as const) {
      const perms = permissionsFor([role]);
      for (const item of flattenMenu(menuFor([role]))) expect(canAccess(item.href, perms), `${role} ${item.href}`).toBe(true);
    }
  });
  it('menu pages missing from a role menu are blocked for that role', () => {
    const officer = permissionsFor(['OFFICER']);
    const hidden = flattenMenu(MENU).filter((i) => !flattenMenu(menuFor(['OFFICER'])).some((m) => m.id === i.id));
    expect(hidden.length).toBeGreaterThan(0);
    for (const item of hidden) expect(canAccess(item.href, officer), item.href).toBe(false);
  });
});

describe('header search (FR-1.4)', () => {
  const menu = menuFor(['ADMIN']);
  const label = (i: { labelKey: string }) => ({ 'nav.customer': 'Харилцагч', 'nav.application': 'Хүсэлт', 'nav.blacklist': 'Хар жагсаалт', 'nav.loan': 'Зээл', 'nav.report': 'Тайлан', 'nav.settings': 'Тохиргоо' })[i.labelKey] ?? i.labelKey;
  it('filters the menu by label, case-insensitively, including children', () => {
    expect(searchMenu('жагс', menu, label).map((i) => i.id)).toEqual(['blacklist']);
    expect(searchMenu('ХҮС', menu, label).map((i) => i.id)).toEqual(['application']);
    expect(searchMenu('', menu, label).length).toBe(flattenMenu(menu).length);
    expect(searchMenu('zzz', menu, label)).toEqual([]);
  });
  it('treats digits as a contract number and builds the list URL', () => {
    expect(looksLikeContractNo('LA-2026-000123')).toBe(true);
    expect(looksLikeContractNo('Тайлан')).toBe(false);
    expect(contractSearchHref(' LA 2026/1 ')).toBe('/los/loan-application?q=LA%202026%2F1');
  });
});

describe('public and standalone paths', () => {
  it('/login (and below) is public; look-alikes are not', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/login/')).toBe(true);
    expect(isPublicPath('/loginx')).toBe(false);
    expect(isPublicPath('/')).toBe(false);
  });
  it('standalone pages are matched by whole path segment', () => {
    expect(isStandalonePath('/sign/abc', ['/sign'])).toBe(true);
    expect(isStandalonePath('/sign', ['/sign'])).toBe(true);
    expect(isStandalonePath('/signature', ['/sign'])).toBe(false);
  });
  it('the default standalone list is the public e-sign pages (FR-11.4) and nothing that needs a login', () => {
    for (const p of ['/sign/abc', '/verify/XYZ-1', '/sign', '/verify']) expect(isStandalonePath(p), p).toBe(true);
    for (const p of ['/', '/login', '/signature', '/verifyx', '/los/loan-application', '/merchant', '/settings/merchants', '/notifications']) expect(isStandalonePath(p), p).toBe(false);
  });
  it('the merchant portal has its own shell but still needs a login; staff merchant pages keep the staff shell', () => {
    for (const p of ['/merchant', '/merchant/leases', '/merchant/leases/new']) {
      expect(hasOwnShell(p), p).toBe(true);
      expect(isStandalonePath(p), p).toBe(false);
      expect(isPublicPath(p), p).toBe(false);
    }
    for (const p of ['/merchants', '/settings/merchants', '/los/pos-leases', '/']) expect(hasOwnShell(p), p).toBe(false);
  });
});
