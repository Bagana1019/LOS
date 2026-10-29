import type { Permission } from '@los/contracts';

/**
 * Gateway-ийн ТОВЧ эрхийн шалгалт (defense in depth). Эцсийн шалгалт сервис дотор (`@Permissions`, scopeWhere) хийгдэнэ —
 * энд зөвхөн илт зөвшөөрөлгүй дуудлагыг эхэнд нь таслана. Олдохгүй бол нэвтэрсэн хэрэглэгчид нээлттэй.
 */
export interface RoutePolicy { service: string; prefix: string; writeOnly?: boolean; permission: Permission }

export const ROUTE_POLICIES: readonly RoutePolicy[] = [
  { service: 'origination', prefix: '/api/origination/settings', writeOnly: true, permission: 'settings:manage' },
  { service: 'origination', prefix: '/api/origination/blacklist', writeOnly: true, permission: 'blacklist:manage' },
  { service: 'origination', prefix: '/api/origination/products', writeOnly: true, permission: 'settings:manage' },
  { service: 'origination', prefix: '/api/origination/approval-levels', writeOnly: true, permission: 'settings:manage' },
  { service: 'origination', prefix: '/api/origination/loan-terms/pricing/tiers', writeOnly: true, permission: 'settings:manage' }, // FR-5.5
  { service: 'scoring', prefix: '/api/scoring/sosco/models', writeOnly: true, permission: 'settings:manage' },
  { service: 'scoring', prefix: '/api/scoring/bsa/categories', writeOnly: true, permission: 'settings:manage' },
  { service: 'scoring', prefix: '/api/scoring/bsa/rules', writeOnly: true, permission: 'settings:manage' },
  { service: 'valuation', prefix: '/api/valuation/base-prices', writeOnly: true, permission: 'settings:manage' },
  { service: 'valuation', prefix: '/api/valuation/haircuts', writeOnly: true, permission: 'settings:manage' },
];
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiredPermission(method: string, path: string): Permission | null {
  const p = path.toLowerCase();
  for (const r of ROUTE_POLICIES) {
    if ((p === r.prefix || p.startsWith(`${r.prefix}/`)) && !(r.writeOnly && READ.has(method.toUpperCase()))) return r.permission;
  }
  return null;
}
