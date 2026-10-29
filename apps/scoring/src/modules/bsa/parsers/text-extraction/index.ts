// text-extraction-ийн нийтийн гадаргуу: BSA-ийн бусад дэд модуль (import) зөвхөн эндээс импортлоно.
export { StatementTextService } from './statement-text.service';
export { TextExtractionModule, ocrProviderFactory } from './text-extraction.module';
export type { TextExtractionModuleOptions } from './text-extraction.module';
export { OCR_PROVIDER, TEXT_EXTRACTION_OPTIONS } from './tokens';
export { TEXT_EXTRACTION_DEFAULTS, resolveTextExtractionOptions } from './text-extraction.defaults';
export { StatementExtractionError, isStatementExtractionError, STATEMENT_EXTRACTION_MESSAGES } from './errors';
export type { StatementExtractionErrorCode } from './errors';
export { detectFileKind, inspectFile } from './file-kind';
export type { FileKind, FileKindInput, FileInspection } from './file-kind';
export { ocrResultToPages, splitOcrLineCells } from './ocr-text.extractor';
export type { ExtractInput, TextExtractionOptions, TextExtractionOptionsInput } from './types';
