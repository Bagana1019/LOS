import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { PortalErrorBody, PortalErrorCode } from '@los/contracts';
import type { Request, Response } from 'express';
import { ERROR_CATALOG } from './error-catalog';
import { PortalError } from './portal-error';

function codeForStatus(status: number): PortalErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'INVALID_REQUEST';
  return 'INTERNAL';
}

/** Бүх алдааг нэг загвар `{ error: { code, message, correlationId } }`-оор буцаана; дотоод дэлгэрэнгүйг задруулахгүй. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    let code: PortalErrorCode;
    let status: number;
    let details: PortalError['details'];
    let headers: Record<string, string> | undefined;

    if (exception instanceof PortalError) {
      code = exception.code;
      status = ERROR_CATALOG[code].status;
      details = exception.details;
      headers = exception.headers;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = codeForStatus(status);
    } else if (isHttpLikeError(exception)) {
      // body-parser (хэт том/буруу JSON) зэрэг express-ийн алдаа
      status = exception.status ?? exception.statusCode ?? 400;
      code = codeForStatus(status);
    } else {
      code = 'INTERNAL';
      status = 500;
    }

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`[${req.correlationId}] ${req.method} ${req.path} → ${code}: ${err.message}`, err.stack);
    }

    if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');

    const body: PortalErrorBody = {
      error: {
        code,
        message: ERROR_CATALOG[code].message,
        correlationId: req.correlationId ?? 'unknown',
        ...(details?.length ? { details } : {}),
      },
    };
    res.status(status).json(body);
  }
}

function isHttpLikeError(e: unknown): e is { status?: number; statusCode?: number } {
  if (typeof e !== 'object' || e === null) return false;
  const s = (e as { status?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' && s >= 400 && s < 600;
}
