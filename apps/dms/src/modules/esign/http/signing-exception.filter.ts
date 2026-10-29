// FR-11.4 Алдааг HTTP хариу болгох НЭГ цэг. Бие нь тогтвортой `{ code, message[, reason, issues] }` (message — монгол, хэрэглэгчид харуулахад аюулгүй).
// Хариуд ХЭЗЭЭ Ч орохгүй: алдааны анхны мессеж, стек, оролтын утга (регистр, утас, токен), provider/DB-ийн дэлгэрэнгүй.
// Танигдаагүй алдаа → 500 + ерөнхий хариу; лог-д зөвхөн алдааны НЭР/код, route-ийн загвар, correlation id (CLAUDE.md §6.5).
import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ZodError } from 'zod';
import {
  SigningConflictError,
  SigningFinalizationError,
  SigningGoneError,
  SigningNotFoundError,
  SigningProviderUnavailableError,
  SigningTooManyAttemptsError,
  SigningValidationError,
  SigningWebhookRejectedError,
  type SigningConflictReason,
  type SigningGoneReason,
  type SigningValidationReason,
} from '../errors';
import { applyNoStore } from './no-store';
import { loggableCorrelationId } from './request-context';

export interface ValidationIssue {
  /** Талбарын зам, жишээ `signer.registerNo`. Утга БИШ */
  path: string;
  /** zod-ийн алдааны төрөл, жишээ `too_small` */
  code: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  /** Domain алдааны нарийн шалтгаан (тогтмол enum) */
  reason?: string;
  issues?: ValidationIssue[];
}

interface Failure {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const MAX_ISSUES = 20;
const MAX_PATH_LENGTH = 100;

const MESSAGES = {
  notFound: 'Хүсэлт олдсонгүй эсвэл линк хүчингүй байна',
  tooManyAttempts: 'Гарын үсэг зурах оролдлогын дээд тоо хэтэрсэн байна',
  providerUnavailable: 'Цахим гарын үсгийн үйлчилгээ түр боломжгүй байна. Түр хүлээгээд дахин оролдоно уу',
  finalizing: 'Гарын үсгийг баталгаажуулж байна. Түр хүлээгээд дахин оролдоно уу',
  webhookRejected: 'Баталгаажуулалт амжилтгүй',
  requestInvalid: 'Хүсэлтийн өгөгдөл буруу байна',
  internal: 'Системийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу',
} as const;

const CONFLICT_MESSAGES: Record<SigningConflictReason, string> = {
  ACTIVE_EXISTS: 'Энэ гэрээнд идэвхтэй гарын үсгийн хүсэлт байна',
  INVALID_STATE: 'Хүсэлтийн одоогийн төлөвт энэ үйлдлийг хийх боломжгүй',
};

const GONE_MESSAGES: Record<SigningGoneReason, string> = {
  EXPIRED: 'Линкийн хугацаа дууссан байна',
  TERMINAL: 'Энэ хүсэлт хаагдсан тул үйлдэл хийх боломжгүй',
};

const VALIDATION_MESSAGES: Record<SigningValidationReason, string> = {
  DOCUMENT_NOT_VIEWED: 'Гарын үсэг зурахаас өмнө гэрээтэй танилцана уу',
  CONSENT_VERSION_MISMATCH: 'Гэрээний нөхцөл шинэчлэгдсэн байна. Хуудсыг дахин ачаалж, нөхцөлтэй танилцана уу',
  CONSENT_REQUIRED: 'Цахим гарын үсгийн зөвшөөрлийг өгнө үү',
  NOT_A_PDF: 'Гэрээний файл PDF биш байна',
  SOURCE_FILE_NOT_FOUND: 'Гэрээний файл олдсонгүй',
  SOURCE_FILE_HASH_MISMATCH: 'Гэрээний файлын бүрэн бүтэн байдал алдагдсан байна',
  SIGNED_FILE_HASH_MISMATCH: 'Гарын үсэгтэй файлын бүрэн бүтэн байдал алдагдсан байна',
  PROVIDER_NOT_AVAILABLE: 'Сонгосон гарын үсгийн үйлчилгээ одоогоор боломжгүй байна',
  PROVIDER_NOT_ALLOWED: 'Энэ хүсэлтэд сонгосон үйлчилгээгээр гарын үсэг зурах боломжгүй',
  INVALID_SIGNER: 'Гарын үсэг зурагчийн мэдээлэл буруу байна',
};

/** Nest/Express-ийн өөрийн 4xx (route олдоогүй, body-parser, ...) — анхны мессежийг (замын токен, биеийн хэсэг агуулж болно) дамжуулахгүй */
const HTTP_FAILURES: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: 'REQUEST_INVALID', message: MESSAGES.requestInvalid },
  401: { code: 'UNAUTHORIZED', message: 'Нэвтрэх эрхгүй байна' },
  403: { code: 'FORBIDDEN', message: 'Энэ үйлдлийг хийх эрхгүй байна' },
  404: { code: 'NOT_FOUND', message: 'Олдсонгүй' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Энэ аргыг зөвшөөрөөгүй' },
  409: { code: 'CONFLICT', message: 'Хүсэлт одоогийн төлөвтэй зөрчилдөж байна' },
  410: { code: 'GONE', message: 'Энэ нөөц байхгүй болсон' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Хүсэлтийн хэмжээ хэтэрсэн байна' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Агуулгын төрөл дэмжигдэхгүй' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу' },
};
const GENERIC_CLIENT_FAILURE = { code: 'REQUEST_REJECTED', message: 'Хүсэлтийг хүлээн авсангүй' };

const fail = (status: number, code: string, message: string, extra: Pick<ErrorBody, 'reason'> & { headers?: Record<string, string> } = {}): Failure => ({
  status,
  body: { code, message, ...(extra.reason === undefined ? {} : { reason: extra.reason }) },
  ...(extra.headers === undefined ? {} : { headers: extra.headers }),
});

/**
 * `instanceof ZodError` хангалтгүй: схемүүд `@los/contracts`-ийн zod-оор үүсдэг, тэр нь энэ апп-ын zod-той өөр хуулбар (CJS/ESM эсвэл хувилбар зөрсөн) байж болно.
 * Тиймээс нэр + `issues` массивээр таних.
 */
function isZodError(exception: unknown): exception is ZodError {
  return exception instanceof Error && exception.name === 'ZodError' && Array.isArray((exception as { issues?: unknown }).issues);
}

function describeIssues(error: ZodError): ValidationIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.join('.').replace(/[^\w.-]/g, '_').slice(0, MAX_PATH_LENGTH),
    code: issue.code,
  }));
}

