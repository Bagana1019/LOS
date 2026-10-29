// POS модулийн тохиргоо (docs/05 §5 POS-BR-8, §11). Бүх утга env-ээс, анхдагчтай; BR босго энд биш — policy/plan-аас.

export type IntegrationMode = 'mock' | 'real';

/** DI token: `@Inject(POS_CONFIG)`. */
export const POS_CONFIG = Symbol('POS_CONFIG');

export interface PosConfig {
  nodeEnv: string;
  integrationMode: IntegrationMode;
  /** DRAFT лизингийн хүчинтэй хугацаа (минут) */
  draftTtlMinutes: number;
  /** REFERRED лизингийн хянах хугацаа (цаг) */
  referralTtlHours: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendSeconds: number;
  otpMaxSends: number;
  otpSecret: string;
  /** kyc үйлчилгээний хаяг (real горим) */
  kycBaseUrl: string;
}

export class PosConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PosConfigError';
  }
}

/** DEV ЗОРИУЛАЛТТАЙ. mock горимд л хэрэглэгдэнэ; real горимд POS_OTP_SECRET заавал. */
export const DEV_OTP_SECRET = 'DEV-ONLY-INSECURE-POS-OTP-SECRET--NEVER-USE-IN-PRODUCTION';
/** real/production горимд нууц түлхүүр (POS_OTP_SECRET, PII_HASH_KEY)-ийн доод урт. */
export const MIN_REAL_SECRET_LENGTH = 16;
const DEFAULT_KYC_BASE_URL = 'http://localhost:4002';

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new PosConfigError(`${name} must be a positive integer`);
  return n;
}

export function readIntegrationMode(env: Env = process.env): IntegrationMode {
  const raw = env.INTEGRATION_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'mock') return 'mock';
  if (raw === 'real') return 'real';
  throw new PosConfigError('INTEGRATION_MODE must be "mock" or "real"');
}

export function isProduction(env: Env = process.env): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === 'production';
}

/** POS-sec: production-д mock интеграцитай бодит зээл батлахыг хориглоно — модуль эхлэхгүй. */
export function assertIntegrationSafe(cfg: Pick<PosConfig, 'nodeEnv' | 'integrationMode'>): void {
  if (cfg.nodeEnv.trim().toLowerCase() === 'production' && cfg.integrationMode !== 'real') {
    throw new PosConfigError('Merchant POS: NODE_ENV=production requires INTEGRATION_MODE=real (refusing to decide real loans on mock data)');
  }
}

/**
 * KYC_BASE_URL-ийг эхлэхэд шалгана (буруу утга нь submit бүр дээр SCREENING_UNAVAILABLE болж далд үлдэхгүй).
 * Зөвхөн http/https, нэвтрэх мэдээлэл/query/fragment-гүй, зам нь `/api`-аар төгсөхгүй (adapter өөрөө `/api/inquiry/pos-screening` залгана).
 * Алдааны мессежид утгыг ҮЗҮҮЛЭХГҮЙ (URL-д нууц орсон байж болно).
 */
export function parseKycBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PosConfigError('KYC_BASE_URL must be an absolute http(s) URL, e.g. http://kyc:4002');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PosConfigError('KYC_BASE_URL must use http or https');
  if (url.username || url.password) throw new PosConfigError('KYC_BASE_URL must not contain credentials');
  if (url.search || url.hash) throw new PosConfigError('KYC_BASE_URL must not contain a query string or fragment');
  const path = url.pathname.replace(/\/+$/, '');
  if (/(^|\/)api$/i.test(path)) throw new PosConfigError('KYC_BASE_URL must not end with /api (the adapter appends /api/inquiry/pos-screening)');
  return `${url.origin}${path}`;
}

/**
 * `mode` өгвөл (MerchantModule.register-ийн сонгосон горим) env-ийн INTEGRATION_MODE-г үл тооцно: POS_CONFIG ба provider-ууд ЯГ НЭГ горимоор тохирно.
 */
export function loadPosConfig(env: Env = process.env, mode?: IntegrationMode): PosConfig {
  const integrationMode = mode ?? readIntegrationMode(env);
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const secretEnv = env.POS_OTP_SECRET?.trim();
  if (integrationMode === 'real') {
    if (!secretEnv) throw new PosConfigError('POS_OTP_SECRET is required when INTEGRATION_MODE=real');
    if (secretEnv.length < MIN_REAL_SECRET_LENGTH) throw new PosConfigError(`POS_OTP_SECRET must be at least ${MIN_REAL_SECRET_LENGTH} characters`);
  }
  const kycEnv = env.KYC_BASE_URL?.trim();
  if (integrationMode === 'real' && nodeEnv.toLowerCase() === 'production' && !kycEnv) throw new PosConfigError('KYC_BASE_URL is required in production');
  // real горимд л ашиглагдана → зөвхөн тэнд шалгана (mock-д өөр зорилгоор тавигдсан утга dev-ийг унагаахгүй)
  const kycBaseUrl = integrationMode === 'real' && kycEnv ? parseKycBaseUrl(kycEnv) : (kycEnv || DEFAULT_KYC_BASE_URL).replace(/\/+$/, '');
  const cfg: PosConfig = {
    nodeEnv,
    integrationMode,
    draftTtlMinutes: positiveInt(env, 'POS_DRAFT_TTL_MINUTES', 60),
    referralTtlHours: positiveInt(env, 'POS_REFERRAL_TTL_HOURS', 72),
    otpTtlSeconds: positiveInt(env, 'POS_OTP_TTL_SECONDS', 300),
    otpMaxAttempts: positiveInt(env, 'POS_OTP_MAX_ATTEMPTS', 3),
    otpResendSeconds: positiveInt(env, 'POS_OTP_RESEND_SECONDS', 30),
    otpMaxSends: positiveInt(env, 'POS_OTP_MAX_SENDS', 5),
    otpSecret: secretEnv || DEV_OTP_SECRET,
    kycBaseUrl,
  };
  assertIntegrationSafe(cfg);
  return cfg;
}
