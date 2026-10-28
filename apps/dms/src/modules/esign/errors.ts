// FR-11.4 Гарын үсгийн service-ийн алдаанууд. HTTP давхарга (`instanceof SigningError` + `code`) статус руу хөрвүүлнэ.
// Мессеж, талбарт PII ЭСВЭЛ дотоод дэлгэрэнгүй (provider-ийн хариу, файлын id, токен) ОРОХГҮЙ — public хариунд шууд гарч болно.
import type { SigningStatus } from '@los/contracts';

export type SigningErrorCode =
  | 'SIGNING_NOT_FOUND'
  | 'SIGNING_CONFLICT'
  | 'SIGNING_GONE'
  | 'SIGNING_VALIDATION'
  | 'SIGNING_TOO_MANY_ATTEMPTS'
  | 'SIGNING_PROVIDER_UNAVAILABLE'
  | 'SIGNING_FINALIZATION_FAILED'
  | 'SIGNING_WEBHOOK_REJECTED';

export abstract class SigningError extends Error {
  abstract readonly code: SigningErrorCode;
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Үл мэдэгдэх ЭСВЭЛ солигдсон (rotate) токен, үл мэдэгдэх хүсэлт/код. Хоёр тохиолдолд яг ижил — токен хүчинтэй байсан эсэхийг илтгэхгүй */
export class SigningNotFoundError extends SigningError {
  readonly code = 'SIGNING_NOT_FOUND';
  constructor() {
    super('signing request not found');
  }
}

export type SigningConflictReason = 'ACTIVE_EXISTS' | 'INVALID_STATE';

/** Нэг гэрээнд идэвхтэй хүсэлт байна (`activeRequestId`), эсвэл одоогийн төлөвт энэ үйлдэл хийх боломжгүй */
export class SigningConflictError extends SigningError {
  readonly code = 'SIGNING_CONFLICT';
  constructor(readonly reason: SigningConflictReason, readonly activeRequestId?: string) {
    super(reason === 'ACTIVE_EXISTS' ? 'an active signing request already exists for this contract' : 'operation is not allowed in the current signing state');
  }
}

export type SigningGoneReason = 'EXPIRED' | 'TERMINAL';

/** Линк үхсэн: хугацаа дууссан эсвэл төгсгөлийн төлөвт (цуцлагдсан, татгалзсан, амжилтгүй, гарын үсэг зурагдсан) */
export class SigningGoneError extends SigningError {
  readonly code = 'SIGNING_GONE';
  constructor(readonly reason: SigningGoneReason, readonly status: SigningStatus) {
    super(reason === 'EXPIRED' ? 'signing link has expired' : 'signing request is no longer open');
  }
}

export type SigningValidationReason =
  | 'DOCUMENT_NOT_VIEWED'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_VERSION_MISMATCH'
  | 'NOT_A_PDF'
  | 'SOURCE_FILE_NOT_FOUND'
  | 'SOURCE_FILE_HASH_MISMATCH'
  | 'SIGNED_FILE_HASH_MISMATCH'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'PROVIDER_NOT_ALLOWED'
  | 'INVALID_SIGNER';

export class SigningValidationError extends SigningError {
  readonly code = 'SIGNING_VALIDATION';
  constructor(readonly reason: SigningValidationReason) {
    super(`signing request validation failed: ${reason}`);
  }
}

export class SigningTooManyAttemptsError extends SigningError {
  readonly code = 'SIGNING_TOO_MANY_ATTEMPTS';
  constructor(readonly maxAttempts: number) {
    super('maximum number of signing attempts reached');
  }
}

/** Provider дуудлага амжилтгүй. Provider-ийн мессеж/код ИЛ гаргахгүй; `retryable` нь дахин оролдох утгатай эсэхийг л хэлнэ */
export class SigningProviderUnavailableError extends SigningError {
  readonly code = 'SIGNING_PROVIDER_UNAVAILABLE';
  constructor(readonly retryable: boolean) {
    super('e-signature provider is temporarily unavailable');
  }
}

/**
 * Finalization-ий түр (дэд бүтцийн) алдаа: хүсэлт IN_PROGRESS руу буцсан, дараагийн poll/webhook/sweeper дахин оролдоно.
 * Webhook-т энэ нь 5xx болж provider-ийг дахин илгээлгэнэ.
 */
export class SigningFinalizationError extends SigningError {
  readonly code = 'SIGNING_FINALIZATION_FAILED';
  constructor() {
    super('signing finalization failed temporarily and will be retried');
  }
}

/** Webhook-ийн гарын үсэг/нууц буруу (provider.parseWebhook татгалзсан) — 401 */
export class SigningWebhookRejectedError extends SigningError {
  readonly code = 'SIGNING_WEBHOOK_REJECTED';
  constructor() {
    super('webhook rejected');
  }
}
