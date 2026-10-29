// OCR provider-ийн factory — CLAUDE.md §3.2(7): `INTEGRATION_MODE` (mock | real) env-ээр солино. Тохиргооны алдаа = Error (эхлэхэд унана).
//   INTEGRATION_MODE   mock (анхдагч, тохируулаагүй үед) | real
//   OCR_ENGINE         real үед хөдөлгүүр (анхдагч 'tesseract'); үл мэдэгдэх → Error
//   TESSERACT_BIN, PDFTOPPM_BIN, OCR_LANGUAGES (mon+eng), OCR_PSM, OCR_DPI, OCR_TIMEOUT_MS, OCR_MAX_PAGES, OCR_MAX_INPUT_BYTES
// Шинэ хөдөлгүүр нэмэх: OCR_ENGINES-д нэр → (env) => OcrProvider нэмнэ (packages/ocr/README.md).
import { OCR_DEFAULTS } from './defaults';
import { parseLanguagesEnv } from './providers/languages';
import { MockOcrProvider } from './providers/mock.provider';
import { TesseractOcrProvider } from './providers/tesseract.provider';
import type { OcrProvider } from './types';

type Env = Readonly<Record<string, string | undefined>>;

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

function envInt(env: Env, name: string, min: number, max: number): number | undefined {
  const raw = env[name];
  if (blank(raw)) return undefined;
  const n = Number((raw as string).trim());
  if (!/^\d+$/.test((raw as string).trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} нь ${min}..${max} хоорондын бүхэл тоо байх ёстой`);
  }
  return n;
}

function envBin(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  if (blank(raw)) return fallback;
  const v = (raw as string).trim();
  if (v.includes('\0') || /^-/.test(v)) throw new Error(`${name} буруу`);
  return v;
}

/** Tesseract provider-ийг env-ээс бүтээнэ (тусад нь тестлэх боломжтой). */
export function createTesseractProviderFromEnv(env: Env): TesseractOcrProvider {
  return new TesseractOcrProvider({
    tesseractBin: envBin(env, 'TESSERACT_BIN', OCR_DEFAULTS.tesseractBin),
    pdftoppmBin: envBin(env, 'PDFTOPPM_BIN', OCR_DEFAULTS.pdftoppmBin),
    languages: blank(env.OCR_LANGUAGES) ? undefined : parseLanguagesEnv((env.OCR_LANGUAGES as string).trim()),
    psm: envInt(env, 'OCR_PSM', 0, 13),
    dpi: envInt(env, 'OCR_DPI', 70, 2400),
    timeoutMs: envInt(env, 'OCR_TIMEOUT_MS', 1, 600_000),
    maxPages: envInt(env, 'OCR_MAX_PAGES', 1, 500),
    maxInputBytes: envInt(env, 'OCR_MAX_INPUT_BYTES', 1, 1024 * 1024 * 1024),
  });
}

/** Хөдөлгүүрийн бүртгэл (INTEGRATION_MODE=real үед OCR_ENGINE-ээр сонгогдоно). */
export const OCR_ENGINES: Readonly<Record<string, (env: Env) => OcrProvider>> = {
  tesseract: createTesseractProviderFromEnv,
};

export function createOcrProvider(env: Env = process.env): OcrProvider {
  const mode = blank(env.INTEGRATION_MODE) ? 'mock' : (env.INTEGRATION_MODE as string).trim().toLowerCase();
  if (mode === 'mock') return new MockOcrProvider();
  if (mode !== 'real') throw new Error("INTEGRATION_MODE нь 'mock' эсвэл 'real' байх ёстой");
  const engine = blank(env.OCR_ENGINE) ? 'tesseract' : (env.OCR_ENGINE as string).trim().toLowerCase();
  const build = Object.prototype.hasOwnProperty.call(OCR_ENGINES, engine) ? OCR_ENGINES[engine] : undefined;
  if (!build) throw new Error(`OCR_ENGINE='${engine.slice(0, 32)}' дэмжигдэхгүй (боломжит: ${Object.keys(OCR_ENGINES).join(', ')})`);
  return build(env);
}
