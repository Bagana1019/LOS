import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { MerchantErrorCode } from '@los/contracts';
import { ZodError } from 'zod';
import { DomainError } from '../domain/errors';
import type { HttpRequest, HttpResponse } from './http.types';
import { scrubPii } from './masking';
import { toIssues } from './zod.pipe';

const HTTP_CODE: Record<number, MerchantErrorCode> = { 400: 'VALIDATION_FAILED', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND' };
const HTTP_MESSAGE: Record<number, string> = { 400: 'Bad request', 401: 'Authentication required', 403: 'Forbidden', 404: 'Not found' };

/**
 * Бүх алдааг `{ code, message, details? }` (MerchantErrorBody) болгоно (docs/05 §8).
 * Үл мэдэгдэх алдаа → 500 `{ code: 'INTERNAL' }` — мессеж/PII-г хэзээ ч гадагш гаргахгүй, зөвхөн correlation id-тай логлоно.
 */
@Catch()
export class MerchantExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('MerchantApi');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<HttpResponse>();
    const req = http.getRequest<HttpRequest>();
    const correlationId = req.ctx?.correlationId ?? '-';

    if (exception instanceof DomainError) {
      if (exception.status >= 500) this.logger.warn(`[${correlationId}] ${exception.code}`);
      res.status(exception.status).json({ code: exception.code, message: exception.message, ...(exception.details ? { details: exception.details } : {}) });
      return;
    }
    if (exception instanceof ZodError) {
      res.status(400).json({ code: 'VALIDATION_FAILED', message: 'Validation failed', details: { issues: toIssues(exception.issues) } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status < 500) {
        res.status(status).json({ code: HTTP_CODE[status] ?? 'VALIDATION_FAILED', message: HTTP_MESSAGE[status] ?? 'Request rejected' });
        return;
      }
    }
    const err = exception instanceof Error ? exception : new Error('non-error thrown');
    this.logger.error(`[${correlationId}] unhandled ${err.name}: ${scrubPii(err.message)}`);
    res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
  }
}
