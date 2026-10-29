import {
  BadRequestException, type CallHandler, type ExecutionContext, type HttpException, Injectable, type NestInterceptor, NotFoundException,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';

// Хэрэглэгчийн оролтоос үүдэлтэй DB алдаа (зөвхөн sqlstate): 22021 invalid byte sequence (NUL), 22P02 invalid text representation,
// 22003 numeric out of range, 22001 string too long.
const INPUT_SQLSTATES = new Set(['22021', '22P02', '22003', '22001']);

interface PrismaLikeError { name?: unknown; code?: unknown; message?: unknown; meta?: { code?: unknown } | null }

/**
 * Prisma / DB алдааг 400 эсвэл 404 болгоно (хэзээ ч 500 биш): буруу оролт (NUL, хэт том тоо) → 400, олдсонгүй (P2025) → 404.
 * Бусад алдаа null (дуудагч дамжуулна). Хариуны мессеж тогтмол — DB-ийн дотоод текст / оролтын утга алдагдахгүй.
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
