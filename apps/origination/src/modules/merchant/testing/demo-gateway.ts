import { GATEWAY_HEADERS } from '@los/contracts';
import { isProduction, PosConfigError, readIntegrationMode } from '../config/pos.config';

// DEMO ONLY (scripts/merchant-demo.ts): demo-г аюулгүй, тууштай ажиллуулах цэвэр туслахууд. Скрипт өөрөө top-level-д ажилладаг тул логикийг энд гаргаж тестлэнэ.

type Env = Record<string, string | undefined>;

/** Demo-г эхлүүлэхээс татгалзах шалтгаан (production / бодит интеграци / буруу INTEGRATION_MODE). Зөвшөөрвөл null. config-ийн `isProduction`/`readIntegrationMode`-тэй ижил нормчлол (trim + том жижиг үсэг үл ялгана). */
export function demoRefusal(env: Env = process.env): string | null {
  if (isProduction(env)) return 'REFUSED: merchant-demo is DEMO ONLY (in-memory data, fixed OTP, header-less login) and must not run with NODE_ENV=production.';
  try {
    if (readIntegrationMode(env) === 'real') return 'REFUSED: merchant-demo uses mock integrations only; unset INTEGRATION_MODE=real.';
  } catch (e) {
    if (e instanceof PosConfigError) return `REFUSED: ${e.message}`; // fail closed: ойлгомжгүй горимд demo асаахгүй
    throw e;
  }
  return null;
}

/** 127.0.0.0/8, ::1, localhost. `0.0.0.0` / `::` (бүх интерфэйс) нь loopback БИШ. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export interface HostPolicy { allowed: boolean; message: string | null }

/** DEMO_HOST loopback биш бол (нэвтрэлтгүй ADMIN persona-г сүлжээнд нээнэ) DEMO_ALLOW_REMOTE=1 заавал; зөвшөөрсөн ч чанга анхааруулга. */
export function hostPolicy(host: string, env: Env = process.env): HostPolicy {
  if (isLoopbackHost(host)) return { allowed: true, message: null };
  if (env.DEMO_ALLOW_REMOTE !== '1') {
    return { allowed: false, message: `REFUSED: DEMO_HOST=${host} is not a loopback address. The demo has NO authentication (anyone who can reach it can pick the lender ADMIN persona). Set DEMO_ALLOW_REMOTE=1 to bind it anyway.` };
  }
  return { allowed: true, message: `!!! WARNING: DEMO_HOST=${host} exposes the unauthenticated demo (ADMIN persona, settle APIs) beyond this machine (DEMO_ALLOW_REMOTE=1). Never do this on a shared or public network. !!!` };
}

const bracket = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

/**
 * Хэрэглэгчид хэвлэх/өгөх хост. Cookie нь хост-д (localhost ≠ 127.0.0.1) холбогддог тул вэб-ийн API суурь (apps/web/src/lib/api.ts: http://localhost:4000/api)-той ЯГ ТААРАХ ёстой:
 * loopback-д үргэлж `localhost` (вэб 127.0.0.1 дээр байвал 127.0.0.1); loopback биш бол өөрийн хост.
 */
export function displayHost(bindHost: string, webUrl: string): string {
  if (!isLoopbackHost(bindHost)) return bracket(bindHost);
  try {
    return new URL(webUrl).hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';
  } catch {
    return 'localhost';
  }
}

/** CORS зөвшөөрөх origin-ууд: вэб + түүний loopback ихэр (localhost ↔ 127.0.0.1, ижил порт). Өөр хост бол зөвхөн өөрийг нь. */
export function corsOrigins(webUrl: string): string[] {
  const u = new URL(webUrl);
  const origins = [u.origin];
  const twin = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname === '127.0.0.1' ? 'localhost' : null;
  if (twin) origins.push(`${u.protocol}//${twin}${u.port ? `:${u.port}` : ''}`);
  return origins;
}

export interface HeaderBag { headers: Record<string, string | string[] | undefined> }

/**
 * Gateway-ийн дүр: клиентийн ирүүлсэн gateway толгойг (x-user-id, x-org-id, x-roles, x-branch-id, x-merchant-id, x-store-id) ЯМАР Ч замд (том жижиг үсэг, угтвар үл хамаарна — Express
 * route нь том жижиг үсэг үл ялгадаг) УСТГАЖ, зөвхөн сонгосон persona-гийн толгойг тавина. Correlation id-г хэвээр үлдээнэ.
 */
export function applyDemoIdentity(req: HeaderBag, personaHeaders?: Record<string, string>): void {
  for (const name of Object.values(GATEWAY_HEADERS)) if (name !== GATEWAY_HEADERS.correlationId) delete req.headers[name];
  if (personaHeaders) for (const [k, v] of Object.entries(personaHeaders)) req.headers[k] = v;
}
