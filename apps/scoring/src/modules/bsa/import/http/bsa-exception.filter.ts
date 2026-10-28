// Бүх алдааг нэг хэлбэрт хөрвүүлнэ (BsaApiError): { statusCode, code, message (монгол), details?, issues?, correlationId? }.
//  - Домэйн алдаа (BsaException) өөрийн статус/кодтой; NotFound / Forbidden / Unauthorized (request-context) нь Nest HttpException.
//  - Nest/multer/body-parser-ийн англи мессежийг ХЭЗЭЭ Ч дамжуулахгүй: кирилл агуулсан (бидний бичсэн) мессежийг л хадгалж, бусдыг статусын
//    тогтмол монгол мессежээр солино. Ингэснээр замын нэр, JSON задлалтын хэсэг, файлын нэр зэрэг хэрэглэгчийн оролт хариунд тусахгүй.
//  - Тодорхойгүй алдаа ⇒ 500 INTERNAL_ERROR: лог дээр зөвхөн класс/код (`describeError`), мессеж/stack-гүй (PII байж болзошгүй).
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { describeError, ImportQueueError } from '../../common/import-queue';
import { BsaRepositoryError } from '../../common/persistence';
import { resolveRequestContext } from '../../common/request-context';
import { BSA_ERROR_MESSAGES, BsaException } from '../import.errors';
import { BsaValidationException, type ValidationIssue } from './zod-validation.pipe';

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  issues?: ValidationIssue[];
  correlationId?: string;
}

interface StatusDefault {
  code: string;
  message: string;
}

const INTERNAL: StatusDefault = { code: 'INTERNAL_ERROR', message: 'Системийн алдаа гарлаа. Дахин оролдоно уу.' };

/** HTTP статус тутмын нийтлэг код ба мессеж (кирилл бус мессежийг орлуулна) */
export const STATUS_DEFAULTS: Readonly<Record<number, StatusDefault>> = {
  400: { code: 'BAD_REQUEST', message: 'Хүсэлт буруу байна.' },
  401: { code: 'UNAUTHENTICATED', message: 'Хэрэглэгч тодорхойлогдоогүй байна.' },
  403: { code: 'FORBIDDEN', message: 'Энэ үйлдлийг хийх эрх байхгүй байна.' },
  404: { code: 'NOT_FOUND', message: 'Хүссэн мэдээлэл олдсонгүй.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Энэ хүсэлтийн арга дэмжигдэхгүй.' },
  409: { code: 'CONFLICT', message: 'Хүсэлт одоогийн төлөвтэй зөрчилдөж байна.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Хүсэлтийн хэмжээ зөвшөөрөгдсөн хязгаараас хэтэрсэн байна.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Хүсэлтийн төрөл дэмжигдэхгүй байна.' },
  422: { code: 'UNPROCESSABLE', message: 'Хүсэлтийг боловсруулах боломжгүй байна.' },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.' },
  503: { code: 'SERVICE_UNAVAILABLE', message: 'Үйлчилгээ түр ашиглах боломжгүй байна. Дахин оролдоно уу.' },
};

const CYRILLIC = /[Ѐ-ӿ]/;

/** Бидний бичсэн (кирилл) мессеж эсэх. Framework-ийн англи мессеж орлогдоно */
function ownMessage(value: unknown): string | null {
  return typeof value === 'string' && CYRILLIC.test(value) && value.length <= 500 ? value : null;
}

function defaultFor(status: number): StatusDefault {
  return STATUS_DEFAULTS[status] ?? (status >= 500 ? INTERNAL : (STATUS_DEFAULTS[400] as StatusDefault));
}

function fromHttpException(e: HttpException): ErrorBody {
  const status = e.getStatus();
  const fallback = defaultFor(status);
  const response = e.getResponse();
  const raw = typeof response === 'string' ? response : (response as { message?: unknown }).message;
  return { statusCode: status, code: fallback.code, message: ownMessage(Array.isArray(raw) ? raw[0] : raw) ?? fallback.message };
}

/** http-errors хэлбэрийн (body-parser: entity.too.large г.м) HttpException БИШ алдаа */
function httpStatusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const { status, statusCode } = e as { status?: unknown; statusCode?: unknown };
  const n = typeof statusCode === 'number' ? statusCode : status;
  return typeof n === 'number' && Number.isInteger(n) && n >= 400 && n <= 599 ? n : null;
}

/** Цэвэр хөрвүүлэлт (unit тестлэнэ) */
export function toErrorBody(e: unknown): ErrorBody {
  if (e instanceof BsaValidationException) {
    return { statusCode: HttpStatus.BAD_REQUEST, code: 'VALIDATION_FAILED', message: BSA_ERROR_MESSAGES.VALIDATION_FAILED, issues: e.issues };
  }
  if (e instanceof BsaException) {
    const message = ownMessage((e.getResponse() as { message?: unknown }).message) ?? BSA_ERROR_MESSAGES[e.bsaCode];
    return { statusCode: e.getStatus(), code: e.bsaCode, message, ...(e.details ? { details: e.details } : {}) };
  }
  if (e instanceof HttpException) return fromHttpException(e);
  if (e instanceof ImportQueueError) {
    return { statusCode: HttpStatus.SERVICE_UNAVAILABLE, code: 'QUEUE_UNAVAILABLE', message: BSA_ERROR_MESSAGES.QUEUE_UNAVAILABLE };
  }
  if (e instanceof BsaRepositoryError) {
    // Service-үүд эдгээрийг өөрсдөө зураглах ёстой; үлдсэн нь аюулгүй ерөнхий хариу
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'DUPLICATE' ? 409 : 400;
    return { statusCode: status, code: defaultFor(status).code, message: defaultFor(status).message };
  }
  const status = httpStatusOf(e);
  if (status !== null) return { statusCode: status, code: defaultFor(status).code, message: defaultFor(status).message };
  return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, ...INTERNAL };
}

const SAFE_CORRELATION = /^[A-Za-z0-9_.:@-]{1,128}$/;

function correlationIdOf(req: Request): string | undefined {
  try {
    return resolveRequestContext(req).correlationId;
  } catch {
    const raw = req.headers?.['x-correlation-id'];
    return typeof raw === 'string' && SAFE_CORRELATION.test(raw.trim()) ? raw.trim() : undefined;
  }
}

@Catch()
export class BsaExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('BsaExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    // Толгой задрахгүй (401/403) үед ч correlationId үргэлж байна: gateway лог холбоход (CLAUDE.md §3.2(10))
    const correlationId = correlationIdOf(req) ?? randomUUID();
    const body: ErrorBody = { ...toErrorBody(exception), correlationId };

    // Лог: зөвхөн арга, маршрутын загвар (id-гүй), статус, код. 5xx дээр алдааны класс/код. Мессеж, stack, хүсэлтийн агуулга ОРОХГҮЙ
    const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
    if (body.statusCode >= 500) {
      this.log.error(`${req.method} ${route} -> ${body.statusCode} ${body.code} (${describeError(exception)}) correlationId=${correlationId}`);
    } else if (body.statusCode === 401 || body.statusCode === 403) {
      this.log.warn(`${req.method} ${route} -> ${body.statusCode} ${body.code} correlationId=${correlationId}`);
    }

    if (res.headersSent) {
      res.end();
      return;
    }
    res.setHeader('X-Correlation-Id', correlationId);
    res.status(body.statusCode).json(body);
  }
}
