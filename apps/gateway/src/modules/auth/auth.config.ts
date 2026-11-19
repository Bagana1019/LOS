export interface AuthConfig {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Дараалсан буруу нууц үгийн тоо — хэтэрвэл түр түгжинэ. */
  maxFailures: number;
  lockMinutes: number;
  /** M7: (хэрэглэгчийн нэр, IP) хосын амжилтгүй оролдлогын хязгаар цонхонд — LOGIN_RATE_LIMIT / LOGIN_RATE_WINDOW_SECONDS. */
  loginFailureLimit: number;
  loginFailureWindowSeconds: number;
  /** Refresh/logout (cookie) хүсэлтийн Origin шалгалт; CORS-ийн зөвшөөрөгдсөн origin. */
  webOrigins: string[];
  cookieSecure: boolean;
}

const int = (v: string | undefined, d: number) => { const n = v === undefined ? d : Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid numeric env value "${v}"`); return n; };

/** M7: нэг IP-ээс минутад нэвтрэх оролдлогын нийт дээд хязгаар (password spraying) — LOGIN_IP_RATE_LIMIT, анхдагч 100. Хүсэлт бүрт уншина. */
export const loginIpLimit = (env: NodeJS.ProcessEnv = process.env): number => int(env.LOGIN_IP_RATE_LIMIT, 100);

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  loginIpLimit(env); // эхлэхэд буруу утгыг илрүүлнэ
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be set and at least 32 characters (see .env.example)');
  return {
    jwtSecret,
    accessTtlSeconds: int(env.JWT_ACCESS_TTL_SECONDS, 900),
    refreshTtlSeconds: int(env.JWT_REFRESH_TTL_SECONDS, 8 * 3600), // ажлын өдөр
    maxFailures: int(env.LOGIN_MAX_FAILURES, 5),
    lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
    loginFailureLimit: int(env.LOGIN_RATE_LIMIT, 10),
    loginFailureWindowSeconds: int(env.LOGIN_RATE_WINDOW_SECONDS, 60),
    webOrigins: (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: env.NODE_ENV === 'production',
  };
}
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
export const REFRESH_COOKIE = 'los_rt';
