import { z } from 'zod';

// FR-11.4 gateway public e-sign proxy — тохиргоо. Зөвхөн env-ээс (DMS_URL, ESIGN_RATE_LIMIT_PER_MIN, ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN) уншина;
// бусад утга нь тогтмол бөгөөд тестэд дарж болно.

export const PROXY_CONFIG = Symbol('PROXY_CONFIG');

/** Rate limit-ийн бүлэг (route group). Хязгаар нь IP + бүлгээр тоологдоно. */
export type RateGroup = 'read' | 'poll' | 'action' | 'webhook';

export interface ProxyConfig {
  /** dms-ийн суурь URL, төгсгөлийн `/`-гүй */
  dmsBaseUrl: string;
  /** Нэг цонхонд зөвшөөрөх хүсэлтийн тоо (бүлэг бүрээр). `webhook` нь IP-ээс үл хамаарсан НИЙТ хязгаар */
  rateLimits: Readonly<Record<RateGroup, number>>;
  rateWindowMs: number;
  /** Rate limiter-ийн түлхүүрийн дээд тоо (санах ойн хязгаар) */
  rateMaxKeys: number;
  timeouts: {
    /** dms-ээс хариуны толгой ирэх хүртэл */
    headersMs: number;
    /** JSON/webhook хариуны нийт хугацаа */
    jsonTotalMs: number;
    /** PDF stream-ийн нийт хугацаа */
    pdfTotalMs: number;
  };
  bodyLimits: {
    /** POST :token/start, :token/decline */
    jsonBytes: number;
    /** POST callback/:provider */
    webhookBytes: number;
  };
}

const ACTION_LIMIT_PER_MIN = 10;

// Хоосон env (`ESIGN_RATE_LIMIT_PER_MIN=`) нь тохируулаагүйтэй адил
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const EnvSchema = z.object({
  DMS_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'DMS_URL must be http(s)')
      .default('http://localhost:4005'),
  ),
  ESIGN_RATE_LIMIT_PER_MIN: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100_000).default(60)),
  ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1_000_000).default(600)),
});

/** Env-ийг задлаад ProxyConfig үүсгэнэ. Буруу утга бол эхлэхэд алдаа заана (fail fast). */
export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid gateway proxy configuration: ${detail}`);
  }
  const { DMS_URL, ESIGN_RATE_LIMIT_PER_MIN: perMin, ESIGN_WEBHOOK_RATE_LIMIT_PER_MIN: webhookPerMin } = parsed.data;
  return {
    dmsBaseUrl: DMS_URL.replace(/\/+$/, ''),
    rateLimits: {
      read: perMin,
      poll: perMin,
      action: Math.min(ACTION_LIMIT_PER_MIN, perMin),
      webhook: webhookPerMin,
    },
    rateWindowMs: 60_000,
    rateMaxKeys: 50_000,
    timeouts: { headersMs: 15_000, jsonTotalMs: 15_000, pdfTotalMs: 120_000 },
    bodyLimits: { jsonBytes: 8 * 1024, webhookBytes: 64 * 1024 },
  };
}
