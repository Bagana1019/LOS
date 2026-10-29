import type { MerchantErrorCode } from '@los/contracts';

// Бүх домэйн алдаа нэг төрөлтэй — exception filter `{ code, message, details }` болгож HTTP status-тай буцаана.
export const ERROR_STATUS: Record<MerchantErrorCode, number> = {
  VALIDATION_FAILED: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  MERCHANT_NOT_ACTIVE: 409, STORE_NOT_ACTIVE: 409, STORE_SCOPE_VIOLATION: 403,
  PLAN_NOT_AVAILABLE: 422, GOODS_CATEGORY_NOT_ALLOWED: 422, TERM_NOT_ALLOWED: 422, AMOUNT_OUT_OF_RANGE: 422, DOWN_PAYMENT_TOO_LOW: 422, DOWN_PAYMENT_TOO_HIGH: 422,
  TICKET_LIMIT_EXCEEDED: 422, DAILY_LIMIT_EXCEEDED: 409, INVALID_TRANSITION: 409, CONCURRENT_UPDATE: 409, OFFER_EXPIRED: 409,
  OTP_INVALID: 422, OTP_EXPIRED: 422, OTP_ATTEMPTS_EXCEEDED: 429, OTP_RESEND_TOO_SOON: 429, OTP_NOT_REQUESTED: 409, CONSENT_REQUIRED: 409,
  SCREENING_UNAVAILABLE: 503, SMS_UNAVAILABLE: 503, DUPLICATE_CODE: 409, IDEMPOTENCY_CONFLICT: 409,
};

export class DomainError extends Error {
  readonly status: number;
  constructor(readonly code: MerchantErrorCode, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'DomainError';
    this.status = ERROR_STATUS[code];
  }
}

/** Repository түвшний unique зөрчил (service барьж дахин оролдоно / өмнөх мөрийг буцаана). */
export class LeaseKeyConflict extends Error {
  constructor(readonly kind: 'IDEMPOTENCY' | 'LEASE_NO') {
    super(`pos_lease unique conflict: ${kind}`);
    this.name = 'LeaseKeyConflict';
  }
}
