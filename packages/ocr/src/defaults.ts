// @los/ocr-ийн анхдагч утгууд — НЭГ газар (CLAUDE.md §6.2: hardcode хийхгүй). `createOcrProvider(env)` env-ээр дарна.
// Бизнесийн босго БИШ — хөдөлгүүрийн техникийн хязгаар (хэмжээ, хугацаа, хуудас).

export const OCR_DEFAULTS = {
  /** NFR-9: кирилл/латин холимог */
  languages: ['mon', 'eng'] as readonly string[],
  /** tesseract --psm: 6 = нэг жигд текстийн блок */
  psm: 6,
  dpi: 300,
  timeoutMs: 60_000,
  /** PDF/олон хуудаст TIFF-ийн боловсруулах хуудасны дээд тоо */
  maxPages: 20,
  /** Оролтын файлын дээд хэмжээ (20 MB) */
  maxInputBytes: 20 * 1024 * 1024,
  /** Дэд процессын stdout-ийн дээд хэмжээ (TSV) — хэтэрвэл процессыг зогсооно */
  maxStdoutBytes: 16 * 1024 * 1024,
  /** stderr-ээс хадгалах дээд хэмжээ (зөвхөн оношилгоо; текст хэзээ ч гадагш гарахгүй) */
  maxStderrBytes: 8 * 1024,
  tesseractBin: 'tesseract',
  pdftoppmBin: 'pdftoppm',
  /** Mock-ийн тогтмол итгэл */
  mockConfidence: 0.99,
} as const;

/** Tesseract хэлний код: argument injection-ээс сэргийлж хатуу шалгана (`-` эхэлсэн, зай, `/` зөвшөөрөхгүй). */
export const OCR_LANGUAGE_CODE_RE = /^[a-z_]{3,12}$/;
export const OCR_MAX_LANGUAGES = 6;