/** body-parser зэрэг `http-errors` төрлийн (HttpException биш) 4xx/5xx */
function externalStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const { status, expose } = exception as { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function failureOf(exception: unknown): Failure | null {
  if (exception instanceof SigningNotFoundError) return fail(404, 'SIGNING_NOT_FOUND', MESSAGES.notFound);
  if (exception instanceof SigningConflictError) return fail(409, exception.code, CONFLICT_MESSAGES[exception.reason], { reason: exception.reason });
  if (exception instanceof SigningGoneError) return fail(410, exception.code, GONE_MESSAGES[exception.reason], { reason: exception.reason });
  if (exception instanceof SigningValidationError) return fail(400, exception.code, VALIDATION_MESSAGES[exception.reason], { reason: exception.reason });
  if (exception instanceof SigningTooManyAttemptsError) return fail(429, exception.code, MESSAGES.tooManyAttempts);
  if (exception instanceof SigningProviderUnavailableError) return fail(502, exception.code, MESSAGES.providerUnavailable);
  // Түр алдаа: webhook-д 5xx нь provider-ийг дахин илгээлгэнэ, зээлдэгчийн poll дахин оролдоно
  if (exception instanceof SigningFinalizationError) return fail(503, exception.code, MESSAGES.finalizing, { headers: { 'Retry-After': '5' } });
  if (exception instanceof SigningWebhookRejectedError) return fail(401, exception.code, MESSAGES.webhookRejected);
  if (isZodError(exception)) {
    return { status: 400, body: { code: 'REQUEST_INVALID', message: MESSAGES.requestInvalid, issues: describeIssues(exception) } };
  }
  const status = exception instanceof HttpException ? exception.getStatus() : externalStatus(exception);
  if (status !== null && status < 500) {
    const known = HTTP_FAILURES[status] ?? GENERIC_CLIENT_FAILURE;
    return fail(status, known.code, known.message);
  }
  return null;
}

function safeErrorCode(exception: unknown): string | undefined {
  const { code } = (exception ?? {}) as { code?: unknown };
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

@Catch()
export class SigningExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SigningExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const failure = failureOf(exception) ?? this.unexpected(exception, req);
    // Хариу аль хэдийн эхэлсэн (PDF stream дундуур алдаа) бол статус солих боломжгүй — холболтыг таслана
    if (res.headersSent) {
      res.destroy();
      return;
    }
    applyNoStore(res);
    for (const [name, value] of Object.entries(failure.headers ?? {})) res.setHeader(name, value);
    res.status(failure.status).json(failure.body);
  }

  /** Танигдаагүй алдаа: ЗӨВХӨН нэр/код/route-ийн загвар/correlation id лог-д. Мессеж (PII агуулж болно), стек бичигдэхгүй */
  private unexpected(exception: unknown, req: Request): Failure {
    this.logger.error(
      JSON.stringify({
        event: 'esign.http.unhandled',
        errorName: exception instanceof Error ? exception.name : typeof exception,
        errorCode: safeErrorCode(exception),
        method: req.method,
        route: typeof req.route?.path === 'string' ? req.route.path : undefined,
        correlationId: loggableCorrelationId(req),
      }),
    );
    return fail(500, 'INTERNAL_ERROR', MESSAGES.internal);
  }
}
