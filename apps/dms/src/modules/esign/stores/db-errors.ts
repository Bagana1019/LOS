// DB алдааг мөрийн утга (нэр, шифрлэгдсэн талбар) агуулахгүй хэлбэрт хувиргана: Prisma/Postgres-ийн мессеж
// ("Failing row contains (...)") PII-тэй байж болох тул лог/HTTP хүртэл гарахаас өмнө энд цэвэрлэнэ (CLAUDE.md §6.5).
import { Prisma } from '.prisma/client-dms';

const {
  PrismaClientInitializationError, PrismaClientKnownRequestError, PrismaClientRustPanicError, PrismaClientUnknownRequestError, PrismaClientValidationError,
} = Prisma;

export class DbOperationError extends Error {
  constructor(readonly operation: string, readonly code: string) {
    super(`database operation failed: ${operation} (${code})`);
    this.name = 'DbOperationError';
  }
}

/**
 * Prisma-ийн алдааг (мөрийн утга агуулж болзошгүй мессежтэй) `DbOperationError(operation, код)` болгоно; код нь Prisma-ийн код (P2002 …),
 * эсвэл INIT/VALIDATION/UNKNOWN/PANIC. Анхны алдааг хадгалахгүй. Prisma-ийнх биш алдаа (өөрсдийн domain алдаа) өөрчлөгдөхгүй.
 */
export function sanitizeDbError(operation: string, error: unknown): Error {
  if (error instanceof PrismaClientKnownRequestError) return new DbOperationError(operation, error.code);
  if (error instanceof PrismaClientInitializationError) return new DbOperationError(operation, error.errorCode ?? 'INIT');
  if (error instanceof PrismaClientValidationError) return new DbOperationError(operation, 'VALIDATION');
  if (error instanceof PrismaClientUnknownRequestError) return new DbOperationError(operation, 'UNKNOWN');
  if (error instanceof PrismaClientRustPanicError) return new DbOperationError(operation, 'PANIC');
  return error instanceof Error ? error : new DbOperationError(operation, 'UNKNOWN');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** uuid багана руу өөр хэлбэрийн string өгвөл Prisma P2023 шиднэ; унших замд "олдсонгүй" гэж үзэхийн тулд урьдчилан шалгана */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
