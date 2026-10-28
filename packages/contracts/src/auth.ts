import { z } from 'zod';
import { UserRole } from './enums';

// ── Gateway → дотоод сервис: итгэмжлэгдсэн толгойнууд (CLAUDE.md §3.2.9; X-Org-Id, X-Customer-Id нэмэгдсэн — DECISIONS.md) ──
export const CTX_HEADERS = {
  userId: 'x-user-id',
  roles: 'x-roles',
  branchId: 'x-branch-id',
  orgId: 'x-org-id',
  correlationId: 'x-correlation-id',
  /** Зөвхөн зээлдэгчийн self-service BFF (role=CUSTOMER). */
  customerId: 'x-customer-id',
  /** INTERNAL_AUTH_SECRET тохируулсан үед gateway нэмж, сервис шалгана (mTLS-ийн оронд хөгжүүлэлт/staging-д). */
  internalToken: 'x-internal-token',
} as const;

export const RequestContext = z.object({
  userId: z.string().nullable(),
  roles: z.array(z.string()),
  branchId: z.string().nullable(),
  orgId: z.string(),
  customerId: z.string().nullable(),
  correlationId: z.string(),
});
export type RequestContext = z.infer<typeof RequestContext>;

// ── Эрх (RBAC). docs/01 §3 дүрийн хүснэгт. Сервис `@Permissions(...)`-ээр, UI цэсээр хэрэглэнэ. ──
export const Permission = [
  'customer:read', 'customer:write',
  'application:read', 'application:write', 'application:submit',
  'approval:vote',
  'disbursement:request', 'disbursement:approve',
  'bsa:review',
  'blacklist:read', 'blacklist:manage',
  'report:read',
  'settings:manage',
  'audit:read',
  'user:manage',
] as const;
export type Permission = typeof Permission[number];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  // ЗЭЗ: хүсэлт үүсгэх/бүрдүүлэх/илгээх, олголтын хүсэлт, BSA-ийн сэжигтэй гүйлгээ. Харах хүрээ: зөвхөн өөрийн хүсэлт.
  OFFICER: ['customer:read', 'customer:write', 'application:read', 'application:write', 'application:submit', 'disbursement:request', 'bsa:review', 'blacklist:read', 'report:read'],
  // Салбарын захирал: салбарын хүсэлтийг харж, бага дүнгийн түвшинд батлана.
  BRANCH_MANAGER: ['customer:read', 'application:read', 'approval:vote', 'blacklist:read', 'report:read'],
  // Батлагч: Батлах/Буцаах, олголт зөвшөөрөх; нөхцөл засах эрхгүй (FR-10.3).
  APPROVER: ['customer:read', 'application:read', 'approval:vote', 'disbursement:approve', 'blacklist:read', 'report:read'],
  ADMIN: ['customer:read', 'application:read', 'blacklist:read', 'blacklist:manage', 'report:read', 'settings:manage', 'audit:read', 'user:manage'],
};

export function permissionsFor(roles: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r as UserRole] ?? []) out.add(p);
  return [...out];
}
export const hasPermission = (roles: readonly string[], p: Permission) => permissionsFor(roles).includes(p);

// ── Өгөгдлийн хүрээ (NFR-3): ЗЭЗ=OWN (officer_id=userId), Салбарын захирал=BRANCH (branch_id), Батлагч/Админ=ALL ──
export const DataScope = ['NONE', 'OWN', 'BRANCH', 'ALL'] as const;
export type DataScope = typeof DataScope[number];
const SCOPE_RANK: Record<DataScope, number> = { NONE: 0, OWN: 1, BRANCH: 2, ALL: 3 };
const ROLE_SCOPE: Record<UserRole, DataScope> = { OFFICER: 'OWN', BRANCH_MANAGER: 'BRANCH', APPROVER: 'ALL', ADMIN: 'ALL' };
export function resolveDataScope(roles: readonly string[]): DataScope {
  let best: DataScope = 'NONE';
  for (const r of roles) { const s = ROLE_SCOPE[r as UserRole]; if (s && SCOPE_RANK[s] > SCOPE_RANK[best]) best = s; }
  return best;
}

// ── Цэс (docs/01 §2.1). Цорын ганц эх сурвалж: gateway `GET /auth/me`-д тооцоолж өгнө, web зөвхөн харуулна. ──
export interface MenuItem { id: string; labelKey: string; href: string; permission: Permission; children?: MenuItem[] }
export const MENU: readonly MenuItem[] = [
  { id: 'customer', labelKey: 'nav.customer', href: '/customer', permission: 'customer:read' },
  { id: 'application', labelKey: 'nav.application', href: '/los/loan-application', permission: 'application:read', children: [
    { id: 'blacklist', labelKey: 'nav.blacklist', href: '/los/loan-application/blacklist', permission: 'blacklist:read' },
  ] },
  { id: 'loan', labelKey: 'nav.loan', href: '/los/loan/list', permission: 'application:read' },
  { id: 'report', labelKey: 'nav.report', href: '/los/report', permission: 'report:read' },
  { id: 'settings', labelKey: 'nav.settings', href: '/settings', permission: 'settings:manage' },
];
export function menuFor(roles: readonly string[]): MenuItem[] {
  const perms = new Set(permissionsFor(roles));
  const walk = (items: readonly MenuItem[]): MenuItem[] =>
    items.filter((i) => perms.has(i.permission)).map((i) => ({ ...i, ...(i.children ? { children: walk(i.children) } : {}) }));
  return walk(MENU);
}
const MenuItemSchema: z.ZodType<MenuItem> = z.lazy(() => z.object({
  id: z.string(), labelKey: z.string(), href: z.string(), permission: z.enum(Permission), children: z.array(MenuItemSchema).optional(),
}));

// ── Нэвтрэлт (gateway /api/auth/*) ──
export const LoginRequest = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof LoginRequest>;
export const SessionUser = z.object({
  id: z.string(), orgId: z.string(), branchId: z.string().nullable(), username: z.string(), fullName: z.string(), roles: z.array(z.enum(UserRole)),
});
export type SessionUser = z.infer<typeof SessionUser>;
/** Refresh token нь httpOnly cookie-д (`los_rt`); body-д зөвхөн access token. */
export const AuthResponse = z.object({ accessToken: z.string(), expiresIn: z.number().int(), user: SessionUser, permissions: z.array(z.enum(Permission)), menu: z.array(MenuItemSchema) });
export type AuthResponse = z.infer<typeof AuthResponse>;
export const MeResponse = AuthResponse.omit({ accessToken: true, expiresIn: true });
export type MeResponse = z.infer<typeof MeResponse>;
/** Access token (JWT) claim. */
export const AccessTokenClaims = z.object({
  sub: z.string(), org: z.string(), br: z.string().nullable(), roles: z.array(z.enum(UserRole)), sid: z.string(), iat: z.number(), exp: z.number(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

// ── Аудит (NFR-4, FR-13.5): docs/03 audit_log ──
export const AuditEntry = z.object({
  entity: z.string(), entityId: z.string(), action: z.string(), actorId: z.string().nullable(), at: z.string().datetime(),
  beforeJson: z.unknown().nullable(), afterJson: z.unknown().nullable(), applicationId: z.string().nullable(), correlationId: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
