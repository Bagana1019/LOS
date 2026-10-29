// OCR REST-ийн техникийн тохиргоо (env). Анхдагч утгууд НЭГ газар. Буруу утга = эхлэхэд тодорхой Error.
export const OCR_HTTP_DEFAULTS = {
  /** Нэг файлын дээд хэмжээ: 10 MB */
  maxFileBytes: 10 * 1024 * 1024,
  /** Зэрэг ажиллах OCR-ийн тоо (CPU-ийн халдлагаас хамгаална) */
  maxConcurrency: 2,
  /** Дараалалд хүлээх хүсэлтийн дээд тоо; хэтэрвэл 429 */
  maxQueue: 8,
} as const;

export interface OcrHttpConfig {
  maxFileBytes: number;
  maxConcurrency: number;
  maxQueue: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function envInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} нь ${min}..${max} хоорондын бүхэл тоо байх ёстой`);
  return n;
}

export function readOcrConfig(env: Env = process.env): OcrHttpConfig {
  return {
    maxFileBytes: envInt(env, 'OCR_MAX_FILE_BYTES', OCR_HTTP_DEFAULTS.maxFileBytes, 1, 100 * 1024 * 1024),
    maxConcurrency: envInt(env, 'OCR_MAX_CONCURRENCY', OCR_HTTP_DEFAULTS.maxConcurrency, 1, 64),
    maxQueue: envInt(env, 'OCR_MAX_QUEUE', OCR_HTTP_DEFAULTS.maxQueue, 0, 1000),
  };
}
