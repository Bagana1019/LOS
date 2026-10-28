import { BadRequestException, NotFoundException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { DbInputErrorInterceptor, mapDbInputError } from './db-error.interceptor';

const err = (name: string, message: string, extra: object = {}) => Object.assign(new Error(message), { name, ...extra });
const ctx = {} as ExecutionContext;
const handler = (result: () => unknown): CallHandler => ({ handle: () => { try { return of(result()); } catch (e) { return throwError(() => e); } } });

describe('mapDbInputError', () => {
  it('maps an invalid-byte-sequence (NUL) query error to 400 without leaking the DB text', () => {
    const e = mapDbInputError(err('PrismaClientUnknownRequestError', 'QueryError(PostgresError { code: "22021", message: "invalid byte sequence for encoding \\"UTF8\\": 0x00" })'));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e?.message).toBe('Invalid request value');
  });

  it('maps the raw-query form (P2010 with meta.code) and the other input sqlstates to 400', () => {
    for (const code of ['22021', '22P02', '22003', '22001']) {
      expect(mapDbInputError(err('PrismaClientKnownRequestError', 'Raw query failed', { code: 'P2010', meta: { code } }))).toBeInstanceOf(BadRequestException);
    }
  });

  it('maps a Prisma validation error (e.g. an oversized skip) to 400 and P2025 to 404', () => {
    expect(mapDbInputError(err('PrismaClientValidationError', 'Unable to fit value into a 64-bit signed integer'))).toBeInstanceOf(BadRequestException);
    expect(mapDbInputError(err('PrismaClientKnownRequestError', 'No record found', { code: 'P2025' }))).toBeInstanceOf(NotFoundException);
  });

  it('leaves everything else alone (server faults stay 500)', () => {
    expect(mapDbInputError(new Error('boom'))).toBeNull();
    expect(mapDbInputError(err('PrismaClientKnownRequestError', 'Unique constraint failed', { code: 'P2002' }))).toBeNull();
    expect(mapDbInputError(err('PrismaClientInitializationError', 'Cannot reach database'))).toBeNull();
    expect(mapDbInputError(err('PrismaClientUnknownRequestError', 'QueryError(PostgresError { code: "40001" })'))).toBeNull();
    expect(mapDbInputError('22021')).toBeNull();
    expect(mapDbInputError(null)).toBeNull();
  });
});

describe('DbInputErrorInterceptor', () => {
  const interceptor = new DbInputErrorInterceptor();

  it('passes results through and rethrows mapped / unmapped errors', async () => {
    expect(await firstValueFrom(interceptor.intercept(ctx, handler(() => 'ok')))).toBe('ok');
    const input = err('PrismaClientUnknownRequestError', 'code: "22021"');
    await expect(firstValueFrom(interceptor.intercept(ctx, handler(() => { throw input; })))).rejects.toBeInstanceOf(BadRequestException);
    const other = new Error('boom');
    await expect(firstValueFrom(interceptor.intercept(ctx, handler(() => { throw other; })))).rejects.toBe(other);
  });
});
