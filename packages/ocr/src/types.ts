// @los/ocr — OCR adapter-ийн гэрээ. Гадаад OCR хөдөлгүүр (Tesseract, дараа нь cloud) зөвхөн энэ interface-ээр орно.
// CLAUDE.md §3.2(7): interface + MockXxx + RealXxx, `INTEGRATION_MODE` env-ээр солино; mock нь deterministic fixture буцаана.

export type OcrErrorCode =
  | 'UNSUPPORTED_MIME'
  | 'INVALID_INPUT'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_FAILED'
  | 'TIMEOUT'
  | 'EMPTY_RESULT'
  | 'NO_FIXTURE';

export class OcrError extends Error {
  constructor(public readonly code: OcrErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'OcrError';
  }
}

export interface OcrInput {
  content: Buffer;
  /** image/png | image/jpeg | image/tiff | image/webp | application/pdf */
  mimeType: string;
  fileName?: string;
  /** Tesseract хэлний кодууд; анхдагч ['mon', 'eng'] (NFR-9: кирилл/латин холимог) */
  languages?: string[];
  timeoutMs?: number;
}

/** Пиксел дэх хайрцаг (хуудасны растер зурагтай харьцангуй) */
export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  /** 0..1 */
  confidence: number;
  box: OcrBox;
}

export interface OcrLine {
  text: string;
  /** 0..1 */
  confidence: number;
  box: OcrBox;
  words: OcrWord[];
}

export interface OcrPage {
  pageNo: number; // 1-based
  width: number;
  height: number;
  text: string;
  lines: OcrLine[];
  /** 0..1 */
  meanConfidence: number;
}

export interface OcrResult {
  engine: string;
  engineVersion: string | null;
  languages: string[];
  pages: OcrPage[];
  /** Бүх хуудасны текст, хуудас хоорондоо '\n\f' */
  text: string;
  /** 0..1 */
  meanConfidence: number;
  durationMs: number;
  /**
   * Дутуу боловсруулсан гэх мэт анхааруулга (жишээ: PDF хуудасны хязгаараас хэтэрсэн тул эхний N хуудсыг л уншсан).
   * Баримтын текст ОРОХГҮЙ (PII). Нэмэлт талбар — хуучин хэрэглэгчдэд нөлөөлөхгүй.
   */
  warnings?: string[];
}

export interface OcrProvider {
  readonly name: string;
  recognize(input: OcrInput): Promise<OcrResult>;
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}

/** Дэмжигдэх MIME-ууд */
export const OCR_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/tiff', 'image/webp'] as const;
export const OCR_PDF_MIME_TYPE = 'application/pdf';
