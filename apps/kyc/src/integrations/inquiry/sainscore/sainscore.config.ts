// SainScore (ЗМС) тохиргоо: env → config. Нууц (SAINSCORE_PASSWORD_HASH = vendor-ийн convert-hash-map-ээр гаргасан hash) код, лог, тестэд орохгүй.
import { IntegrationNotConfiguredError } from '../../errors';
import { assertRealIntegrationEnv, isProduction, requireEnv } from '../../integration-env';
import { resolveIntegrationMode } from '../../integration-mode';
import { DEFAULT_CIB_POLICY, type CibPolicy } from './cib.mapper';

type Env = Record<string, string | undefined>;

/** Production + real үед БҮГД заавал (bootstrap-д шалгана). SAINSCORE_PRODUCT_NO = vendor-ийн лавлагааны хураамжийн бүтээгдэхүүний дугаар (Python: Polaris product id). */
export const SAINSCORE_REQUIRED_ENV = ['SAINSCORE_BASE_URL', 'SAINSCORE_USERNAME', 'SAINSCORE_PASSWORD_HASH', 'SAINSCORE_PRODUCT_NO'] as const;

const POLICY_ENV: Record<keyof CibPolicy, string> = {
  assumedMonthlyRatePct: 'SAINSCORE_ASSUMED_MONTHLY_RATE_PCT',
  largeLoanMonthlyRatePct: 'SAINSCORE_ASSUMED_MONTHLY_RATE_LARGE_PCT',
  largeLoanThresholdMnt: 'SAINSCORE_LARGE_LOAN_THRESHOLD_MNT',
};

export interface SainScoreConfig {
  baseUrl: string;
  username: string;
  passwordHash: string;
  productNo: string;
  policy: CibPolicy;
}

/** Хоосон бол анхдагч; тэгээс их төгсгөлөг тоо биш бол "(invalid)" гэж нэрийг л заана (утгыг дурдахгүй). */
function loadPolicy(env: Env): CibPolicy {
  const invalid: string[] = [];
  const read = (key: keyof CibPolicy): number => {
    const raw = env[POLICY_ENV[key]];
    if (raw === undefined || raw.trim() === '') return DEFAULT_CIB_POLICY[key];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { invalid.push(`${POLICY_ENV[key]} (invalid)`); return DEFAULT_CIB_POLICY[key]; }
    return n;
  };
  const policy: CibPolicy = { assumedMonthlyRatePct: read('assumedMonthlyRatePct'), largeLoanMonthlyRatePct: read('largeLoanMonthlyRatePct'), largeLoanThresholdMnt: read('largeLoanThresholdMnt') };
  if (invalid.length) throw new IntegrationNotConfiguredError('sainscore', invalid);
  return policy;
}

export function loadSainScoreConfig(env: Env = process.env): SainScoreConfig {
  const e = requireEnv('sainscore', SAINSCORE_REQUIRED_ENV, env);
  return {
    baseUrl: e.SAINSCORE_BASE_URL!.trim().replace(/\/+$/, ''), username: e.SAINSCORE_USERNAME!, passwordHash: e.SAINSCORE_PASSWORD_HASH!,
    productNo: e.SAINSCORE_PRODUCT_NO!, policy: loadPolicy(env),
  };
}

/**
 * Phase 5: production + real → env бүрэн, политикийн утга зөв, SAINSCORE_BASE_URL нь https (нууц hash, регистр, утас, имэйл http-ээр явахгүй).
 * Алдаа зөвхөн хувьсагчийн нэрийг заана. Production биш / mock үед юу ч хийхгүй.
 */
export function assertSainScoreProductionConfig(env: Env = process.env): void {
  assertRealIntegrationEnv('sainscore', SAINSCORE_REQUIRED_ENV, env);
  if (!isProduction(env) || resolveIntegrationMode(env) !== 'real') return;
  loadPolicy(env);
  let url: URL;
  try { url = new URL((env.SAINSCORE_BASE_URL as string).trim()); } catch { throw new Error('SAINSCORE_BASE_URL is not a valid URL. Refusing to start'); }
  if (url.protocol !== 'https:') throw new Error('SAINSCORE_BASE_URL must use https in production. Refusing to start');
}
