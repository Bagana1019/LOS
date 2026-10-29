import { describe, expect, it } from 'vitest';
import {
  SigningConflictError, SigningError, SigningFinalizationError, SigningGoneError, SigningNotFoundError, SigningProviderUnavailableError, SigningTooManyAttemptsError,
  SigningValidationError, SigningWebhookRejectedError,
} from './errors';

describe('signing errors', () => {
  const cases: Array<[SigningError, string, string]> = [
    [new SigningNotFoundError(), 'SigningNotFoundError', 'SIGNING_NOT_FOUND'],
    [new SigningConflictError('ACTIVE_EXISTS', 'req-1'), 'SigningConflictError', 'SIGNING_CONFLICT'],
    [new SigningConflictError('INVALID_STATE'), 'SigningConflictError', 'SIGNING_CONFLICT'],
    [new SigningGoneError('EXPIRED', 'EXPIRED'), 'SigningGoneError', 'SIGNING_GONE'],
    [new SigningGoneError('TERMINAL', 'CANCELLED'), 'SigningGoneError', 'SIGNING_GONE'],
    [new SigningValidationError('NOT_A_PDF'), 'SigningValidationError', 'SIGNING_VALIDATION'],
    [new SigningTooManyAttemptsError(3), 'SigningTooManyAttemptsError', 'SIGNING_TOO_MANY_ATTEMPTS'],
    [new SigningProviderUnavailableError(true), 'SigningProviderUnavailableError', 'SIGNING_PROVIDER_UNAVAILABLE'],
    [new SigningFinalizationError(), 'SigningFinalizationError', 'SIGNING_FINALIZATION_FAILED'],
    [new SigningWebhookRejectedError(), 'SigningWebhookRejectedError', 'SIGNING_WEBHOOK_REJECTED'],
  ];

  it.each(cases)('%o: SigningError ба Error, нэр/код тогтмол', (error, name, code) => {
    expect(error).toBeInstanceOf(SigningError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.stack).toBeTruthy();
  });

  it('төрөл бүр өөр класс — instanceof-оор ялгагдана', () => {
    expect(new SigningNotFoundError()).not.toBeInstanceOf(SigningConflictError);
    expect(new SigningGoneError('EXPIRED', 'EXPIRED')).not.toBeInstanceOf(SigningNotFoundError);
  });

  it('SigningNotFoundError бүх тохиолдолд ижил (токен солигдсон эсэхийг илтгэхгүй)', () => {
    expect(new SigningNotFoundError()).toEqual(new SigningNotFoundError());
    expect(new SigningNotFoundError().message).toBe('signing request not found');
  });

  it('талбарууд: conflict.reason/activeRequestId, gone.reason/status, validation.reason, tooManyAttempts.maxAttempts, providerUnavailable.retryable', () => {
    expect(new SigningConflictError('ACTIVE_EXISTS', 'req-1')).toMatchObject({ reason: 'ACTIVE_EXISTS', activeRequestId: 'req-1' });
    expect(new SigningConflictError('INVALID_STATE').activeRequestId).toBeUndefined();
    expect(new SigningGoneError('TERMINAL', 'DECLINED')).toMatchObject({ reason: 'TERMINAL', status: 'DECLINED' });
    expect(new SigningValidationError('DOCUMENT_NOT_VIEWED')).toMatchObject({ reason: 'DOCUMENT_NOT_VIEWED' });
    expect(new SigningTooManyAttemptsError(3).maxAttempts).toBe(3);
    expect(new SigningProviderUnavailableError(false).retryable).toBe(false);
  });

  it('мессеж статик/код хэлбэртэй: тусгай мэдээлэл (id, PII) орохгүй', () => {
    expect(new SigningConflictError('ACTIVE_EXISTS', 'req-secret-id').message).not.toContain('req-secret-id');
    expect(new SigningGoneError('TERMINAL', 'CANCELLED').message).not.toContain('CANCELLED');
    expect(new SigningValidationError('CONSENT_REQUIRED').message).toBe('signing request validation failed: CONSENT_REQUIRED');
    expect(new SigningProviderUnavailableError(true).message).toBe('e-signature provider is temporarily unavailable');
  });
});
