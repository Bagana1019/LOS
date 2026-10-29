// DI токенууд. OCR_PROVIDER нь index.ts-ээс дахин экспортлогдоно.
/** @los/ocr-ийн OcrProvider (mock | tesseract). Зураг болон (ocrFallback үед) text layer-гүй PDF-д. */
export const OCR_PROVIDER = Symbol('OCR_PROVIDER');
/** Хэсэгчилсэн TextExtractionOptionsInput — заавал биш; байхгүй бол TEXT_EXTRACTION_DEFAULTS */
export const TEXT_EXTRACTION_OPTIONS = Symbol('TEXT_EXTRACTION_OPTIONS');
