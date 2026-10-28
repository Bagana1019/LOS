import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import { getRequestContext } from '../context/request-context';

/** Бизнесийн алдаа: тогтвортой `code` (UI/тест үүгээр таних) + монгол `message`. */
export class DomainError extends HttpException {
  constructor(readonly code: string, message: string, status: number = HttpStatus.BAD_REQUEST, readonly details?: unknown) {
    super({ code, message, details }, status);
  }
}
export const notFound = (what: string, id?: string) => new DomainError('NOT_FOUND', `${what} олдсонгүй${id ? `: ${id}` : ''}`, HttpStatus.NOT_FOUND);
export const conflict = (code: string, message: string, details?: unknown) => new DomainError(code, message, HttpStatus.CONFLICT, details);

interface ErrorBody { code: string; message: string; details?: unknown; correlationId: string | null }
const STATUS_CODE: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 502: 'UPSTREAM_ERROR', 503: 'UNAVAILABLE', 504: 'UPSTREAM_TIMEOUT' };

/** Бүх алдааг `{ code, message, details?, correlationId }` хэлбэрт оруулна. Дотоод алдааны мэдээлэл хэрэглэгчид гарахгүй. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<{ status(c: number): { json(b: unknown): void } }>();
    const { status, body } = this.toResponse(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception), exception instanceof Error ? exception.stack : undefined);
    res.status(status).json(body);
  }

  private toResponse(e: unknown): { status: number; body: ErrorBody } {
    const correlationId = getRequestContext()?.correlationId ?? null;
    if (e instanceof ZodError) return { status: 400, body: { code: 'VALIDATION_FAILED', message: 'Оруулсан өгөгдөл буруу', details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), correlationId } };
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const raw = e.getResponse();
      const obj = typeof raw === 'string' ? { message: raw } : (raw as Record<string, unknown>);
      const message = Array.isArray(obj.message) ? obj.message.join('; ') : String(obj.message ?? e.message);
      return { status, body: { code: String(obj.code ?? STATUS_CODE[status] ?? 'ERROR'), message, ...(obj.details !== undefined ? { details: obj.details } : {}), correlationId } };
    }
    // Prisma (nest-common нь prisma-аас хамааралгүй тул нэрээр таниж байна)
    const err = e as { name?: string; code?: string; meta?: { target?: unknown } } | null;
    if (err?.name === 'PrismaClientKnownRequestError') {
      if (err.code === 'P2002') return { status: 409, body: { code: 'CONFLICT', message: 'Ийм бичлэг аль хэдийн байна', details: { target: err.meta?.target }, correlationId } };
      if (err.code === 'P2025') return { status: 404, body: { code: 'NOT_FOUND', message: 'Бичлэг олдсонгүй', correlationId } };
    }
    return { status: 500, body: { code: 'INTERNAL', message: 'Системийн алдаа гарлаа', correlationId } };
  }
}
