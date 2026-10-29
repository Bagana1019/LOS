export * from './types';
export * from './text';
export { OCR_DEFAULTS, OCR_LANGUAGE_CODE_RE } from './defaults';
export { detectOcrMime, normalizeOcrMime, OCR_MIME_EXTENSIONS } from './mime';
export type { OcrSupportedMime } from './mime';
export { MockOcrProvider, MOCK_ENGINE_NAME } from './providers/mock.provider';
export type { MockOcrProviderOptions } from './providers/mock.provider';
export { layoutTextToPages, MOCK_LAYOUT_DEFAULTS } from './providers/mock.layout';
export { assembleOcrResult, ocrResultFromText } from './providers/result';
export type { MockConfidence, MockLayoutOptions } from './providers/mock.layout';
export {
  buildSyntheticStatementText,
  FIXTURE_ID_CARD_TEXT,
  FIXTURE_SALARY_CERTIFICATE_TEXT,
  SYNTHETIC_IBAN,
  SYNTHETIC_OWN_IBAN,
  SYNTHETIC_REGISTER_NO,
} from './providers/mock.fixtures';
export { TesseractOcrProvider, scrubDiagnostic } from './providers/tesseract.provider';
export type { TesseractOcrProviderOptions } from './providers/tesseract.provider';
export { parseTesseractTsv } from './providers/tesseract.tsv';
export { spawnRunner } from './providers/runner';
export type { CommandRunner, RunOptions, RunResult } from './providers/runner';
export { createOcrProvider, createTesseractProviderFromEnv, OCR_ENGINES } from './factory';
export * from './extract';
export { OcrDocumentService } from './ocr-document.service';
export type { AnalyzeInput, AnalyzeResult } from './ocr-document.service';
