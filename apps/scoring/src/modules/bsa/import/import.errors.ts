// BSA application service-ийн домэйн алдаа (HTTP-д шууд зураглагдана: HttpException) ба хэрэглэгчид харуулах монгол мессежүүд.
// АНХААР (PII): мессеж/details-д файлын нэр, регистр, данс, нэр, гүйлгээний утга ОРОХГҮЙ — зөвхөн код, тоо, id.
import { HttpException, HttpStatus } from '@nestjs/common';
import { UPLOAD_REJECT_MESSAGES, type UploadRejectCode } from './import.issues';

export type BsaErrorCode =
  | 'INVALID_REQUEST'
  | 'PERIOD_NOT_ALLOWED'
  | 'INVALID_PERIOD'
  | 'NO_FILES'
  | 'TOO_MANY_FILES'
  | 'ANALYSIS_NOT_DRAFT'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_RETRYABLE'
  | 'JOBS_IN_PROGRESS'
  | 'NO_COMPLETED_IMPORT'
  | 'NO_TRANSACTIONS'
  | 'PENDING_SUSPICIOUS_BLOCK'
  | 'NOT_ANALYZED'
  | 'CATALOG_INCOMPLETE'
  | 'AGGREGATION_FAILED'
  | 'TRANSACTION_NOT_FOUND'
  | 'CATEGORY_INVALID'
  | 'RULE_INVALID'
  | 'RULE_DUPLICATE'
  | 'QUEUE_UNAVAILABLE'
  // HTTP давхарга (import/http): zod, multipart, хураангуй
  | 'VALIDATION_FAILED'
  | 'INVALID_MULTIPART'
  | 'UNEXPECTED_FILE_FIELD'
  | 'SUMMARY_NOT_AVAILABLE'
  // Upload-ын файл бүрийн татгалзах код (бүх файл татгалзагдвал HTTP алдаа болно)
  | UploadRejectCode;

export const BSA_ERROR_MESSAGES: Readonly<Record<BsaErrorCode, string>> = {
  INVALID_REQUEST: 'Хүсэлтийн өгөгдөл буруу байна.',
  PERIOD_NOT_ALLOWED: 'Шинжилгээний хугацаа (сар) зөвшөөрөгдсөн утгуудын нэг биш байна.',
  INVALID_PERIOD: 'Шинжилгээний хугацаа буруу байна (эхлэх огноо төгсөх огнооноос хойно эсвэл огноо буруу).',
  NO_FILES: 'Хуулгын файл сонгоогүй байна.',
  TOO_MANY_FILES: 'Нэг удаад оруулах файлын тоо хэтэрсэн байна.',
  ANALYSIS_NOT_DRAFT: 'Шинжилгээ аль хэдийн дууссан (ANALYZED) тул файл оруулах, устгах боломжгүй. Шинэ хувилбар үүсгэнэ үү.',
  JOB_NOT_FOUND: 'Импорт ажил олдсонгүй.',
  JOB_NOT_RETRYABLE: 'Зөвхөн алдаатай (FAILED) импорт ажлыг дахин оруулж болно.',
  JOBS_IN_PROGRESS: 'Файл боловсруулагдаж байна. Дуустал хүлээнэ үү.',
  NO_COMPLETED_IMPORT: 'Амжилттай импортлогдсон хуулга байхгүй тул системрүү татах боломжгүй.',
  NO_TRANSACTIONS: 'Шинжилгээнд гүйлгээ байхгүй тул тооцоолох боломжгүй.',
  PENDING_SUSPICIOUS_BLOCK: 'Шийдвэрлэгдээгүй сэжигтэй гүйлгээ байгаа тул системрүү татахыг хориглосон байна.',
  NOT_ANALYZED: 'Шинжилгээ системрүү татагдаагүй (ANALYZED биш) байна.',
  CATALOG_INCOMPLETE: 'Ангиллын сан бүрэн биш байна (системийн ангилал дутуу). Админд хандана уу.',
  AGGREGATION_FAILED: 'Гүйлгээний ангилал таарахгүй байгаа тул тооцоолж чадсангүй. Ангиллыг шалгана уу.',
  TRANSACTION_NOT_FOUND: 'Сонгосон гүйлгээ шинжилгээнд олдсонгүй.',
  CATEGORY_INVALID: 'Ангилал олдсонгүй, идэвхгүй, эсвэл гүйлгээний чиглэлтэй таарахгүй байна.',
  RULE_INVALID: 'Дүрэм буруу байна.',
  RULE_DUPLICATE: 'Ижил дүрэм аль хэдийн бүртгэлтэй байна.',
  VALIDATION_FAILED: 'Хүсэлтийн талбар буруу байна.',
  INVALID_MULTIPART: 'Файл хүлээн авах хүсэлтийн хэлбэр буруу байна (multipart/form-data, талбар нь files).',
  UNEXPECTED_FILE_FIELD: 'Файлыг зөвхөн files талбараар илгээнэ үү.',
  SUMMARY_NOT_AVAILABLE: 'Шинжилгээний хураангуй хараахан тооцогдоогүй байна. Эхлээд хуулга оруулна уу.',
  // QUEUE_UNAVAILABLE, FILE_*, STORAGE_FAILED, INVALID_BANK, INTERNAL_ERROR (upload татгалзалтын мессеж)
  ...UPLOAD_REJECT_MESSAGES,
};

/** HTTP статустай домэйн алдаа. `details` нь PII-гүй (тоо, код, id) */
export class BsaException extends HttpException {
  constructor(status: HttpStatus, readonly bsaCode: BsaErrorCode, readonly details?: Record<string, unknown>, message?: string) {
    super({ statusCode: status, code: bsaCode, message: message ?? BSA_ERROR_MESSAGES[bsaCode], ...(details ? { details } : {}) }, status);
  }
}

export const badRequest = (code: BsaErrorCode, details?: Record<string, unknown>, message?: string): BsaException =>
  new BsaException(HttpStatus.BAD_REQUEST, code, details, message);
export const conflict = (code: BsaErrorCode, details?: Record<string, unknown>, message?: string): BsaException =>
  new BsaException(HttpStatus.CONFLICT, code, details, message);
export const unprocessable = (code: BsaErrorCode, details?: Record<string, unknown>, message?: string): BsaException =>
  new BsaException(HttpStatus.UNPROCESSABLE_ENTITY, code, details, message);
export const unavailable = (code: BsaErrorCode, details?: Record<string, unknown>, message?: string): BsaException =>
  new BsaException(HttpStatus.SERVICE_UNAVAILABLE, code, details, message);
export const notFound = (code: BsaErrorCode): BsaException => new BsaException(HttpStatus.NOT_FOUND, code);
