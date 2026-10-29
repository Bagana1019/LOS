import { MENU, type MenuItem, type Permission } from '@los/contracts';

const matchesPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Нэвтрээгүй байхад нээлттэй, нэвтэрсэн бол нүүр рүү буцаадаг хуудас. */
export const PUBLIC_PATHS: readonly string[] = ['/login'];
export const isPublicPath = (pathname: string) => PUBLIC_PATHS.some((p) => matchesPrefix(pathname, p));

/**
 * Staff shell-гүй, нэвтрэлт шаардахгүй, өөрийн token-той нийтийн хуудас: зээлдэгчийн гарын үсгийн холбоос `/sign/<token>`,
 * гэрээ баталгаажуулах `/verify/<code>` (FR-11.4). Эдгээр дээр сесс сэргээх (`/auth/refresh`) дуудлага хийгдэхгүй, redirect хийгдэхгүй.
 * Шинэ нийтийн хуудас нэмэх бол prefix-ийг энд бич.
 */
export const STANDALONE_PREFIXES: readonly string[] = ['/sign', '/verify'];
export const isStandalonePath = (pathname: string, prefixes: readonly string[] = STANDALONE_PREFIXES) => prefixes.some((p) => matchesPrefix(pathname, p));

/**
 * Нэвтрэлт шаардах боловч staff-ийн sidebar/header-ийн оронд өөрийн shell-тэй хэсэг: мерчант POS портал (`/merchant/*`, docs/05 §12).
 * Хаалга (нэвтрээгүй бол /login) хэвээр, зөвхөн Frame зурагдахгүй.
 */
export const OWN_SHELL_PREFIXES: readonly string[] = ['/merchant'];
export const hasOwnShell = (pathname: string, prefixes: readonly string[] = OWN_SHELL_PREFIXES) => prefixes.some((p) => matchesPrefix(pathname, p));

/** Нэвтэрсний дараах `next` зам — зөвхөн ижил origin-ийн зам (open redirect-ээс сэргийлнэ). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  try {
    const base = 'http://los.local';
    const u = new URL(raw, base);
    // `/\t/evil.com`, `//evil.com`, `/\evil.com`-г URL parser өөр origin болгоно
    if (u.origin !== base || isPublicPath(u.pathname)) return '/';
    const out = `${u.pathname}${u.search}${u.hash}`;
    // `/.//evil.com` нь dot-segment-ийг задлаад `//evil.com` болдог — protocol-relative тул router гаднах руу гаргана
    return out.startsWith('//') || out.startsWith('/\\') ? '/' : out;
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

// Цэсэнд байхгүй ч эрх шаарддаг хуудаснууд (docs/02 BSA дэлгэц, docs/01 §2). Цэсний бусад хуудас contracts-ийн MENU-ээс гарна.
const EXTRA_ROUTES: readonly { href: string; permission: Permission }[] = [{ href: '/los/bsa', permission: 'bsa:review' }];
const ROUTE_PERMISSIONS = [...flattenMenu(MENU), ...EXTRA_ROUTES].map(({ href, permission }) => ({ href, permission }));

/** NFR-3. UX-ийн шалгалт: эцсийн эрхийг gateway ба сервис шалгана. Тодорхойгүй зам нээлттэй (нэвтэрсэн бол). */
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
