// FR-11.4 E-sign тохиргоо (dms). Env-ээс zod-оор унших; dev-д боломжийн default, production-д нууц/URL заавал тодорхой.
// Алдааны мессеж env-ийн НЭР-ийг л хэлнэ; утгыг хэзээ ч агуулахгүй (нууц байж болно).
// INTEGRATION_MODE / MOCK_ESIGN_* / TRIDUM_* / MONPASS_* → integrations/esign/integrations.config.ts; Нууц талбарын түлхүүр (DATA_ENCRYPTION_KEY) → @los/database.
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Хоосон/зөвхөн зайтай утгыг "тохируулаагүй" гэж үзнэ (docker-compose `VAR=`) */
export function envValue(env: EnvSource, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}
export const isProduction = (env: EnvSource): boolean => env.NODE_ENV === 'production';

/** DI token: `EsignConfig` */
export const ESIGN_CONFIG = Symbol('ESIGN_CONFIG');

export interface EsignConfig {
  /** Вэб origin (зээлдэгчийн линк, QR-ийн verify хаяг). Төгсгөлийн `/`-гүй */
  publicBaseUrl: string;
  /** Provider webhook дуудах public gateway-ийн суурь URL. Төгсгөлийн `/`-гүй */
  callbackBaseUrl: string;
  linkTtlHours: number;
  /** Provider session-ий хугацаа (сек); линкийн үлдсэн хугацаанаас хэтрэхгүй */
  sessionTtlSeconds: number;
  maxAttempts: number;
  /** Sweeper-ийн интервал (сек); 0 = унтраасан */
  sweepIntervalSec: number;
  /** FINALIZING төлөвт энэ хугацаанаас илүү гацсан хүсэлтийг sweeper дахин оролдоно */
  finalizingStaleSec: number;
  /** Гарын үсэг зурагдсанаас хойш зээлдэгч өөрийн хувийг линкээр татаж болох хоног (линкийн хугацаа дууссан ч) */
  signedCopyTtlDays: number;
}

export class EsignConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EsignConfigError';
  }
}

export const DEFAULT_PUBLIC_BASE_URL = 'http://localhost:3000';
export const DEFAULT_CALLBACK_BASE_URL = 'http://localhost:4000/api';

const ENV_NAMES = {
  publicBaseUrl: 'ESIGN_PUBLIC_BASE_URL',
  callbackBaseUrl: 'ESIGN_CALLBACK_BASE_URL',
  linkTtlHours: 'ESIGN_LINK_TTL_HOURS',
  sessionTtlSeconds: 'ESIGN_SESSION_TTL_SECONDS',
  maxAttempts: 'ESIGN_MAX_ATTEMPTS',
  sweepIntervalSec: 'ESIGN_SWEEP_INTERVAL_SEC',
  finalizingStaleSec: 'ESIGN_FINALIZING_STALE_SEC',
  signedCopyTtlDays: 'ESIGN_SIGNED_COPY_TTL_DAYS',
} as const satisfies Record<keyof EsignConfig, string>;

/** ConfigService-ээс уншигдах бүх нэр (+ NODE_ENV) */
export const ESIGN_ENV_NAMES: readonly string[] = [...Object.values(ENV_NAMES), 'NODE_ENV'];

function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

const baseUrl = z
  .string()
  .refine(isHttpBaseUrl)
  .transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
  publicBaseUrl: baseUrl,
  callbackBaseUrl: baseUrl,
  linkTtlHours: z.coerce.number().int().min(1).max(168),
  sessionTtlSeconds: z.coerce.number().int().min(30).max(3600),
  maxAttempts: z.coerce.number().int().min(1).max(10),
  sweepIntervalSec: z.coerce.number().int().min(0).max(3600),
  finalizingStaleSec: z.coerce.number().int().min(30).max(86_400),
  signedCopyTtlDays: z.coerce.number().int().min(1).max(365),
});

const DEFAULTS = {
  publicBaseUrl: DEFAULT_PUBLIC_BASE_URL,
  callbackBaseUrl: DEFAULT_CALLBACK_BASE_URL,
  linkTtlHours: '72',
  sessionTtlSeconds: '300',
  maxAttempts: '3',
  sweepIntervalSec: '60',
  finalizingStaleSec: '300',
  signedCopyTtlDays: '30',
} as const satisfies Record<keyof EsignConfig, string>;

const PRODUCTION_REQUIRED = [ENV_NAMES.publicBaseUrl, ENV_NAMES.callbackBaseUrl] as const;

export function loadEsignConfig(env: EnvSource = process.env): EsignConfig {
  const production = isProduction(env);
  if (production) {
    const missing = PRODUCTION_REQUIRED.filter((name) => envValue(env, name) === undefined);
    if (missing.length > 0) throw new EsignConfigError(`Missing ${missing.join(', ')}: required when NODE_ENV=production`);
  }

  const raw = Object.fromEntries((Object.keys(ENV_NAMES) as Array<keyof EsignConfig>).map((key) => [key, envValue(env, ENV_NAMES[key]) ?? DEFAULTS[key]]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => ENV_NAMES[issue.path[0] as keyof EsignConfig]))];
    throw new EsignConfigError(`Invalid ${names.join(', ')}`);
  }
  const config = parsed.data;
  if (production) {
    const insecure = (['publicBaseUrl', 'callbackBaseUrl'] as const).filter((key) => !config[key].startsWith('https://')).map((key) => ENV_NAMES[key]);
    if (insecure.length > 0) throw new EsignConfigError(`${insecure.join(', ')} must use https when NODE_ENV=production`);
  }
  return config;
}

/** `@nestjs/config`-ийн ConfigService-ээс (`.env` файл ачаалсан) эх сурвалж болгон ашиглах env-ийн дүрс */
export function envFromConfigService(config: ConfigService): EnvSource {
  return Object.fromEntries(ESIGN_ENV_NAMES.map((name) => [name, config.get<string>(name)]));
}

/** ConfigService байвал түүнээс, үгүй бол process.env-ээс. Апп босох үед уншигдана (буруу тохиргоо → эхлэхэд алдаа) */
export const esignConfigProvider: FactoryProvider<EsignConfig> = {
  provide: ESIGN_CONFIG,
  inject: [{ token: ConfigService, optional: true }],
  useFactory: (config?: ConfigService) => loadEsignConfig(config ? envFromConfigService(config) : process.env),
};
