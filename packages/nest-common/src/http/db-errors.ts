// Prisma/DB алдааг HTTP хариу болгох НЭГ газар (M8): transient → 503 DB_UNAVAILABLE (AllExceptionsFilter), хэрэглэгчийн оролтын
// DB алдаа → 400/404 (kyc AML-аас нийтлэг болгосон). Prisma-аас хамааралгүй: алдааг нэр/кодоор таниулна.
import {
  BadRequestException, type CallHandler, type ExecutionContext, type HttpException, Injectable, type NestInterceptor, NotFoundException,
} from '@nestjs/common';
import { isTransientDbError } from '@los/database';
import { catchError, throwError, type Observable } from 'rxjs';

export const DB_UNAVAILABLE = 'DB_UNAVAILABLE';
export const DB_UNAVAILABLE_MESSAGE = 'Мэдээллийн сан түр ажиллахгүй байна. Түр хүлээгээд дахин оролдоно уу';
/** Клиент/gateway хэдэн секундийн дараа дахин оролдох (DB restart ихэвчлэн хэдхэн секунд). */
export const DB_RETRY_AFTER_SECONDS = 5;

export { isTransientDbError };

// Хэрэглэгчийн оролтоос үүдэлтэй DB алдаа (зөвхөн sqlstate): 22021 invalid byte sequence (NUL), 22P02 invalid text representation,
// 22003 numeric out of range, 22001 string too long.
const INPUT_SQLSTATES = new Set(['22021', '22P02', '22003', '22001']);

interface PrismaLikeError { name?: unknown; code?: unknown; message?: unknown; meta?: { code?: unknown } | null }

/**
 * Prisma / DB алдааг 400 эсвэл 404 болгоно (хэзээ ч 500 биш): буруу оролт (NUL, хэт том тоо) → 400, олдсонгүй (P2025) → 404.
 * Бусад алдаа (transient холболтын алдаа орно — 503-ийг AllExceptionsFilter өгнө) null (дуудагч дамжуулна). Мессеж тогтмол.
 */
export function mapDbInputError(error: unknown): HttpException | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as PrismaLikeError;
  const name = typeof e.name === 'string' ? e.name : '';
  if (!name.startsWith('PrismaClient')) return null;
  if (name === 'PrismaClientValidationError') return new BadRequestException('Invalid request value');
  if (e.code === 'P2025') return new NotFoundException('Record not found');
  const message = typeof e.message === 'string' ? e.message : '';
  const sqlstate = typeof e.meta?.code === 'string' ? e.meta.code : /code: "([0-9A-Z]{5})"/.exec(message)?.[1];
  if (sqlstate && INPUT_SQLSTATES.has(sqlstate)) return new BadRequestException('Invalid request value');
  return null;
}

@Injectable()
export class DbInputErrorInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => mapDbInputError(error) ?? error)));
  }
}
