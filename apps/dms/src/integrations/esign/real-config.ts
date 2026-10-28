// FR-11.4 Бодит provider (Tridum, Monpass)-ийн тохиргоог env-ээс zod-оор уншина.
// Дутуу/буруу тохиргоо → ESignProviderError('NOT_CONFIGURED'); мессеж нь ЗӨВХӨН env хувьсагчийн НЭР-ийг агуулна (утгыг хэзээ ч биш).
import { z } from 'zod';
import { ESignProviderError } from './esign-provider.port';

export type RealProviderPrefix = 'TRIDUM' | 'MONPASS';
export type RealProviderEnv = Readonly<Record<string, string | undefined>>;

export interface RealProviderConfig {
  /** Хоосон зайгүй, төгсгөлийн `/`-гүй */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

const FIELDS = [
  ['baseUrl', 'BASE_URL'],
  ['clientId', 'CLIENT_ID'],
  ['clientSecret', 'CLIENT_SECRET'],
  ['webhookSecret', 'WEBHOOK_SECRET'],
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https заавал (loopback-д dev симулятор зөвшөөрнө); URL дотор нэвтрэх мэдээлэл байж болохгүй (логоор алдагдана) */
function isAcceptableBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

const nonBlank = z.string().trim().min(1);
const configSchema = z.object({
  baseUrl: nonBlank.refine(isAcceptableBaseUrl).transform((v) => v.replace(/\/+$/, '')),
  clientId: nonBlank,
  clientSecret: nonBlank,
  webhookSecret: nonBlank,
});

export function loadRealProviderConfig(prefix: RealProviderPrefix, env: RealProviderEnv): RealProviderConfig {
  const raw = Object.fromEntries(FIELDS.map(([key, suffix]) => [key, env[`${prefix}_${suffix}`]]));
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const failed = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const [key, suffix] of FIELDS) {
    if (!failed.has(key)) continue;
    const name = `${prefix}_${suffix}`;
    (raw[key]?.trim() ? invalid : missing).push(name);
  }
  const parts = [
    missing.length ? `missing ${missing.join(', ')}` : '',
    invalid.length ? `invalid ${invalid.join(', ')} (BASE_URL must be an https URL without credentials)` : '',
  ].filter(Boolean);
  throw new ESignProviderError('NOT_CONFIGURED', `${prefix} e-sign provider is not configured: ${parts.join('; ')}`);
}

/** Real stub-ийн нийтлэг алдаа — гүйцэтгэл хийгдтэл бүх port method үүнийг шиднэ */
export function notImplemented(provider: string, method: string): ESignProviderError {
  return new ESignProviderError('NOT_IMPLEMENTED', `${provider} real adapter is not implemented yet: ${method}`);
}
