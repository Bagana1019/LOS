// Файлаас текст гаргах үеийн алдаа. Мессеж нь ХЭРЭГЛЭГЧИД харуулах аюулгүй монгол текст — файлын агуулга, нэр, OCR текст ОРОХГҮЙ (PII).
export type StatementExtractionErrorCode =
  | 'UNSUPPORTED_FILE'
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'PDF_ENCRYPTED'
  | 'PDF_CORRUPT'
  | 'PDF_NO_TEXT_LAYER'
  | 'OCR_FAILED';

export const STATEMENT_EXTRACTION_MESSAGES: Readonly<Record<StatementExtractionErrorCode, string>> = {
  UNSUPPORTED_FILE: 'Дэмжигдээгүй файл байна. PDF, зураг (PNG, JPG), CSV эсвэл текст файл оруулна уу.',
  EMPTY: 'Файл хоосон байна.',
  TOO_LARGE: 'Файл хэт том байна.',
  PDF_ENCRYPTED: 'PDF файл нууц үгээр хамгаалагдсан байна. Нууц үгийг арилгаад дахин оруулна уу.',
  PDF_CORRUPT: 'PDF файл гэмтсэн эсвэл уншигдахгүй байна. Банкнаас дахин татаж оруулна уу.',
  PDF_NO_TEXT_LAYER: 'PDF файлд уншигдах текст алга (скан зураг бололтой). Банкны системээс шууд татсан PDF хуулга оруулна уу.',
  OCR_FAILED: 'Зургаас текст таньж чадсангүй. Зураг тод, бүтэн эсэхийг шалгаад дахин оруулна уу.',
};

/** XLSX/Excel: TODO — xlsx дэмжихэд баталгаатай сан (vetted library) хэрэгтэй тул одоохондоо экспортлуулна. */
export const XLSX_UNSUPPORTED_MESSAGE = 'Excel (XLSX) файл дэмжигдэхгүй. Хуулгаа CSV эсвэл PDF хэлбэрээр татаж оруулна уу.';

export const tooLargeBytesMessage = (maxBytes: number): string =>
  `Файл хэт том байна (дээд хэмжээ ${(maxBytes / 1024 / 1024).toFixed(0)} МБ).`;
export const tooManyPagesMessage = (maxPages: number): string =>
  `PDF хуудасны тоо хэтэрсэн байна (дээд тоо ${maxPages}). Хуулгыг хэсэгчлэн хуваан оруулна уу.`;
export const OCR_INCOMPLETE_MESSAGE = 'Зургийг бүрэн унших боломжгүй байна (хуудас дутуу уншигдсан). Файлыг хэсэгчлэн хуваан оруулна уу.';

export interface StatementExtractionErrorOptions {
  /** Зөвхөн STATEMENT_EXTRACTION_MESSAGES-ийн нэмэлт хувилбар (тоо л агуулсан); файлын агуулга биш */
  message?: string;
  /** Шалтгааны богино ASCII шошго (жишээ: 'PasswordException', 'OcrError:ENGINE_FAILED') — логт аюулгүй */
  detail?: string;
}

export class StatementExtractionError extends Error {
  readonly code: StatementExtractionErrorCode;
  /** Хэрэглэгчид шууд харуулж болох монгол мессеж (= message) */
  readonly userMessage: string;
  readonly detail?: string;

  constructor(code: StatementExtractionErrorCode, options: StatementExtractionErrorOptions = {}) {
    const message = options.message ?? STATEMENT_EXTRACTION_MESSAGES[code];
    super(message);
    this.name = 'StatementExtractionError';
    this.code = code;
    this.userMessage = message;
    if (options.detail) this.detail = options.detail.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  }
}

export function isStatementExtractionError(err: unknown): err is StatementExtractionError {
  return err instanceof StatementExtractionError;
}
