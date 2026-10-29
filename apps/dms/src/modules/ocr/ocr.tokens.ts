// OCR модулийн DI токенууд. OCR_PROVIDER нь ocr.module.ts-ээс дахин экспортлогдоно.
export const OCR_PROVIDER = Symbol('OCR_PROVIDER');
export const OCR_CONFIG = Symbol('OCR_CONFIG');
/** Өнөөдрийн огноо авах функц (тест хуурамч цаг өгнө) */
export const OCR_CLOCK = Symbol('OCR_CLOCK');
