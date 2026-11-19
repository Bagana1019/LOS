import { RequestMethod, type Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { permissionsFor, type Permission } from '@los/contracts';
import { CUSTOMER_CONTEXT_KEY, PERMISSIONS_KEY, PUBLIC_KEY, ROLES_KEY } from './guards';

/**
 * Маршрутын эрхийн тооллого (NFR-3): AppModule-ийг instantiate хийлгүй decorator metadata-аас handler бүрийн
 * зам + эрхийн тэмдэглэгээг цуглуулна. Тестэд gateway-ийн бодлоготой зөрөх, эрх зарлаагүй маршрутыг илрүүлэхэд ашиглана.
 */
export interface RouteInfo {
  method: string;
  path: string;
  handler: string;
  isPublic: boolean;
  roles: readonly string[];
  permissions: readonly Permission[];
  customerContext: boolean;
  guards: readonly string[];
}

/** Gateway-ийн `ROUTE_POLICIES`-ийн бүтэц (nest-common нь gateway-аас хамааралгүй байх ёстой тул энд бүтцээр нь тодорхойлов). */
export interface GatewayPolicy { service: string; prefix: string; writeOnly?: boolean; permission: Permission }

export interface PolicyDrift { policy: GatewayPolicy; route?: RouteInfo; reason: 'NO_MATCHING_ROUTE' | 'SERVICE_DOES_NOT_ENFORCE' }

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GLOBAL_PREFIX = '/api';

type DynamicModuleLike = { module?: Type; controllers?: Type[]; imports?: unknown[]; forwardRef?: () => unknown };
type ModuleRef = Type | DynamicModuleLike | Promise<unknown> | undefined;

function joinPath(...parts: (string | undefined)[]): string {
  const segments = parts.map((p) => (p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${segments.join('/')}`;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [''];
  return Array.isArray(v) ? v : [v];
}

async function collectControllers(root: ModuleRef, seen: Set<unknown>, out: Set<Type>): Promise<void> {
  // @nestjs/config v3 `ConfigModule.forRoot()` нь Promise<DynamicModule> буцаана — алгасвал fail-open тул await хийнэ
  const resolved = (root instanceof Promise ? await root : root) as Exclude<ModuleRef, Promise<unknown>>;
  if (!resolved || seen.has(resolved)) return;
  seen.add(resolved);
  if (typeof resolved === 'object' && typeof resolved.forwardRef === 'function') {
    await collectControllers(resolved.forwardRef() as ModuleRef, seen, out);
    return;
  }
  const cls = typeof resolved === 'function' ? resolved : resolved.module;
  const dynamic = typeof resolved === 'object' ? resolved : undefined;
  const controllers = [...((cls && Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls)) ?? []), ...(dynamic?.controllers ?? [])] as Type[];
  const imports = [...((cls && Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls)) ?? []), ...(dynamic?.imports ?? [])] as ModuleRef[];
  controllers.forEach((c) => out.add(c));
  for (const m of imports) await collectControllers(m, seen, out);
}

/** `Reflector.getAllAndOverride`-тэй ижил: handler-ийн утга class-ынхыг дарна. */
function meta<T>(key: string, handler: object, cls: object): T | undefined {
  return (Reflect.getMetadata(key, handler) as T | undefined) ?? (Reflect.getMetadata(key, cls) as T | undefined);
}

function guardNames(handler: object, cls: object): string[] {
  const list = [...((Reflect.getMetadata(GUARDS_METADATA, cls) ?? []) as unknown[]), ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[])];
  return list.map((g) => (typeof g === 'function' ? g.name : (g as object).constructor.name));
}

/**
 * `@Roles` + module-local дүрийн түлхүүрүүд (жишээ `aml:roles`, `blacklist:roles`, `bsa:roles`) — тус бүр handler > class.
 * Module-local түлхүүрийг уншигч нь тухайн модулийн guard тул guard-гүй маршрутад тоолохгүй (guard мартсан бол `@Roles` хоосон metadata л).
 */
function rolesOf(handler: object, cls: object, roleKeys: readonly string[], guards: readonly string[]): string[] {
  const keys = guards.length > 0 ? [ROLES_KEY, ...roleKeys] : [ROLES_KEY];
  return [...new Set(keys.flatMap((k) => meta<string[]>(k, handler, cls) ?? []))];
}

/** Nest-ийн scanner шиг base controller-оос удамшсан handler-уудыг ч оруулна. */
function methodNames(proto: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    Object.getOwnPropertyNames(p).forEach((n) => names.add(n));
  }
  return [...names];
}

function routesOfController(ctrl: Type, roleKeys: readonly string[]): RouteInfo[] {
  const proto = ctrl.prototype as Record<string, unknown>;
  const ctrlPaths = asArray(Reflect.getMetadata(PATH_METADATA, ctrl));
  return methodNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
    if (methodCode === undefined || handlerPath === undefined) return [];
    const guards = guardNames(handler, ctrl);
    const base = {
      method: RequestMethod[methodCode],
      handler: `${ctrl.name}.${name}`,
      isPublic: meta<boolean>(PUBLIC_KEY, handler, ctrl) === true,
      roles: rolesOf(handler, ctrl, roleKeys, guards),
      permissions: meta<Permission[]>(PERMISSIONS_KEY, handler, ctrl) ?? [],
      customerContext: meta<boolean>(CUSTOMER_CONTEXT_KEY, handler, ctrl) === true,
      guards,
    };
    return ctrlPaths.flatMap((cp) => asArray(handlerPath).map((hp) => ({ ...base, path: joinPath(GLOBAL_PREFIX, cp, hp) })));
  });
}

/**
 * Модулийн мод (imports, dynamic module, forwardRef) дахь бүх controller-ийн маршрут. Зам нь сервисийн дотоод `/api/...`.
 * `extraRoleKeys`: өөрийн guard + `@Roles` decorator-той модулиудын metadata түлхүүр — `roles`-д нэгтгэгдэнэ.
 */
export async function collectRoutes(rootModule: Type, extraRoleKeys: readonly string[] = []): Promise<RouteInfo[]> {
  const controllers = new Set<Type>();
  await collectControllers(rootModule, new Set(), controllers);
  return [...controllers].flatMap((c) => routesOfController(c, extraRoleKeys)).sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
}

export function routeKey(r: Pick<RouteInfo, 'method' | 'path'>): string {
  return `${r.method} ${r.path}`;
}

/**
 * `@Public`, `@Roles`, `@Permissions` аль нь ч байхгүй маршрут — "нэвтэрсэн бол хэн ч".
 * `@UseGuards` дангаараа тооцогдохгүй: custom guard `@Roles`-гүй үед fail-open байж болно (жишээ AmlAccessGuard).
 */
export function findUndeclaredRoutes(routes: readonly RouteInfo[]): RouteInfo[] {
  return routes.filter((r) => !r.isPublic && r.roles.length === 0 && r.permissions.length === 0);
}

/** `@Public` маршрут ContextAuthGuard-ийг (internal token-ийг ч) бүрэн алгасна — тест бүр жагсаалтаар нь баталгаажуулна. */
export function findPublicRoutes(routes: readonly RouteInfo[]): RouteInfo[] {
  return routes.filter((r) => r.isPublic);
}

/** Маршрут бодлогын эрхийг өөрөө шаардаж байна уу: `@Permissions`-д байгаа, эсвэл `@Roles`-ийн БҮХ дүр уг эрхтэй. */
function enforces(route: RouteInfo, permission: Permission): boolean {
  if (route.isPublic) return false; // @Public guard-ийг бүрэн алгасна — class-аас удамшсан @Permissions хүчингүй
  if (route.permissions.includes(permission)) return true;
  return route.roles.length > 0 && route.roles.every((role) => permissionsFor([role]).includes(permission));
}

const underPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Gateway-ийн бодлого (`/api/<service>/x`) ↔ сервисийн маршрут (`/api/x`) зөрүү:
 * - бодлогод тохирох маршрут огт алга (хуучирсан угтвар),
 * - тохирох маршрут уг эрхийг сервис дотор шаардаагүй (gateway-г тойрвол эрхгүй нэвтэрнэ — defense in depth алдагдана).
 * `internalOnlyPrefixes`: gateway-ийн `INTERNAL_ONLY_PREFIXES` — ажилтны proxy-д хүрэхгүй (404) тул бодлогоос хамаарахгүй.
 */
export function findPolicyDrift(service: string, routes: readonly RouteInfo[], policies: readonly GatewayPolicy[], internalOnlyPrefixes: readonly string[] = []): PolicyDrift[] {
  const toServicePath = (gatewayPath: string) => gatewayPath.toLowerCase().replace(`/api/${service}`, GLOBAL_PREFIX);
  const internal = internalOnlyPrefixes.filter((p) => p.toLowerCase().startsWith(`/api/${service}/`)).map(toServicePath);
  return policies.filter((p) => p.service === service).flatMap((policy): PolicyDrift[] => {
    const prefix = toServicePath(policy.prefix);
    const matched = routes.filter((r) => {
      const path = r.path.toLowerCase();
      return underPrefix(path, prefix) && !internal.some((x) => underPrefix(path, x)) && !(policy.writeOnly && READ_METHODS.has(r.method));
    });
    if (matched.length === 0) return [{ policy, reason: 'NO_MATCHING_ROUTE' }];
    return matched
      .filter((r) => !enforces(r, policy.permission))
      .map((route) => ({ policy, route, reason: 'SERVICE_DOES_NOT_ENFORCE' as const }));
  });
}
