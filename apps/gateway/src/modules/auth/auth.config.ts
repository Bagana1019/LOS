export interface AuthConfig {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Дараалсан буруу нууц үгийн тоо — хэтэрвэл түр түгжинэ. */
  maxFailures: number;
  lockMinutes: number;
  /** Refresh/logout (cookie) хүсэлтийн Origin шалгалт; CORS-ийн зөвшөөрөгдсөн origin. */
  webOrigins: string[];
  cookieSecure: boolean;
}

const int = (v: string | undefined, d: number) => { const n = v === undefined ? d : Number(v); if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid numeric env value "${v}"`); return n; };

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be set and at least 32 characters (see .env.example)');
  return {
    jwtSecret,
    accessTtlSeconds: int(env.JWT_ACCESS_TTL_SECONDS, 900),
    refreshTtlSeconds: int(env.JWT_REFRESH_TTL_SECONDS, 8 * 3600), // ажлын өдөр
    maxFailures: int(env.LOGIN_MAX_FAILURES, 5),
    lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
    webOrigins: (env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: env.NODE_ENV === 'production',
  };
}
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
export const REFRESH_COOKIE = 'los_rt';
