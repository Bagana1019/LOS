import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { IDEMPOTENCY_KEY_PATTERN, type CreateApplicationRequest } from '@los/contracts';
import { DomainError } from '@los/nest-common';

/** Нормчлох талбарууд. `null` ба `undefined` адил (талбар заагаагүй). `branchId` нь ҮР ДҮНТЭЙ салбар (ЗЭЗ-д өөрийнх нь, ADMIN-д заасан/өөрийнх нь). */
export type CreateApplicationFields = {
  [K in 'productId' | 'purpose' | 'branchId']?: CreateApplicationRequest[K] | null;
};

/**
 * `Idempotency-Key` толгой: заавал биш. Байхгүй бол `undefined` (өнөөдрийн зан төлөв). Байвал 8–128 тэмдэгт [A-Za-z0-9_-], үгүй бол 400.
 * Хоосон толгой ч (`''`) буруу: түлхүүрийг чимээгүй алгасвал давхардлаас хамгаалалт байхгүй болно.
 * Буруу утгыг алдаанд эргүүлж оруулахгүй.
 */
export function parseIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new DomainError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key буруу байна: 8–128 тэмдэгт, зөвхөн латин үсэг, тоо, "_" болон "-" ашиглана', HttpStatus.BAD_REQUEST);
  }
  return raw;
}

/**
 * Үүсгэх хүсэлтийн нормчилсон бие → sha256. Тогтмол дараалалтай массив тул талбарын дараалал, undefined/null нөлөөлөхгүй;
 * JSON массив тул утгын хил ("a,b" ≠ "a","b") төөрөлдөхгүй.
 */
export function hashCreateRequest(fields: CreateApplicationFields): string {
  const normalised = [fields.productId ?? null, fields.purpose ?? null, fields.branchId ?? null];
  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
}

/** Ижил түлхүүр өөр биетэй хүсэлтэд дахин ашиглагдсан: 422 (portal-bff-ийн IDEMPOTENCY_KEY_REUSED-тэй ижил код, статус). */
export const keyReused = (): DomainError =>
  new DomainError('IDEMPOTENCY_KEY_REUSED', 'Энэ Idempotency-Key өөр агуулгатай хүсэлтэд ашиглагдсан байна. Шинэ түлхүүр ашиглана уу.', HttpStatus.UNPROCESSABLE_ENTITY);
