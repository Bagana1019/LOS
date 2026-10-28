import { z } from 'zod';

export const PORTAL_CONFIG = Symbol('PORTAL_CONFIG');

export interface PortalConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  integrationMode: 'mock' | 'real';
  store: { kind: 'memory' | 'redis'; redisUrl?: string };
  originationUrl: string;
  internalTimeoutMs: number;
  internalMaxContractBytes: number;
  auth: {
    jwtSecret: string;
    hashSecret: string;
    issuer: string;
    audience: string;
    accessTtlSec: number;
    refreshTtlSec: number;
    otpTtlSec: number;
    otpResendSec: number;
    otpMaxAttempts: number;
    otpRequestsPerHour: number;
    otpRequestsPerHourPerIp: number;
    mockOtpCode?: string;
  };
  cors: { origins: string[] };
  trustProxy: number;
  timezone: string;
  mock: { paymentConfirmMs: number };
}

// Dev/test-д л ашиглагдах тогтмол түлхүүр. Production-д тохируулаагүй бол эхлэхгүй (доорх шалгалт).
const DEV_JWT_SECRET = 'dev-only-portal-jwt-secret-change-me!!';
const DEV_HASH_SECRET = 'dev-only-portal-hash-secret-change-me!';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORTAL_BFF_PORT: z.coerce.number().int().min(1).max(65535).default(4007),
  INTEGRATION_MODE: z.enum(['mock', 'real']).default('mock'),
  PORTAL_STORE: z.enum(['memory', 'redis']).optional(),
  REDIS_URL: z.string().min(1).optional(),
  ORIGINATION_URL: z.string().url().default('http://localhost:4001'),
  PORTAL_INTERNAL_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  PORTAL_MAX_CONTRACT_BYTES: z.coerce.number().int().min(1024).default(25 * 1024 * 1024),
  PORTAL_JWT_SECRET: z.string().min(32).optional(),
  PORTAL_HASH_SECRET: z.string().min(32).optional(),
  PORTAL_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(600),
  PORTAL_REFRESH_TTL_SEC: z.coerce.number().int().min(3600).max(31_536_000).default(2_592_000),
  PORTAL_OTP_TTL_SEC: z.coerce.number().int().min(60).max(900).default(300),
  PORTAL_OTP_RESEND_SEC: z.coerce.number().int().min(0).max(600).default(60),
  PORTAL_OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  PORTAL_OTP_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).default(5),
  PORTAL_OTP_REQUESTS_PER_HOUR_PER_IP: z.coerce.number().int().min(1).default(20),
  PORTAL_MOCK_OTP_CODE: z.string().regex(/^\d{6}$/).optional(),
  PORTAL_CORS_ORIGINS: z.string().default(''),
  PORTAL_TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  PORTAL_TIMEZONE: z.string().default('Asia/Ulaanbaatar'),
  PORTAL_MOCK_PAYMENT_CONFIRM_MS: z.coerce.number().int().min(0).default(3000),
});

export class ConfigError extends Error {}

/** Орчны хувьсагчаас тохиргоо үүсгэж, аюултай хослолыг эхлэхээс өмнө татгалзана (fail fast). */
export function loadConfig(env: Record<string, string | undefined> = process.env): PortalConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid portal-bff configuration: ${detail}`);
  }
  const e = parsed.data;
  const prod = e.NODE_ENV === 'production';
  const storeKind = e.PORTAL_STORE ?? (prod || e.REDIS_URL ? 'redis' : 'memory');

  const problems: string[] = [];
  if (storeKind === 'redis' && !e.REDIS_URL) problems.push('REDIS_URL is required when PORTAL_STORE=redis');
  if (prod) {
    if (!e.PORTAL_JWT_SECRET) problems.push('PORTAL_JWT_SECRET is required in production');
    if (!e.PORTAL_HASH_SECRET) problems.push('PORTAL_HASH_SECRET is required in production');
    if (e.PORTAL_JWT_SECRET && e.PORTAL_JWT_SECRET === e.PORTAL_HASH_SECRET) {
      problems.push('PORTAL_JWT_SECRET and PORTAL_HASH_SECRET must differ');
    }
    if (e.INTEGRATION_MODE !== 'real') problems.push('INTEGRATION_MODE must be "real" in production');
    if (storeKind !== 'redis') problems.push('PORTAL_STORE must be "redis" in production (multi-instance)');
    if (e.PORTAL_MOCK_OTP_CODE) problems.push('PORTAL_MOCK_OTP_CODE must not be set in production');
  }
  const origins = e.PORTAL_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.includes('*')) problems.push('PORTAL_CORS_ORIGINS must not contain "*"');
  if (prod && origins.some((o) => !o.startsWith('https://'))) problems.push('PORTAL_CORS_ORIGINS must be https in production');
  if (problems.length) throw new ConfigError(`Invalid portal-bff configuration: ${problems.join('; ')}`);

  return {
    env: e.NODE_ENV,
    port: e.PORTAL_BFF_PORT,
    integrationMode: e.INTEGRATION_MODE,
    store: { kind: storeKind, redisUrl: e.REDIS_URL },
    originationUrl: e.ORIGINATION_URL.replace(/\/+$/, ''),
    internalTimeoutMs: e.PORTAL_INTERNAL_TIMEOUT_MS,
    internalMaxContractBytes: e.PORTAL_MAX_CONTRACT_BYTES,
    auth: {
      jwtSecret: e.PORTAL_JWT_SECRET ?? DEV_JWT_SECRET,
      hashSecret: e.PORTAL_HASH_SECRET ?? DEV_HASH_SECRET,
      issuer: 'los-portal-bff',
      audience: 'los-portal-customer',
      accessTtlSec: e.PORTAL_ACCESS_TTL_SEC,
      refreshTtlSec: e.PORTAL_REFRESH_TTL_SEC,
      otpTtlSec: e.PORTAL_OTP_TTL_SEC,
      otpResendSec: e.PORTAL_OTP_RESEND_SEC,
      otpMaxAttempts: e.PORTAL_OTP_MAX_ATTEMPTS,
      otpRequestsPerHour: e.PORTAL_OTP_REQUESTS_PER_HOUR,
      otpRequestsPerHourPerIp: e.PORTAL_OTP_REQUESTS_PER_HOUR_PER_IP,
      mockOtpCode: e.PORTAL_MOCK_OTP_CODE,
    },
    cors: { origins },
    trustProxy: e.PORTAL_TRUST_PROXY,
    timezone: e.PORTAL_TIMEZONE,
    mock: { paymentConfirmMs: e.PORTAL_MOCK_PAYMENT_CONFIRM_MS },
  };
}
