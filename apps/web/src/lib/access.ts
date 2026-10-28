import { MENU, type MenuItem, type Permission } from '@los/contracts';

/** Нэвтрээгүй байхад нээлттэй хуудас. */
export const PUBLIC_PATHS: readonly string[] = ['/login'];
export const isPublicPath = (pathname: string) => PUBLIC_PATHS.includes(pathname);

/** Нэвтэрсний дараах `next` зам — зөвхөн ижил origin-ийн зам (open redirect-ээс сэргийлнэ). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  try {
    const base = 'http://los.local';
    const u = new URL(raw, base);
    // `/\t/evil.com`, `//evil.com`, `/\evil.com`-г URL parser өөр origin болгоно
    if (u.origin !== base || isPublicPath(u.pathname)) return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}

export function flattenMenu(menu: readonly MenuItem[]): MenuItem[] {
  return menu.flatMap((i) => [i, ...flattenMenu(i.children ?? [])]);
}

/** Pathname-д хамгийн урт prefix-ээр таарсан цэсийн href (sidebar-ын идэвхтэй мөр). `/` зөвхөн яг таарвал. */
export function activeHref(pathname: string, menu: readonly MenuItem[]): string | null {
  let best: string | null = null;
  for (const { href } of flattenMenu(menu)) {
    if ((pathname === href || pathname.startsWith(`${href}/`)) && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

// Цэсэнд байхгүй ч эрх шаарддаг хуудаснууд (docs/01 §2). Цэсний бусад хуудас contracts-ийн MENU-ээс гарна.
const EXTRA_ROUTES: readonly { href: string; permission: Permission }[] = [{ href: '/los/bsa', permission: 'bsa:review' }];
const ROUTE_PERMISSIONS = [...flattenMenu(MENU), ...EXTRA_ROUTES].map(({ href, permission }) => ({ href, permission }));

/** UX-ийн шалгалт: эцсийн эрхийг gateway ба сервис шалгана. Тодорхойгүй зам нээлттэй (нэвтэрсэн бол). */
export function requiredPermission(pathname: string): Permission | null {
  let best: { href: string; permission: Permission } | null = null;
  for (const r of ROUTE_PERMISSIONS) {
    if ((pathname === r.href || pathname.startsWith(`${r.href}/`)) && (best === null || r.href.length > best.href.length)) best = r;
  }
  return best?.permission ?? null;
}
export function canAccess(pathname: string, permissions: readonly Permission[]): boolean {
  const need = requiredPermission(pathname);
  return need === null || permissions.includes(need);
}

/** Нэгдсэн хайлт (FR-1.4): цэсийн нэрээр шүүнэ. */
export function searchMenu(query: string, menu: readonly MenuItem[], label: (item: MenuItem) => string): MenuItem[] {
  const q = query.trim().toLocaleLowerCase('mn');
  return flattenMenu(menu).filter((i) => q === '' || label(i).toLocaleLowerCase('mn').includes(q));
}
/** Тоо агуулсан бол гэрээний дугаар гэж үзнэ (формат тохиргооны `contract_number_template`-ээс — M2-д нарийсна). */
export const looksLikeContractNo = (query: string) => /\d/.test(query);
export const contractSearchHref = (query: string) => `/los/loan-application?q=${encodeURIComponent(query.trim())}`;
